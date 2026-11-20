import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPAWN_TEST_TIMEOUT_MS } from './helpers/timeouts.ts';
import { hasPwsh, pwshParseErrors } from './helpers/pwsh.ts';
import { CONTROL_CAPS, LEG_CAPS } from '../scripts/lib/bench-columns.mjs';

const wf = (name: string) =>
  readFileSync(join(__dirname, '..', '.github', 'workflows', name), 'utf8');

/** The CI conventions table (sprint-4-notes.md, carried as written): action -> [full SHA, tag]. */
const PINS: Record<string, [string, string]> = {
  'actions/checkout': ['3d3c42e5aac5ba805825da76410c181273ba90b1', 'v7.0.1'],
  'actions/setup-node': ['949feb2413d6458794dcd2491c4babbbce0c15c1', 'v7.1.0'],
  'actions/setup-python': ['6d4fd22b20465ccc0f7354476588e8df7c9ca0e0', 'v7.1.0'],
  'actions/cache': ['55cc8345863c7cc4c66a329aec7e433d2d1c52a9', 'v6.1.0'],
  // Sprint 7 rows (TD-119): restore-only, at the actions/cache SHA, in the bench-windows build job only
  'actions/cache/restore': ['55cc8345863c7cc4c66a329aec7e433d2d1c52a9', 'v6.1.0'],
  'actions/configure-pages': ['45bfe0192ca1faeb007ade9deae92b16b8254a0d', 'v6.0.0'],
  'actions/upload-pages-artifact': ['fc324d3547104276b827a68afc52ff2a11cc49c9', 'v5.0.0'],
  'actions/deploy-pages': ['368f82528645a54fb793d4d04e342629a3f51346', 'v5.0.1'],
  'dtolnay/rust-toolchain': ['683b588c487a69d01f6c6ddf40f036ff682cc2c8', 'v1'],
  'Swatinem/rust-cache': ['d1527c8f67ef9af357290475d4af4b0fab8f12e0', 'v2.9.3'],
  // Sprint 7 rows: bench-windows.yml only (the hand-off of dist and the result uploads)
  'actions/upload-artifact': ['cf430e030ddbb5b0abf93d22962f4752f3646cd9', 'v7.0.2'],
  'actions/download-artifact': ['9000827ccba6bdab643e8b6fd33ac0654aef8333', 'v8.0.2'],
};

/** Splits a workflow into its top-level jobs: name -> text of the job block. */
function jobs(text: string): Record<string, string> {
  const start = text.indexOf('\njobs:\n');
  const body = text.slice(start + 6);
  const out: Record<string, string> = {};
  const re = /^ {2}([a-z][a-z0-9-]*):\n/gm;
  const marks = [...body.matchAll(re)].map((m) => ({ name: m[1]!, at: m.index! }));
  marks.forEach((m, i) => (out[m.name] = body.slice(m.at, marks[i + 1]?.at ?? body.length)));
  return out;
}

describe.each(['ci.yml', 'pages.yml', 'bench-windows.yml'])('%s', (file) => {
  const text = wf(file);

  it('every uses: is owner/repo@<40-hex> # <tag>, with the SHA and tag from the conventions table', () => {
    const uses = [...text.matchAll(/^\s*(?:- )?uses: (\S+)@(\S+)(?: # (\S+))?\s*$/gm)];
    expect(uses.length).toBeGreaterThanOrEqual(2);
    for (const [, action, sha, tag] of uses) {
      expect(PINS[action!], `${action} is not in the conventions table`).toBeDefined();
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect([sha, tag]).toEqual(PINS[action!]);
    }
    expect([...text.matchAll(/^\s*(?:- )?uses: /gm)].length).toBe(uses.length);
  });

  it('no secrets, no pull_request_target, no workflow input', () => {
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toMatch(/pull_request_target/);
    expect(text).not.toMatch(/inputs\./);
    expect(text).not.toMatch(/github\.event\./);
  });

  it('every checkout sets persist-credentials: false', () => {
    const blocks = text.split(/uses: actions\/checkout@/).slice(1);
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) expect(b.slice(0, 500)).toMatch(/persist-credentials: false/);
  });

  it('every npm install is npm ci --ignore-scripts', () => {
    for (const m of text.matchAll(/npm (ci|install|i)\b[^\n]*/g))
      expect(m[0]).toMatch(/^npm ci --ignore-scripts$/);
    expect(text).toMatch(/npm ci --ignore-scripts/);
  });

  it('declares permissions at the top level and per job', () => {
    expect(text).toMatch(/^permissions:\n {2}contents: read\n/m);
    for (const [name, body] of Object.entries(jobs(text)))
      expect(body, name).toMatch(/\n {4}permissions:\n/);
  });
});

describe('ci.yml', () => {
  const text = wf('ci.yml');
  it('runs check on ubuntu, macos and windows with fail-fast false, bash everywhere, in stub mode', () => {
    expect(text).toMatch(/os: \[ubuntu-latest, macos-latest, windows-latest\]/);
    expect(text).toMatch(/fail-fast: false/);
    expect(text).toMatch(/defaults:\n {2}run:\n {4}shell: bash/);
    expect(text).toMatch(/run: npm run ci\n/);
  });
  it('does not build the sibling repositories or the model bundle', () => {
    expect(text).not.toMatch(/assemble-deps|rust-toolchain|fetch-model/);
  });
});

describe('pages.yml: the four-sibling build (TD-40)', () => {
  const text = wf('pages.yml');
  const j = jobs(text);

  it('has exactly a build job and a deploy job', () => {
    expect(Object.keys(j)).toEqual(['build', 'deploy']);
  });

  it('build job: contents: read only', () => {
    expect(j['build']).toMatch(/\n {4}permissions:\n {6}contents: read\n/);
    expect(j['build']).not.toMatch(/pages: write|id-token/);
  });

  it('deploy job: only pages: write and id-token: write, environment github-pages', () => {
    expect(j['deploy']).toMatch(
      /\n {4}permissions:\n {6}pages: write\n {6}id-token: write\n {4}environment:/,
    );
    expect(j['deploy']).toMatch(/name: github-pages/);
    const perms = j['deploy']!.match(/permissions:\n((?: {6}\S.*\n)+)/)![1]!;
    expect(perms.trim().split('\n').length).toBe(2);
  });

  it('the sibling checkouts use the 40-hex ref a step read from deps.lock.json, persist-credentials false and path deps/<repo>', () => {
    expect(text).toMatch(/id: lock/);
    expect(text).toMatch(/deps\.lock\.json/);
    for (const dep of ['runtime', 'localdata', 'pagetriage', 'glyphsift']) {
      const re = new RegExp(
        `repository: AirplaneMode-Labs/${dep}\\n\\s+ref: \\$\\{\\{ steps\\.lock\\.outputs\\.${dep} \\}\\}\\n\\s+path: deps/${dep}\\n\\s+persist-credentials: false`,
      );
      expect(text, dep).toMatch(re);
    }
    // no other repository is ever checked out, and no ref is anything but a lock output
    expect([...text.matchAll(/repository: (\S+)/g)].map((m) => m[1]).sort()).toEqual([
      'AirplaneMode-Labs/glyphsift',
      'AirplaneMode-Labs/localdata',
      'AirplaneMode-Labs/pagetriage',
      'AirplaneMode-Labs/runtime',
    ]);
    expect(
      [...text.matchAll(/^\s+ref: (.*)$/gm)].every((m) =>
        /^\$\{\{ steps\.lock\.outputs\.[a-z]+ \}\}$/.test(m[1]!),
      ),
    ).toBe(true);
  });

  it('builds with Rust 1.98 and wasm32, installs wasm-bindgen and wasm-opt only through the two install scripts', () => {
    expect(text).toMatch(/toolchain: ["']1\.98["']/);
    expect(text).toMatch(/targets: wasm32-unknown-unknown/);
    expect(text).toMatch(/bash deps\/pagetriage\/scripts\/install-wasm-tools\.sh/);
    expect(text).toMatch(/bash deps\/glyphsift\/scripts\/install-wasm-tools\.sh/);
    expect(text).not.toMatch(/cargo install|brew |apt(-get)? install|wasm-bindgen-cli/);
  });

  it("caches the runtime model cache before assemble-deps runs runtime's fetch-model, which re-hashes every file after the restore", () => {
    expect(text).toMatch(/path: deps\/runtime\/\.cache\/models/);
    expect(text.indexOf('actions/cache@')).toBeLessThan(
      text.indexOf('node scripts/assemble-deps.mjs'),
    );
    expect(text).not.toMatch(/fetch-model/); // assemble-deps runs it for both models
  });

  it('assembles with --checkouts deps and then runs npm run build, in that order', () => {
    const a = text.indexOf('node scripts/assemble-deps.mjs --checkouts deps');
    const b = text.indexOf('run: npm run build');
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
  });

  it('refuses a dist over 1 GB (1,000,000,000 bytes, the documented Pages limit; S1-112 a) and prints per-file sizes', () => {
    expect(text).toMatch(/-gt 1000000000\b/);
    // the old GiB figure (1,073,741,824) is above the documented limit, so it must be gone
    expect(text).not.toMatch(/1073741824/);
    expect(text).not.toMatch(/over 1 GiB/);
    expect(text).toMatch(/find dist -type f -size/);
    expect(text).toMatch(/exit 1/);
  });
});

/** The text of one job's `steps:` split into steps: each starts at a line of exactly six spaces and a dash. */
function steps(jobBody: string): string[] {
  const at = jobBody.indexOf('\n    steps:\n');
  return jobBody
    .slice(at + '\n    steps:\n'.length)
    .split(/^ {6}- /mu)
    .slice(1)
    .map((x) => `- ${x}`);
}

// B6 (TD-113): the manual Windows benchmark. It is dispatched once by the main session after the push and never runs on a push or a pull request.
describe('bench-windows.yml: manual dispatch only, a fixed matrix, nothing a fork or a push can reach', () => {
  const text = wf('bench-windows.yml');
  const j = jobs(text);

  it('is triggered by workflow_dispatch and by nothing else, and takes no input', () => {
    expect(text).toMatch(/^on:\n {2}workflow_dispatch:\n/mu);
    expect(text).not.toMatch(
      /^ {2}(push|pull_request|pull_request_target|schedule|workflow_run|release|repository_dispatch):/mu,
    );
    expect(text).not.toMatch(/^\s+inputs:/mu);
    expect(text.match(/^on:\n((?: {2}\S.*\n|\n)+)/mu)![1]!.trim()).toBe('workflow_dispatch:');
  });

  it('serialises runs in the group bench-windows, without cancelling a running benchmark', () => {
    expect(text).toMatch(
      /^concurrency:\n {2}group: bench-windows\n {2}cancel-in-progress: false\n/mu,
    );
  });

  it('has exactly a build job and a bench job, named as the push list names them', () => {
    expect(Object.keys(j)).toEqual(['build', 'bench']);
    expect(j['build']).toMatch(/\n {4}name: build dist \(ubuntu-latest\)\n/u);
    expect(j['bench']).toMatch(
      /\n {4}name: bench \(windows-latest, \$\{\{ matrix\.cap \}\}\$\{\{ matrix\.control && ', control' \|\| '' \}\}\)\n/u,
    );
  });

  it('both jobs have contents: read and nothing else: no id-token, no attestations, no pages, no secrets', () => {
    for (const name of ['build', 'bench']) {
      expect(j[name], name).toMatch(/\n {4}permissions:\n {6}contents: read\n(?! {6}\S)/u);
    }
    expect(text).not.toMatch(
      /id-token|attestations|pages: write|packages: write|actions: write|secrets\./u,
    );
  });

  it('no setup-node cache, no rust-cache and no actions/cache save: the only cache step is restore-only', () => {
    expect(text).not.toMatch(/^\s+cache: /mu);
    expect(text).not.toMatch(/Swatinem\/rust-cache/u);
    expect(text).not.toMatch(/actions\/cache@/u);
    expect(text.match(/uses: actions\/cache\/restore@/gu)?.length).toBe(1);
    expect(j['build']).toMatch(/uses: actions\/cache\/restore@/u);
    expect(j['bench']).not.toMatch(/actions\/cache/u);
  });

  it('every run: step names its shell (bash or pwsh), and the workflow default is bash', () => {
    expect(text).toMatch(/defaults:\n {2}run:\n {4}shell: bash/u);
    for (const name of ['build', 'bench']) {
      for (const s of steps(j[name]!)) {
        if (/^\s+run:/mu.test(s)) expect(s, s.slice(0, 80)).toMatch(/^\s+shell: (bash|pwsh)$/mu);
      }
    }
  });

  it('matrix and job values never reach a script through ${{ }} inside run: a run block holds no expression', () => {
    for (const name of ['build', 'bench']) {
      for (const s of steps(j[name]!)) {
        // the command (or the '|' of a block) and every following line indented by ten spaces or more
        const m = /^ {8}run: (.*)\n((?: {10}.*(?:\n|$)|\n)*)/mu.exec(s);
        if (m !== null) expect(`${m[1]}\n${m[2]}`, s.slice(0, 80)).not.toContain('${{');
      }
    }
  });
});

describe('bench-windows.yml: the build job (ubuntu-latest)', () => {
  const text = wf('bench-windows.yml');
  const build = jobs(text)['build']!;
  const at = (needle: string) => build.indexOf(needle);

  it('reads the sibling commits from deps.lock.json and checks out exactly the four siblings, as pages.yml does', () => {
    expect(build).toMatch(/runs-on: ubuntu-latest/u);
    expect(build).toMatch(/id: lock/u);
    for (const dep of ['runtime', 'localdata', 'pagetriage', 'glyphsift'])
      expect(build, dep).toMatch(
        new RegExp(
          `repository: AirplaneMode-Labs/${dep}\\n\\s+ref: \\$\\{\\{ steps\\.lock\\.outputs\\.${dep} \\}\\}\\n\\s+path: deps/${dep}\\n\\s+persist-credentials: false`,
          'u',
        ),
      );
    expect([...build.matchAll(/repository: (\S+)/gu)].map((m) => m[1]).sort()).toEqual([
      'AirplaneMode-Labs/glyphsift',
      'AirplaneMode-Labs/localdata',
      'AirplaneMode-Labs/pagetriage',
      'AirplaneMode-Labs/runtime',
    ]);
  });

  it('builds with Rust 1.98 and the two pinned install scripts, then assembles and builds, in that order', () => {
    expect(build).toMatch(/toolchain: ["']1\.98["']/u);
    expect(build).toMatch(/bash deps\/pagetriage\/scripts\/install-wasm-tools\.sh/u);
    expect(build).toMatch(/bash deps\/glyphsift\/scripts\/install-wasm-tools\.sh/u);
    expect(build).not.toMatch(/cargo install|brew |apt(-get)? install|wasm-bindgen-cli/u);
    expect(at('install-wasm-tools.sh')).toBeLessThan(at('actions/cache/restore'));
    expect(at('node scripts/assemble-deps.mjs --checkouts deps')).toBeGreaterThan(0);
    expect(at('run: npm run build')).toBeGreaterThan(
      at('node scripts/assemble-deps.mjs --checkouts deps'),
    );
  });

  it("restores the model cache restore-only under the pages.yml key, then re-hashes every restored model file against runtime's committed pins before assembling", () => {
    expect(build).toMatch(/path: deps\/runtime\/\.cache\/models/u);
    expect(build).toMatch(/key: models-\$\{\{ hashFiles\('deps\.lock\.json'\) \}\}/u);
    const restore = at('actions/cache/restore');
    const verify = at('node scripts/verify-model-cache.mjs');
    const assemble = at('node scripts/assemble-deps.mjs --checkouts deps');
    expect(verify).toBeGreaterThan(restore);
    expect(assemble).toBeGreaterThan(verify);
    expect(build).toMatch(/node scripts\/verify-model-cache\.mjs --checkouts deps/u);
  });

  it('writes dist-SHA256SUMS over every file of dist, then uploads dist and the sums as a one-day artefact named by the commit', () => {
    expect(build).toMatch(/dist-SHA256SUMS/u);
    expect(build).toMatch(/sha256sum/u);
    // BUG-T3-S7-10: binary mode on both sides, so a text-mode ambiguity on Windows Git Bash cannot exist
    expect(build).toMatch(/xargs -0 sha256sum --binary > dist-SHA256SUMS/u);
    expect(at('dist-SHA256SUMS')).toBeGreaterThan(at('run: npm run build'));
    const up = build.slice(at('actions/upload-artifact@'));
    expect(up).toMatch(/name: dockit-dist-\$\{\{ github\.sha \}\}\n/u);
    expect(up).toMatch(/retention-days: 1\n/u);
    expect(up).toMatch(/if-no-files-found: error\n/u);
    expect(up).toMatch(/include-hidden-files: false\n/u);
    expect(up).toMatch(/^\s+dist\/\n\s+dist-SHA256SUMS\n/mu);
  });

  it('refuses a dist over 1 GB with the Pages guard, like pages.yml', () => {
    expect(build).toMatch(/-gt 1000000000\b/u);
  });
});

describe('bench-windows.yml: the bench job (windows-latest), one leg per cap', () => {
  const text = wf('bench-windows.yml');
  const bench = jobs(text)['bench']!;
  const all = steps(bench);
  const find = (needle: RegExp) => all.find((s) => needle.test(s));

  it('needs the build job, runs on windows-latest for at most 90 minutes (20 on the control leg), and does not stop the other legs when one fails', () => {
    expect(bench).toMatch(/\n {4}needs: build\n/u);
    expect(bench).toMatch(/\n {4}runs-on: windows-latest\n/u);
    expect(bench).toMatch(/\n {4}timeout-minutes: \$\{\{ matrix\.control && 20 \|\| 90 \}\}\n/u);
    expect(bench).toMatch(/fail-fast: false/u);
  });

  it('the matrix is none, 8GiB, 6GiB and 5GiB written out, plus exactly one include: the 2GiB control leg; no exclude', () => {
    expect(bench).toMatch(
      /\n {6}matrix:\n {8}cap: \[none, 8GiB, 6GiB, 5GiB\]\n {8}include:\n(?: {10}#.*\n)* {10}- cap: 2GiB\n {12}control: true\n {4}steps:/u,
    );
    expect(bench).not.toMatch(/exclude:/u);
    expect(bench.match(/include:/gu)).toHaveLength(1);
    // the one control cap of the workflow is the one of the script and of the column list, and no other cap is a control
    expect(CONTROL_CAPS).toEqual(['2GiB']);
    expect(Object.keys(LEG_CAPS)).toEqual(['none', '8GiB', '6GiB', '5GiB', '2GiB']);
    const ps1 = readFileSync(join(__dirname, '..', 'scripts', 'win', 'run-capped.ps1'), 'utf8');
    expect(ps1).toContain("$IsControl = $Cap -ceq '2GiB'");
    expect(ps1).toContain("-cnotin @('none', '8GiB', '6GiB', '5GiB', '2GiB')");
  });

  it('no step and no job may continue on error, and the control leg is green or red by the exit code of run-capped.ps1 alone', () => {
    expect(text).not.toMatch(/continue-on-error/u);
    const run = find(/run-capped\.ps1/u)!;
    expect(run).not.toMatch(/\bif:/u); // it always runs, and what it exits with is the leg's result
    expect(run).not.toMatch(/\|\||\bexit\b|\$LASTEXITCODE|-ErrorAction/u);
  });

  it('the control leg has a short job limit (20 minutes) and the script stops its benchmark earlier (12 minutes); matrix.control appears only in the job name and the timeout', () => {
    const ps1 = readFileSync(join(__dirname, '..', 'scripts', 'win', 'run-capped.ps1'), 'utf8');
    expect(ps1).toMatch(/\$ControlTimeoutMinutes = 12/u);
    expect(12).toBeLessThan(20);
    const lines = text.split('\n').filter((l) => l.includes('matrix.control'));
    expect(lines.length).toBe(2);
    expect(lines.filter((l) => l.startsWith('    name: bench ('))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('    timeout-minutes: '))).toHaveLength(1);
  });

  it('the header says what the control leg is: it must not complete, it is red when it does, and it has no CSV when it fails early', () => {
    const head = text.slice(0, text.indexOf('\non:\n')).replace(/\n# ?/gu, ' ');
    expect(head).toContain('2 GiB');
    expect(head).toMatch(/CONTROL/u);
    expect(head).toMatch(/must NOT complete/u);
    expect(head).toMatch(/red, because that would mean the cap does nothing/u);
    expect(head).toMatch(/no CSV/u);
  });

  it('matrix.cap appears only in the job name, one step env and the artefact name', () => {
    const lines = text.split('\n').filter((l) => l.includes('matrix.cap'));
    expect(lines.length).toBe(3);
    const kinds = lines.map((l) =>
      /^ {4}name: bench \(windows-latest, \$\{\{ matrix\.cap \}\}\$\{\{ matrix\.control && ', control' \|\| '' \}\}\)$/u.test(
        l,
      )
        ? 'job-name'
        : /^ {10}CAP: \$\{\{ matrix\.cap \}\}$/u.test(l)
          ? 'env'
          : /^ {10}name: bench-windows-\$\{\{ matrix\.cap \}\}-\$\{\{ github\.sha \}\}$/u.test(l)
            ? 'artefact'
            : l,
    );
    expect(kinds.sort()).toEqual(['artefact', 'env', 'job-name']);
  });

  it('checks out without credentials, sets up Node 22 with no cache, installs with npm ci --ignore-scripts', () => {
    expect(bench).toMatch(
      /uses: actions\/checkout@[0-9a-f]{40} # v7\.0\.1\n\s+with:\n\s+persist-credentials: false/u,
    );
    expect(bench).toMatch(/node-version: 22\n/u);
    expect(bench).toMatch(/run: npm ci --ignore-scripts\n/u);
  });

  it('downloads the dist of this run by name (no run-id, no token), and checks dist-SHA256SUMS on the runner before anything serves it', () => {
    const dl = find(/actions\/download-artifact@/u)!;
    expect(dl).toMatch(/name: dockit-dist-\$\{\{ github\.sha \}\}\n/u);
    expect(text).not.toMatch(/run-id:|github-token:/u);
    const check = find(/sha256sum[^\n]*--check|sha256sum -c/u)!;
    expect(check).toBeDefined();
    expect(check).toMatch(/shell: bash/u);
    expect(check).toMatch(/--strict/u);
    // GNU sha256sum (ubuntu, Git for Windows) refuses --binary or --text with --check: run 44651054609 failed on all four legs on exactly that. The mode of each file
    // comes from the '*' the build job wrote in its line, and a second test in the step refuses any line without it.
    expect(check).toMatch(/^\s+sha256sum --check --strict --quiet dist-SHA256SUMS$/mu);
    expect(check).not.toMatch(
      /sha256sum[^\n]*--(binary|text)\b[^\n]*--check|sha256sum[^\n]*--check[^\n]*--(binary|text)\b/u,
    );
    expect(check).toMatch(/grep -c -v -E '\^\[0-9a-f\]\{64\} \\\*dist\/' dist-SHA256SUMS/u);
    expect(all.indexOf(check)).toBeGreaterThan(all.indexOf(dl));
    expect(all.indexOf(check)).toBeLessThan(all.findIndex((s) => /run-capped\.ps1/u.test(s)));
    // the count of files in dist equals the count of lines in the sums: no file outside the sums is served
    expect(check).toMatch(/find dist -type f/u);
  });

  it('records the machine facts in bench-out/env.txt (memory, CPU, logical processors, page file, Chrome version, Defender) and never an environment variable', () => {
    const env = find(/env\.txt/u)!;
    expect(env).toMatch(/shell: pwsh/u);
    for (const fact of [
      'TotalPhysicalMemory',
      'NumberOfLogicalProcessors',
      'Win32_Processor',
      'Win32_PageFileUsage',
      'VersionInfo',
      'RealTimeProtectionEnabled',
    ])
      expect(env, fact).toContain(fact);
    expect(env).not.toMatch(
      /\$env:|Get-ChildItem env|\bdir env:|printenv|GetEnvironmentVariable|\bset\b\s*$/imu,
    );
    expect(all.indexOf(env)).toBeLessThan(all.findIndex((s) => /run-capped\.ps1/u.test(s)));
  });

  it('runs run-capped.ps1 in pwsh with the cap in the step env only, then merges, then uploads', () => {
    const run = find(/run-capped\.ps1/u)!;
    expect(run).toMatch(/shell: pwsh\n/u);
    expect(run).toMatch(/env:\n\s+CAP: \$\{\{ matrix\.cap \}\}\n/u);
    // a block scalar: a plain scalar that starts with '&' is a YAML anchor, not the PowerShell call operator
    expect(run).toMatch(
      /run: \|\n\s+& \.\/scripts\/win\/run-capped\.ps1 -Cap \$env:CAP -OutDir bench-out\n/u,
    );
    expect(run).not.toMatch(/run: &/u);
    const merge = find(/bench-emulated-merge\.mjs/u)!;
    expect(merge).toMatch(/if: always\(\)/u);
    expect(merge).toMatch(/--summary bench-out\/job-summary\.json/u);
    const upload = find(/actions\/upload-artifact@/u)!;
    expect(all.indexOf(merge)).toBeGreaterThan(all.indexOf(run));
    expect(all.indexOf(upload)).toBeGreaterThan(all.indexOf(merge));
  });

  it('uploads the results with if: always(), seven-day retention, an error when nothing exists, no hidden files, named by cap and commit', () => {
    const up = find(/actions\/upload-artifact@/u)!;
    expect(up).toMatch(/^\s+if: always\(\)$/mu);
    expect(up).toMatch(/name: bench-windows-\$\{\{ matrix\.cap \}\}-\$\{\{ github\.sha \}\}\n/u);
    expect(up).toMatch(/path: bench-out\/\n/u);
    expect(up).toMatch(/retention-days: 7\n/u);
    expect(up).toMatch(/if-no-files-found: error\n/u);
    expect(up).toMatch(/include-hidden-files: false\n/u);
    // it is the last step: nothing runs after the upload that could be skipped
    expect(all.at(-1)).toBe(up);
  });

  it('writes both CSVs, the log, env.txt, job-summary.json and job-membership.jsonl into bench-out (the files run-capped.ps1 writes)', () => {
    const ps1 = readFileSync(join(__dirname, '..', 'scripts', 'win', 'run-capped.ps1'), 'utf8');
    for (const f of [
      'e2e-emulated-win-vm.csv',
      'e2e-emulated-win-vm-questions.csv',
      'bench.log',
      'job-summary.json',
      'job-membership.jsonl',
    ])
      expect(ps1, f).toContain(f);
  });

  it('no step reads a secret, an input or the event payload, and none installs anything but from the lockfile', () => {
    expect(text).not.toMatch(/secrets\.|inputs\.|github\.event\.|GITHUB_TOKEN/u);
    expect(text).not.toMatch(
      /npm (install|i)\b|pip install|choco |winget |Invoke-WebRequest|curl /u,
    );
  });
});

// The first dispatch (run 44651054609) failed on all four legs at `sha256sum --binary --check`: GNU sha256sum refuses --binary and --text with --check. The macOS sha256sum
// accepts them, which is why nothing caught it here. This runs the check line of the workflow, word for word, on the sha256sum of the machine the tests run on: on the
// ubuntu leg of CI that is GNU, on the windows leg it is the one in Git for Windows (the very program of the bench job). Where there is no sha256sum the test is skipped.
describe('bench-windows.yml: the checksum check line runs for real', () => {
  const text = wf('bench-windows.yml');
  const probe = spawnSync('sha256sum', ['--version'], { encoding: 'utf8' });
  const have = probe.error === undefined && probe.status === 0;
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

  it.skipIf(!have)(
    'accepts the sums the build step writes (binary lines with a star), refuses a changed byte, and refuses --binary together with --check on a GNU sha256sum',
    { timeout: SPAWN_TEST_TIMEOUT_MS },
    () => {
      const line = /^\s+(sha256sum --check[^\n]*)$/mu.exec(text);
      expect(line, 'the check line').not.toBeNull();
      const checkArgs = line![1]!.trim().split(/\s+/u).slice(1);
      expect(checkArgs).toEqual(['--check', '--strict', '--quiet', 'dist-SHA256SUMS']);

      const dir = mkdtempSync(join(tmpdir(), 'dockit-sums-'));
      mkdirSync(join(dir, 'dist', 'sub'), { recursive: true });
      const files: [string, Buffer][] = [
        ['dist/a.txt', Buffer.from('line one\r\nline two\r\n')], // CRLF bytes: the case a text-mode read would change
        ['dist/sub/b.bin', Buffer.from([0, 1, 2, 13, 10, 255, 254, 26])],
      ];
      for (const [name, bytes] of files) writeFileSync(join(dir, name), bytes);
      // the build step's lines: '<hash> *<path>', LF endings, sorted
      const sums = files.map(([name, bytes]) => `${sha(bytes)} *${name}\n`).join('');
      writeFileSync(join(dir, 'dist-SHA256SUMS'), sums);

      const run = (args: string[]) => spawnSync('sha256sum', args, { cwd: dir, encoding: 'utf8' });
      const ok = run(checkArgs);
      expect({ status: ok.status, failed: /FAILED/u.test(ok.stderr + ok.stdout) }).toEqual({
        status: 0,
        failed: false,
      });

      writeFileSync(
        join(dir, 'dist', 'sub', 'b.bin'),
        Buffer.from([0, 1, 2, 13, 10, 255, 254, 27]),
      );
      expect(run(checkArgs).status).toBe(1);

      // what the workflow said before: on a GNU sha256sum this is a usage error whatever the files hold (the macOS one does not care, so only the GNU one is asserted)
      if (/GNU coreutils/u.test(probe.stdout)) {
        writeFileSync(join(dir, 'dist', 'sub', 'b.bin'), files[1]![1]);
        const old = run(['--binary', ...checkArgs]);
        expect(old.status).not.toBe(0);
        expect(old.stderr).toMatch(/meaningless when verifying checksums/u);
      }
    },
  );
});

// The pwsh steps of the workflow were written before they had run on Windows (they have since, three dispatches). PowerShell's own parser (pwsh is preinstalled on every GitHub runner and on the developer's Mac) reads each
// of them; where there is no pwsh the test is skipped. A parse is not a run, but it catches the quoting and syntax mistakes that would end a leg at once.
describe('bench-windows.yml: every pwsh step parses', () => {
  const text = wf('bench-windows.yml');
  const bench = jobs(text)['bench']!;
  const blocks = steps(bench)
    .filter((s) => /^\s+shell: pwsh$/mu.test(s))
    .map((s) => /^ {8}run: \|\n((?: {10}.*(?:\n|$)|\n)*)/mu.exec(s)?.[1] ?? '');

  it('there are two pwsh steps, each with a body', () => {
    expect(blocks.length).toBe(2);
    for (const b of blocks) expect(b.trim().length).toBeGreaterThan(20);
  });

  it.skipIf(!hasPwsh())(
    'each pwsh run block parses without an error',
    { timeout: SPAWN_TEST_TIMEOUT_MS },
    () => {
      for (const b of blocks) {
        const body = b.replace(/^ {10}/gmu, '');
        expect(pwshParseErrors(body)).toEqual([]);
      }
    },
  );
});
