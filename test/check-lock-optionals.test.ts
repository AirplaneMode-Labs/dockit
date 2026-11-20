import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { checkLock, REQUIRED_TRIPLES } from '../scripts/check-lock-optionals.mjs';
import { SPAWN_TEST_TIMEOUT_MS } from './helpers/timeouts.ts';

// B5 (TD-112): a Dependabot bump of the build tools is applied only with the lockfile still hash-pinned, every native optional package present for the three
// platforms this lab builds and runs on, and no install script that nobody accepted. This is the check, run by the tests on the real lockfile.
const root = join(import.meta.dirname, '..');
vi.setConfig({ testTimeout: SPAWN_TEST_TIMEOUT_MS });
const real = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const allow = JSON.parse(
  readFileSync(join(root, 'scripts', 'lock-install-scripts.allow.json'), 'utf8'),
);

const pkg = (resolved: string, extra: Record<string, unknown> = {}) => ({
  version: '1.0.0',
  resolved,
  integrity: `sha512-${'A'.repeat(86)}==`,
  ...extra,
});
const family = (
  scope: string,
  base: string,
  triples: string[],
  extra: Record<string, unknown> = {},
) =>
  Object.fromEntries(
    triples.map((t) => [
      `node_modules/${scope}/${base}-${t}`,
      pkg(`https://registry.npmjs.org/${scope}/${base}-${t}/-/${base}-${t}-1.0.0.tgz`, {
        optional: true,
        os: [t.split('-')[0]],
        cpu: [t.split('-')[1]],
        ...extra,
      }),
    ]),
  );
const lockOf = (packages: Record<string, unknown>) => ({
  lockfileVersion: 3,
  packages: { '': {}, ...packages },
});
const FULL = ['linux-x64-gnu', 'darwin-arm64', 'win32-x64-msvc', 'linux-arm64-gnu'];

describe('check-lock-optionals: the rules', () => {
  it('names the three required triples: linux-x64-gnu, darwin-arm64 and win32-x64-msvc', () => {
    expect([...REQUIRED_TRIPLES]).toEqual(['linux-x64-gnu', 'darwin-arm64', 'win32-x64-msvc']);
  });

  it('passes a lock whose native family has all three, each with resolved and integrity', () => {
    const r = checkLock(lockOf(family('@rolldown', 'binding', FULL)), { allowed: [] });
    expect(r.problems).toEqual([]);
  });

  it.each(REQUIRED_TRIPLES)('fails a family that lacks %s', (missing) => {
    const have = FULL.filter((t) => t !== missing);
    const r = checkLock(lockOf(family('@rolldown', 'binding', have)), { allowed: [] });
    expect(r.problems.join('\n')).toContain(missing);
  });

  it('fails a native optional with no integrity, and one with no resolved URL, and one resolved outside the registry', () => {
    const base = family('@rolldown', 'binding', FULL);
    const noIntegrity = structuredClone(base) as Record<string, any>;
    delete noIntegrity['node_modules/@rolldown/binding-darwin-arm64'].integrity;
    expect(checkLock(lockOf(noIntegrity), { allowed: [] }).problems.join('\n')).toMatch(
      /darwin-arm64[^\n]*integrity/u,
    );
    const noResolved = structuredClone(base) as Record<string, any>;
    delete noResolved['node_modules/@rolldown/binding-win32-x64-msvc'].resolved;
    expect(checkLock(lockOf(noResolved), { allowed: [] }).problems.join('\n')).toMatch(
      /win32-x64-msvc[^\n]*resolved/u,
    );
    const elsewhere = structuredClone(base) as Record<string, any>;
    elsewhere['node_modules/@rolldown/binding-linux-x64-gnu'].resolved =
      'https://example.invalid/x.tgz';
    expect(checkLock(lockOf(elsewhere), { allowed: [] }).problems.join('\n')).toMatch(
      /linux-x64-gnu[^\n]*registry/u,
    );
  });

  it('fails an ordinary package with a resolved URL and no integrity (the lock must stay hash-pinned everywhere)', () => {
    const l = lockOf({
      'node_modules/left-pad': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz',
      },
    });
    expect(checkLock(l, { allowed: [] }).problems.join('\n')).toMatch(/left-pad[^\n]*integrity/u);
  });

  it('fails an install-script entry that is not on the accepted list, and passes one that is', () => {
    const l = lockOf({
      'node_modules/shiny': pkg('https://registry.npmjs.org/shiny/-/shiny-1.0.0.tgz', {
        hasInstallScript: true,
      }),
    });
    expect(checkLock(l, { allowed: [] }).problems.join('\n')).toMatch(/shiny[^\n]*install script/u);
    expect(checkLock(l, { allowed: [{ name: 'shiny', accepted: 'S1, test' }] }).problems).toEqual(
      [],
    );
  });

  it('a single-platform optional (fsevents, macOS only) is not asked for the other platforms', () => {
    const l = lockOf({
      'node_modules/fsevents': pkg('https://registry.npmjs.org/fsevents/-/fsevents-2.3.3.tgz', {
        optional: true,
        os: ['darwin'],
      }),
    });
    expect(checkLock(l, { allowed: [] }).problems).toEqual([]);
  });

  it('a platform a family does not ship is accepted only by name, with a reason, and the other platforms are still required', () => {
    const l = lockOf(family('@img', 'libvips', ['linux-x64-gnu', 'darwin-arm64']));
    const accepted = [
      { family: '@img/libvips', triple: 'win32-x64-msvc', reason: 'bundled in the main package' },
    ];
    expect(checkLock(l, { allowed: [] }).problems.join('\n')).toContain('win32-x64-msvc');
    expect(checkLock(l, { allowed: [], missingAccepted: accepted }).problems).toEqual([]);
    const lacking = lockOf(family('@img', 'libvips', ['linux-x64-gnu', 'linux-arm64-gnu']));
    expect(
      checkLock(lacking, { allowed: [], missingAccepted: accepted }).problems.join('\n'),
    ).toContain('darwin-arm64');
  });

  it('a scoped family whose members are only a platform (@esbuild/darwin-arm64) is a family too, and a missing platform of it fails', () => {
    const mk = (t: string) =>
      [
        `node_modules/@esbuild/${t}`,
        pkg(`https://registry.npmjs.org/@esbuild/${t}/-/${t}-1.0.0.tgz`, {
          optional: true,
          os: [t.split('-')[0]],
          cpu: [t.split('-')[1]],
        }),
      ] as const;
    const ok = lockOf(
      Object.fromEntries(['linux-x64', 'darwin-arm64', 'win32-x64', 'linux-arm64'].map(mk)),
    );
    expect(checkLock(ok, { allowed: [] })).toEqual({ problems: [], families: ['@esbuild'] });
    const bad = lockOf(Object.fromEntries(['linux-x64', 'darwin-arm64', 'linux-arm64'].map(mk)));
    expect(checkLock(bad, { allowed: [] }).problems.join('\n')).toContain('win32-x64-msvc');
  });

  it('reports the families it checked, so a lock with no native optional at all is visible, not silently passed', () => {
    const r = checkLock(lockOf(family('@rolldown', 'binding', FULL)), { allowed: [] });
    expect(r.families).toEqual(['@rolldown/binding']);
    expect(checkLock(lockOf({}), { allowed: [] }).families).toEqual([]);
  });
});

describe('the real package-lock.json', () => {
  it('passes the check against the accepted install-script list', () => {
    const r = checkLock(real, {
      allowed: allow.accepted,
      missingAccepted: allow.missingPlatformsAccepted,
    });
    expect(r.problems).toEqual([]);
    expect(r.families.length).toBeGreaterThan(0);
  });

  it('every accepted install-script entry names who accepted it and why, and no entry is stale (each is still in the lock)', () => {
    for (const a of allow.accepted) {
      expect(a.accepted, a.name).toMatch(/\S/u);
      expect(
        Object.keys(real.packages).some((k: string) => k.endsWith(`node_modules/${a.name}`)),
        `${a.name} is accepted but not in the lock`,
      ).toBe(true);
    }
  });

  it('the CLI exits 0 on the real lock and 1 on a lock with a problem', () => {
    const run = (args: string[]) =>
      spawnSync(process.execPath, [join(root, 'scripts', 'check-lock-optionals.mjs'), ...args], {
        encoding: 'utf8',
      });
    expect(run([]).status).toBe(0);
    expect(run(['--lock', join(root, 'package.json')]).status).toBe(1);
  });

  it('.npmrc still disables install scripts, so an accepted install script never runs on npm ci', () => {
    expect(readFileSync(join(root, '.npmrc'), 'utf8')).toMatch(/ignore-scripts=true/u);
  });
});

// TD-112, D5-05: the Dependabot decisions for the build tools, pinned so a later change is a decision. Applied: vite 8.3.8 and @vitejs/plugin-react 6.3.0 (plugin-react 6
// needs vite 8). Deferred: vitest 5.1.0 (npm 10.9.8 crashes while resolving its peers, "Cannot read properties of null (reading 'edgesOut')"), typescript 7.0.2 and
// @types/node 26.6.6 (TD-112). The Node floor follows the new tools: vite 8, plugin-react 6 and (when it comes) vitest 5 need Node 22.12 or newer.
describe('the Dependabot decisions of Sprint 7 (D5-05)', () => {
  const pkgJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  it('applies vite 8.3.8 and @vitejs/plugin-react 6.3.0 with exact pins, in the lock too', () => {
    expect(pkgJson.devDependencies.vite).toBe('8.3.8');
    expect(pkgJson.devDependencies['@vitejs/plugin-react']).toBe('6.3.0');
    expect(real.packages['node_modules/vite'].version).toBe('8.3.8');
    expect(real.packages['node_modules/@vitejs/plugin-react'].version).toBe('6.3.0');
  });
  it('defers vitest 5.1.0, typescript 7.0.2 and @types/node 26.6.6: the pins are unchanged', () => {
    expect(pkgJson.devDependencies.vitest).toBe('4.1.12');
    expect(pkgJson.devDependencies.typescript).toBe('5.9.3');
    expect(pkgJson.devDependencies['@types/node']).toBe('22.20.5');
  });
  it('the Node floor in package.json is at least the floor of vite 8 and plugin-react 6 (22.12), and the README says so', () => {
    expect(pkgJson.engines.node).toBe('>=22.12');
    for (const name of ['vite', '@vitejs/plugin-react']) {
      const e = real.packages[`node_modules/${name}`].engines.node as string;
      expect(e, name).toContain('>=22.12.0');
    }
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('Node 22.12 or newer');
  });
  it('the rolldown native bindings of vite 8 are in the lock for the three platforms, each with resolved and integrity', () => {
    for (const t of ['linux-x64-gnu', 'darwin-arm64', 'win32-x64-msvc']) {
      const p = real.packages[`node_modules/@rolldown/binding-${t}`];
      expect(p, t).toBeDefined();
      expect(p.resolved).toMatch(/^https:\/\/registry\.npmjs\.org\//u);
      expect(p.integrity).toMatch(/^sha512-/u);
    }
  });
});
