// "Peak memory" of a benchmark run (TD-49): the peak summed resident size of the test Chrome's process tree (browser, GPU, utility and
// renderer processes), found from the processes whose command line holds the test profile's --user-data-dir.
//   macOS and Linux  `ps -A -o pid=,ppid=,rss=,command=` every 250 ms (rss in KiB; shared pages are counted in every process that maps them)
//   Windows          ONE long-running Windows PowerShell 5.1 child that prints the Win32_Process list as one JSON line every 500 ms
//                    (WorkingSetSize and PrivatePageCount, in bytes: the working set and the commit size, which are different figures, TD-49). Its
//                    output is UTF-8 without a byte-order mark. It has run on a GitHub-hosted Windows Server VM (the bench-windows workflow, three
//                    dispatches) and never on a Windows laptop: the owner's runbook run is the first there. Task Manager (Details, chrome.exe, memory columns) is the cross-check. The sampler also
//                    reports how many ticks it got and the median time between them, because enumerating every process each tick can take longer
//                    than the 500 ms it sleeps, and short peaks between ticks are missed.
import { spawn, execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export function psCommand() {
  return { cmd: 'ps', args: ['-A', '-o', 'pid=,ppid=,rss=,command='] };
}

/** The PowerShell command of the runbook: one long-running child, one JSON array per line, UTF-8 without a byte-order mark. */
export function winCommand(intervalMs = 500) {
  const script = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; while ($true) { Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,WorkingSetSize,PrivatePageCount,CommandLine | ConvertTo-Json -Compress; Start-Sleep -Milliseconds ${intervalMs} }`;
  return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] };
}

export function parsePs(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m)
      out.push({
        pid: Number(m[1]),
        ppid: Number(m[2]),
        rssBytes: Number(m[3]) * 1024,
        command: m[4],
      });
  }
  return out;
}

export function parseWin(text) {
  let j;
  try {
    j = JSON.parse(text.replace(/^\uFEFF/u, ''));
  } catch {
    return [];
  }
  return (Array.isArray(j) ? j : [j])
    .filter((p) => p && Number.isInteger(p.ProcessId))
    .map((p) => ({
      pid: p.ProcessId,
      ppid: p.ParentProcessId ?? 0,
      rssBytes: Number(p.WorkingSetSize) || 0,
      // PrivatePageCount is the process's private commit in bytes: the figure a Job Object commit limit adds up (null for a process we may not query)
      commitBytes: Number(p.PrivatePageCount) || 0,
      command: p.CommandLine ?? '',
    }));
}

const norm = (s) => s.replaceAll('\\', '/').toLowerCase();

/**
 * Sum of `field` ('rssBytes', the default, or 'commitBytes') over every process whose command line holds `userDataDir`, plus every descendant of those.
 * A process whose command line could not be read (null, so '') matches nothing by itself and is counted only as a descendant. An empty `userDataDir`
 * matches nothing.
 */
export function sumTreeRss(procs, userDataDir, field = 'rssBytes') {
  const needle = norm(userDataDir);
  const roots = new Set(
    needle === '' ? [] : procs.filter((p) => norm(p.command).includes(needle)).map((p) => p.pid),
  );
  const children = new Map();
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const c of children.get(pid) ?? []) stack.push(c.pid);
  }
  return procs.filter((p) => seen.has(p.pid)).reduce((n, p) => n + (p[field] ?? 0), 0);
}

export function createPeakTracker() {
  let peak = null;
  let n = 0;
  return {
    add(v) {
      n += 1;
      if (peak === null || v > peak) peak = v;
    },
    peak: () => peak,
    count: () => n,
  };
}

/**
 * The peaks of one run: rss (working set / resident size), commit (null where the platform gives none), the number of ticks and the median time between
 * ticks. `add(figures, nowMs)` takes one summed sample and the time it was received.
 */
export function createSampleTracker() {
  let rss = null;
  let commit = null;
  let n = 0;
  let last = null;
  const gaps = [];
  return {
    add({ rss: r, commit: c }, nowMs) {
      n += 1;
      if (rss === null || r > rss) rss = r;
      if (c !== null && c !== undefined && (commit === null || c > commit)) commit = c;
      if (last !== null) gaps.push(nowMs - last);
      last = nowMs;
    },
    result() {
      const g = [...gaps].sort((a, b) => a - b);
      const m = g.length >> 1;
      return {
        peakBytes: rss,
        commitPeakBytes: commit,
        samples: n,
        ticks: n,
        medianIntervalMs: g.length === 0 ? null : g.length % 2 ? g[m] : (g[m - 1] + g[m]) / 2,
      };
    },
  };
}

/**
 * Starts sampling; stop() resolves with { peakBytes, commitPeakBytes, samples, ticks, medianIntervalMs }. `spawn` is injectable for the tests (a fake child
 * that prints recorded lines), and `now` is the clock that stamps each tick.
 */
export function startRssSampler({
  userDataDir,
  platform = process.platform,
  spawn: spawnFn = spawn,
  now = Date.now,
}) {
  const tracker = createSampleTracker();
  if (platform === 'win32') {
    const { cmd, args } = winCommand(500);
    const child = spawnFn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const decoder = new StringDecoder('utf8');
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += typeof d === 'string' ? d : decoder.write(d);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const procs = parseWin(line);
        tracker.add(
          {
            rss: sumTreeRss(procs, userDataDir),
            commit: sumTreeRss(procs, userDataDir, 'commitBytes'),
          },
          now(),
        );
      }
    });
    // an unavailable powershell.exe is not a crash of the benchmark: the run goes on and its memory figures read empty (the owner is told)
    child.on?.('error', () => undefined);
    return {
      stop: async () => (child.kill(), tracker.result()),
    };
  }
  const { cmd, args } = psCommand();
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      busy = false;
      if (!err) tracker.add({ rss: sumTreeRss(parsePs(stdout), userDataDir), commit: null }, now());
    });
  }, 250);
  return {
    stop: async () => (clearInterval(timer), tracker.result()),
  };
}
