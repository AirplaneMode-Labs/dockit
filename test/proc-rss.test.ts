import { describe, expect, it } from 'vitest';
import * as rss from '../scripts/lib/proc-rss.mjs';

const DIR = '/var/folders/xx/T/chrome-profile-abc123';

/** A recorded `ps -A -o pid=,ppid=,rss=,command=` listing from macOS (names shortened, paths as Chrome prints them). */
const PS = `
    1     0   9000 /sbin/launchd
  500     1 120000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${DIR} --remote-debugging-pipe --enable-precise-memory-info about:blank
  501   500  80000 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (GPU).app/Contents/MacOS/Google Chrome Helper (GPU) --type=gpu-process --user-data-dir=${DIR}
  502   500  60000 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=utility --user-data-dir=${DIR}
  503   500 900000 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer --user-data-dir=${DIR} --lang=en-US
  504   503  15000 /some/child/without/the/flag --type=child
  900     1 700000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/var/folders/xx/T/chrome-profile-OTHER --remote-debugging-pipe
  901   900 300000 /Applications/Google Chrome.app/Contents/Frameworks/x/Google Chrome Helper (Renderer) --type=renderer --user-data-dir=/var/folders/xx/T/chrome-profile-OTHER
 1200     1  50000 /usr/bin/node /work/scripts/bench-e2e.mjs
`;

/** A recorded Windows PowerShell 5.1 Get-CimInstance listing, one JSON array on one line (WorkingSetSize is bytes). */
const WIN = JSON.stringify([
  { ProcessId: 4, ParentProcessId: 0, WorkingSetSize: 140000, CommandLine: null },
  {
    ProcessId: 7000,
    ParentProcessId: 100,
    WorkingSetSize: 150000000,
    CommandLine:
      '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir=C:\\Users\\x\\AppData\\Local\\Temp\\chrome-profile-abc123 --remote-debugging-pipe',
  },
  {
    ProcessId: 7001,
    ParentProcessId: 7000,
    WorkingSetSize: 90000000,
    CommandLine:
      '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=gpu-process --user-data-dir=C:\\Users\\x\\AppData\\Local\\Temp\\chrome-profile-abc123',
  },
  {
    ProcessId: 7002,
    ParentProcessId: 7000,
    WorkingSetSize: 800000000,
    CommandLine:
      '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=renderer --user-data-dir=C:\\Users\\x\\AppData\\Local\\Temp\\chrome-profile-abc123 --lang=en-US',
  },
  { ProcessId: 7003, ParentProcessId: 7002, WorkingSetSize: 5000000, CommandLine: null },
  {
    ProcessId: 8000,
    ParentProcessId: 100,
    WorkingSetSize: 600000000,
    CommandLine:
      '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir=C:\\Users\\x\\AppData\\Local\\Temp\\chrome-profile-OTHER',
  },
]);

describe('proc-rss: macOS ps parser', () => {
  it('parses pid, ppid, rss (KiB to bytes) and the whole command line, one entry per line', () => {
    const p = rss.parsePs(PS);
    expect(p).toHaveLength(9);
    expect(p[1]).toMatchObject({ pid: 500, ppid: 1, rssBytes: 120000 * 1024 });
    expect(p[1]!.command).toContain('--user-data-dir=');
    expect(p[1]!.command).toContain('Google Chrome.app'); // a path with a space stays whole
  });
  it('ignores blank and malformed lines', () => {
    expect(rss.parsePs('\n  garbage\n  12 abc 5 cmd\n')).toEqual([]);
  });
  it('sums the Chrome process tree of THIS profile: the root, its helpers and a child that has no flag, and nothing else', () => {
    const total = rss.sumTreeRss(rss.parsePs(PS), DIR);
    expect(total).toBe((120000 + 80000 + 60000 + 900000 + 15000) * 1024);
  });
  it('another profile and unrelated processes are not counted; an unknown profile sums to 0', () => {
    expect(rss.sumTreeRss(rss.parsePs(PS), '/var/folders/xx/T/chrome-profile-OTHER')).toBe(
      (700000 + 300000) * 1024,
    );
    expect(rss.sumTreeRss(rss.parsePs(PS), '/nowhere')).toBe(0);
  });
});

describe('proc-rss: Windows Get-CimInstance parser (never run on Windows: this is a recorded shape, the owner runs it first)', () => {
  it('parses ProcessId, ParentProcessId, WorkingSetSize (bytes) and CommandLine, null command lines included', () => {
    const p = rss.parseWin(WIN);
    expect(p).toHaveLength(6);
    expect(p[1]).toMatchObject({ pid: 7000, ppid: 100, rssBytes: 150000000 });
    expect(p[4]!.command).toBe('');
  });
  it('accepts a single object (PowerShell prints one object, not an array, when there is one) and refuses garbage', () => {
    expect(
      rss.parseWin(
        JSON.stringify({ ProcessId: 1, ParentProcessId: 0, WorkingSetSize: 5, CommandLine: 'x' }),
      ),
    ).toHaveLength(1);
    expect(rss.parseWin('not json')).toEqual([]);
  });
  it('sums the tree whose command line holds the profile directory, matching a backslash path case-insensitively', () => {
    const p = rss.parseWin(WIN);
    const dir = 'C:\\Users\\x\\AppData\\Local\\Temp\\chrome-profile-abc123';
    expect(rss.sumTreeRss(p, dir)).toBe(150000000 + 90000000 + 800000000 + 5000000);
    expect(rss.sumTreeRss(p, dir.toLowerCase())).toBe(150000000 + 90000000 + 800000000 + 5000000);
    expect(rss.sumTreeRss(p, 'C:\\Users\\x\\AppData\\Local\\Temp\\chrome-profile-OTHER')).toBe(
      600000000,
    );
  });
});

describe('proc-rss: the sampler keeps the peak', () => {
  it('takes the maximum of the summed samples and counts them', async () => {
    const samples = [100, 300, 200];
    let i = 0;
    const s = rss.createPeakTracker();
    for (const v of samples) s.add(v);
    expect(s.peak()).toBe(300);
    expect(s.count()).toBe(3);
    expect(i).toBe(0);
    expect(rss.createPeakTracker().peak()).toBeNull();
  });
  it('builds the macOS command and the single long-running Windows PowerShell command as the runbook gives it', () => {
    expect(rss.psCommand()).toEqual({ cmd: 'ps', args: ['-A', '-o', 'pid=,ppid=,rss=,command='] });
    const w = rss.winCommand(500);
    expect(w.cmd).toBe('powershell.exe');
    expect(w.args.join(' ')).toContain('Get-CimInstance Win32_Process');
    expect(w.args.join(' ')).toContain('WorkingSetSize');
    expect(w.args.join(' ')).toContain('ConvertTo-Json -Compress');
    expect(w.args.join(' ')).toContain('Start-Sleep -Milliseconds 500');
  });
});
