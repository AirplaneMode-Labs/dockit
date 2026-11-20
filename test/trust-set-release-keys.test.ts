import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRUST_ROOT } from '../src/deps/stub/trust-root.ts';

// R4 (spec 0.6.1, S1-127): a release key signs only -release ids and is never placed in an application trust set. dockit's application trust set is the
// one key compiled into the build (src/generated/trust-root.ts, written per build by runtime's bundle-models.mjs; the stub's all-zero key in a lone
// checkout). A docs/release-keys.json fixture, wherever one is committed, must share no keyId with it.
const root = join(import.meta.dirname, '..');

const HEX64 = /\b[0-9a-f]{64}\b/gu;
/** Every keyId named by a release-keys file ({"spec":..., "keys":[{"keyId":..., "publicKey":...}]}). */
const releaseKeyIds = (text: string): string[] => {
  const j = JSON.parse(text) as { keys?: { keyId?: unknown }[] };
  return (j.keys ?? []).map((k) => String(k.keyId));
};
const overlap = (a: string[], b: string[]): string[] => a.filter((x) => b.includes(x));

function applicationKeyIds(): string[] {
  const ids = [TRUST_ROOT.keyId];
  const generated = join(root, 'src', 'generated', 'trust-root.ts');
  if (existsSync(generated)) ids.push(...(readFileSync(generated, 'utf8').match(HEX64) ?? []));
  return ids;
}

function releaseKeyFiles(): string[] {
  const out: string[] = [];
  const skip = new Set([
    'node_modules',
    'dist',
    'vendor',
    'deps',
    '.git',
    'public',
    'playwright-report',
    'test-results',
  ]);
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      if (skip.has(n)) continue;
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n === 'release-keys.json' || n.endsWith('.release-keys.json')) out.push(p);
    }
  };
  walk(root);
  return out;
}

describe('R4: no release key is in the application trust set', () => {
  it('the application trust set holds at least one keyId (the stub key in a lone checkout)', () => {
    expect(applicationKeyIds().length).toBeGreaterThanOrEqual(1);
    for (const id of applicationKeyIds()) expect(id).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('shares no keyId with any committed release-keys.json', () => {
    const app = applicationKeyIds();
    for (const f of releaseKeyFiles())
      expect(overlap(app, releaseKeyIds(readFileSync(f, 'utf8'))), f).toEqual([]);
  });

  it('the check is not vacuous: a release-keys file that holds the application keyId is caught, one with another key is not', () => {
    const app = applicationKeyIds();
    const same = JSON.stringify({
      spec: 'airplanemode.release-keys/0.1',
      keys: [{ keyId: app[0], publicKey: 'x' }],
    });
    const other = JSON.stringify({
      spec: 'airplanemode.release-keys/0.1',
      keys: [{ keyId: 'a'.repeat(64), publicKey: 'x' }],
    });
    expect(overlap(app, releaseKeyIds(same))).toEqual([app[0]]);
    expect(overlap(app, releaseKeyIds(other))).toEqual([]);
    expect(
      overlap(app, releaseKeyIds('{"spec":"airplanemode.release-keys/0.1","keys":[]}')),
    ).toEqual([]);
  });

  it('the application trust set is compiled in and exports exactly one key (dockit never loads a trust set at run time)', () => {
    const trust = readFileSync(join(root, 'src', 'trust.ts'), 'utf8');
    expect(trust).toMatch(/Exactly one trusted key/u);
    expect(trust).not.toMatch(/release-keys|allowTestKeys|trust-test-key|fetch\(/u);
  });
});
