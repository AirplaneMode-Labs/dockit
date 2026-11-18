// "Peak memory" of a benchmark run (TD-49): the peak summed resident size of the test Chrome's process tree (browser, GPU, utility and
// renderer processes), found from the processes whose command line holds the test profile's --user-data-dir.
//   macOS and Linux  `ps -A -o pid=,ppid=,rss=,command=` every 250 ms (rss in KiB; shared pages are counted in every process that maps them)
//   Windows          ONE long-running Windows PowerShell 5.1 child that prints the Win32_Process list as one JSON line every 500 ms
//                    (WorkingSetSize, in bytes). It has never run on Windows: the owner's runbook run is the first. Task Manager (Details,
//                    chrome.exe, memory columns) is the cross-check.
import { spawn, execFile } from 'node:child_process';

export function psCommand() {
  return { cmd: 'ps', args: ['-A', '-o', 'pid=,ppid=,rss=,command='] };
}

/** The PowerShell command of the runbook: one long-running child, one JSON array per line. */
export function winCommand(intervalMs = 500) {
  const script = `while ($true) { Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,WorkingSetSize,CommandLine | ConvertTo-Json -Compress; Start-Sleep -Milliseconds ${intervalMs} }`;
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
    j = JSON.parse(text);
  } catch {
    return [];
  }
  return (Array.isArray(j) ? j : [j])
    .filter((p) => p && Number.isInteger(p.ProcessId))
    .map((p) => ({
      pid: p.ProcessId,
      ppid: p.ParentProcessId ?? 0,
      rssBytes: Number(p.WorkingSetSize) || 0,
      command: p.CommandLine ?? '',
    }));
}

const norm = (s) => s.replaceAll('\\', '/').toLowerCase();

/** Sum of the rss of every process whose command line holds `userDataDir`, plus every descendant of those. */
export function sumTreeRss(procs, userDataDir) {
  const needle = norm(userDataDir);
  const roots = new Set(procs.filter((p) => norm(p.command).includes(needle)).map((p) => p.pid));
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
  return procs.filter((p) => seen.has(p.pid)).reduce((n, p) => n + p.rssBytes, 0);
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

/** Starts sampling; stop() resolves with { peakBytes, samples }. */
export function startRssSampler({ userDataDir, platform = process.platform }) {
  const tracker = createPeakTracker();
  if (platform === 'win32') {
    const { cmd, args } = winCommand(500);
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) tracker.add(sumTreeRss(parseWin(line), userDataDir));
      }
    });
    return {
      stop: async () => (child.kill(), { peakBytes: tracker.peak(), samples: tracker.count() }),
    };
  }
  const { cmd, args } = psCommand();
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      busy = false;
      if (!err) tracker.add(sumTreeRss(parsePs(stdout), userDataDir));
    });
  }, 250);
  return {
    stop: async () => (
      clearInterval(timer),
      { peakBytes: tracker.peak(), samples: tracker.count() }
    ),
  };
}
