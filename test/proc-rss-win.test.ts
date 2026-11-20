import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import * as rss from '../scripts/lib/proc-rss.mjs';

// B6: these tests were written before the Windows sampler had run on Windows (it has since run on the emulated, GitHub-hosted VM of the bench-windows workflow, never on a laptop). They pin the shape of the Get-CimInstance JSON
// (recorded by hand from the documented property names), the commit figure (PrivatePageCount, bytes) next to the working set, UTF-8 output, null
// command lines, and the sampler's own tick count and median interval. What the runs showed and did not show is in dockit/scripts/win/README.md.

const DIR = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\chrome-profile-abc123';
const CHROME = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"';
const row = (pid: number, ppid: number, ws: number, commit: number | null, cmd: string | null) => ({
  ProcessId: pid,
  ParentProcessId: ppid,
  WorkingSetSize: ws,
  PrivatePageCount: commit,
  CommandLine: cmd,
});
const LIST = [
  row(4, 0, 140_000, 0, null),
  row(
    7000,
    100,
    150_000_000,
    200_000_000,
    `${CHROME} --user-data-dir=${DIR} --remote-debugging-port=0`,
  ),
  row(7001, 7000, 90_000_000, 120_000_000, `${CHROME} --type=gpu-process --user-data-dir=${DIR}`),
  row(
    7002,
    7000,
    800_000_000,
    2_400_000_000,
    `${CHROME} --type=renderer --user-data-dir=${DIR} --lang=en-US`,
  ),
  row(7003, 7002, 5_000_000, 9_000_000, null), // a child whose command line could not be read
  row(
    8000,
    100,
    600_000_000,
    900_000_000,
    `${CHROME} --user-data-dir=C:\\Temp\\chrome-profile-OTHER`,
  ),
  row(9000, 100, 1_000_000, null, null), // a process with neither a command line nor a commit figure
];
const line = (list = LIST) => JSON.stringify(list);

describe('parseWin: commit size next to working set', () => {
  it('reads PrivatePageCount as commitBytes and WorkingSetSize as rssBytes, and a missing figure as 0', () => {
    const p = rss.parseWin(line());
    expect(p).toHaveLength(7);
    expect(p[1]).toMatchObject({
      pid: 7000,
      ppid: 100,
      rssBytes: 150_000_000,
      commitBytes: 200_000_000,
    });
    expect(p[6]).toMatchObject({ pid: 9000, commitBytes: 0 });
  });

  it('keeps rssBytes for a record without PrivatePageCount (an older recording), with commitBytes 0', () => {
    const p = rss.parseWin(
      JSON.stringify({ ProcessId: 1, ParentProcessId: 0, WorkingSetSize: 5, CommandLine: 'x' }),
    );
    expect(p[0]).toMatchObject({ rssBytes: 5, commitBytes: 0 });
  });

  it('skips a null CommandLine as a match (it cannot name the profile) but keeps it as a descendant of a matched process', () => {
    const p = rss.parseWin(line());
    expect(p[0]!.command).toBe('');
    expect(rss.sumTreeRss(p, DIR)).toBe(150_000_000 + 90_000_000 + 800_000_000 + 5_000_000);
    // a null-command process that is nobody's descendant is never counted, and an empty profile path matches nothing
    expect(rss.sumTreeRss(p, 'C:\\nowhere')).toBe(0);
    expect(rss.sumTreeRss(p, '')).toBe(0);
  });

  it('the Chrome-only commit sum: the same tree, the PrivatePageCount field', () => {
    const p = rss.parseWin(line());
    expect(rss.sumTreeRss(p, DIR, 'commitBytes')).toBe(
      200_000_000 + 120_000_000 + 2_400_000_000 + 9_000_000,
    );
  });

  it('strips a UTF-8 byte-order mark and keeps non-ASCII text in a command line (UTF-8 output, never the console code page)', () => {
    const user = 'Zo\u00eb \u0928\u092e\u0938\u094d\u0924\u0947';
    const dir = `C:\\Users\\${user}\\AppData\\Local\\Temp\\chrome-profile-xyz`;
    const p = rss.parseWin(
      `\uFEFF${line([row(1, 0, 10, 20, `${CHROME} --user-data-dir=${dir}`)])}`,
    );
    expect(p).toHaveLength(1);
    expect(p[0]!.command).toContain(user);
    expect(rss.sumTreeRss(p, dir)).toBe(10);
  });

  it('refuses garbage and an empty line without throwing', () => {
    expect(rss.parseWin('')).toEqual([]);
    expect(rss.parseWin('Get-CimInstance : Access denied')).toEqual([]);
    expect(rss.parseWin('\uFEFF')).toEqual([]);
  });
});

describe('winCommand: the one long-running Windows PowerShell child', () => {
  const script = rss.winCommand(500).args.join(' ');
  it('selects PrivatePageCount as well as WorkingSetSize, one compressed JSON array per line, every 500 ms', () => {
    expect(rss.winCommand(500).cmd).toBe('powershell.exe');
    for (const s of [
      'Get-CimInstance Win32_Process',
      'WorkingSetSize',
      'PrivatePageCount',
      'ParentProcessId',
      'CommandLine',
      'ConvertTo-Json -Compress',
      'Start-Sleep -Milliseconds 500',
    ])
      expect(script, s).toContain(s);
  });
  it('writes UTF-8 without a byte-order mark', () => {
    expect(script).toContain('[Console]::OutputEncoding');
    expect(script).toContain('UTF8Encoding $false');
  });
  it('takes the interval as an argument and uses no network or install command', () => {
    expect(rss.winCommand(250).args.join(' ')).toContain('Start-Sleep -Milliseconds 250');
    expect(script).not.toMatch(/Invoke-WebRequest|curl|wget|Install-|DownloadString/u);
  });
});

describe('the sample tracker: peaks, ticks and the median interval', () => {
  it('keeps the peak of each figure, counts the ticks and reports the median interval between them', () => {
    const t = rss.createSampleTracker();
    t.add({ rss: 100, commit: 300 }, 1_000);
    t.add({ rss: 400, commit: 200 }, 1_500);
    t.add({ rss: 250, commit: 900 }, 2_100);
    t.add({ rss: 10, commit: 10 }, 2_700);
    expect(t.result()).toEqual({
      peakBytes: 400,
      commitPeakBytes: 900,
      samples: 4,
      ticks: 4,
      medianIntervalMs: 600, // intervals 500, 600, 600
    });
  });
  it('an even number of intervals averages the two middle ones; one tick has no interval', () => {
    const t = rss.createSampleTracker();
    t.add({ rss: 1, commit: 1 }, 0);
    expect(t.result().medianIntervalMs).toBeNull();
    t.add({ rss: 1, commit: 1 }, 400);
    t.add({ rss: 1, commit: 1 }, 1000);
    expect(t.result().medianIntervalMs).toBe(500); // intervals 400, 600
  });
  it('a sampler with no commit figure (macOS, Linux) reports commitPeakBytes null, never 0', () => {
    const t = rss.createSampleTracker();
    t.add({ rss: 5, commit: null }, 0);
    expect(t.result()).toMatchObject({ peakBytes: 5, commitPeakBytes: null });
    expect(rss.createSampleTracker().result()).toEqual({
      peakBytes: null,
      commitPeakBytes: null,
      samples: 0,
      ticks: 0,
      medianIntervalMs: null,
    });
  });
  it('the old tracker is unchanged', () => {
    const s = rss.createPeakTracker();
    for (const v of [100, 300, 200]) s.add(v);
    expect([s.peak(), s.count()]).toEqual([300, 3]);
  });
});

describe('startRssSampler on win32, driven through a fake child (no PowerShell needed)', () => {
  function fakeSpawn(lines: string[], gapMs: number) {
    const calls: { cmd: string; args: string[] }[] = [];
    const spawn = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.kill = () => true;
      let i = 0;
      const timer = setInterval(() => {
        if (i >= lines.length) return clearInterval(timer);
        // Windows PowerShell ends a line with CRLF, and may split a line across two chunks
        const text = `${lines[i++]}\r\n`;
        child.stdout.emit('data', Buffer.from(text.slice(0, 20)));
        child.stdout.emit('data', Buffer.from(text.slice(20)));
      }, gapMs);
      return child;
    };
    return { spawn, calls };
  }

  it('sums the profile tree per tick, keeps both peaks and records the ticks and the median interval', async () => {
    const small = line([row(7000, 1, 100, 150, `${CHROME} --user-data-dir=${DIR}`)]);
    const big = line([
      row(7000, 1, 100, 150, `${CHROME} --user-data-dir=${DIR}`),
      row(7002, 7000, 300, 800, `${CHROME} --type=renderer`),
    ]);
    const { spawn, calls } = fakeSpawn([`\uFEFF${small}`, big, small, big], 15);
    const s = rss.startRssSampler({ userDataDir: DIR, platform: 'win32', spawn });
    await new Promise((r) => setTimeout(r, 200));
    const r = await s.stop();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('powershell.exe');
    expect(r.peakBytes).toBe(400);
    expect(r.commitPeakBytes).toBe(950);
    expect(r.samples).toBe(4);
    expect(r.ticks).toBe(4);
    expect(r.medianIntervalMs).toBeGreaterThan(0);
    expect(r.medianIntervalMs).toBeLessThan(200);
  });

  it('on macOS and Linux the sampler returns the old figures and no commit figure', async () => {
    const s = rss.startRssSampler({ userDataDir: '/nowhere', platform: 'linux' });
    const r = await s.stop();
    expect(r.peakBytes).toBeNull();
    expect(r.commitPeakBytes).toBeNull();
    expect(r.samples).toBe(0);
  });
});
