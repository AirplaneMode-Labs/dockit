import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let probed: boolean | undefined;

/** True when a pwsh is on the PATH (asked once). */
export function hasPwsh(): boolean {
  probed ??= (() => {
    const r = spawnSync(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'],
      { encoding: 'utf8' },
    );
    return r.error === undefined && r.status === 0;
  })();
  return probed;
}

/**
 * The syntax errors PowerShell's own parser finds in `source` ([System.Management.Automation.Language.Parser]::ParseInput), one message per error with its line;
 * [] for a script that parses; null when there is no pwsh to ask (it is preinstalled on every GitHub runner, so a test that gets null is only skipped on a machine
 * without it). A parse is not a run: it does not resolve a command or evaluate anything.
 */
export function pwshParseErrors(source: string): string[] | null {
  if (!hasPwsh()) return null;
  const dir = mkdtempSync(join(tmpdir(), 'dockit-pwsh-'));
  const target = join(dir, 'target.ps1');
  const parser = join(dir, 'parse.ps1');
  writeFileSync(target, source);
  writeFileSync(
    parser,
    [
      'param([string]$Path)',
      '$errors = $null',
      '$tokens = $null',
      '$text = [System.IO.File]::ReadAllText($Path)',
      '[void][System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)',
      "foreach ($e in $errors) { Write-Output ('line ' + $e.Extent.StartLineNumber + ': ' + $e.Message) }",
    ].join('\n'),
  );
  const r = spawnSync(
    'pwsh',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', parser, target],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) return [`pwsh exited ${r.status}: ${r.stderr}`];
  return r.stdout.split(/\r?\n/u).filter((l) => l !== '');
}
