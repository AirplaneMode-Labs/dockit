import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// T3-S5-08: package-lock.json said 0.1.0-dev while package.json said 0.2.0-dev (TD-43).
const root = join(import.meta.dirname, '..');
const json = (f: string) => JSON.parse(readFileSync(join(root, f), 'utf8')) as Record<string, any>;

describe('package-lock.json root version', () => {
  it('both root version fields equal package.json (0.2.0-dev, TD-43)', () => {
    const pkg = json('package.json');
    const lock = json('package-lock.json');
    expect(pkg.version).toBe('0.2.0-dev');
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
    expect(lock.name).toBe(pkg.name);
  });

  it('the lock records the same direct dependencies as package.json (exact versions)', () => {
    const pkg = json('package.json');
    const lock = json('package-lock.json');
    for (const kind of ['dependencies', 'devDependencies'] as const)
      expect(lock.packages[''][kind]).toEqual(pkg[kind]);
  });
});
