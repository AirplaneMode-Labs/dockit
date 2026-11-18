import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const wf = (name: string) =>
  readFileSync(join(__dirname, '..', '.github', 'workflows', name), 'utf8');

/** The CI conventions table (sprint-4-notes.md, carried as written): action -> [full SHA, tag]. */
const PINS: Record<string, [string, string]> = {
  'actions/checkout': ['3d3c42e5aac5ba805825da76410c181273ba90b1', 'v7.0.1'],
  'actions/setup-node': ['949feb2413d6458794dcd2491c4babbbce0c15c1', 'v7.1.0'],
  'actions/setup-python': ['6d4fd22b20465ccc0f7354476588e8df7c9ca0e0', 'v7.1.0'],
  'actions/cache': ['55cc8345863c7cc4c66a329aec7e433d2d1c52a9', 'v6.1.0'],
  'actions/configure-pages': ['45bfe0192ca1faeb007ade9deae92b16b8254a0d', 'v6.0.0'],
  'actions/upload-pages-artifact': ['fc324d3547104276b827a68afc52ff2a11cc49c9', 'v5.0.0'],
  'actions/deploy-pages': ['368f82528645a54fb793d4d04e342629a3f51346', 'v5.0.1'],
  'dtolnay/rust-toolchain': ['683b588c487a69d01f6c6ddf40f036ff682cc2c8', 'v1'],
  'Swatinem/rust-cache': ['d1527c8f67ef9af357290475d4af4b0fab8f12e0', 'v2.9.3'],
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

describe.each(['ci.yml', 'pages.yml'])('%s', (file) => {
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
