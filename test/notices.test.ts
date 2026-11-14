import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const notices = join(root, 'public', 'THIRD-PARTY-NOTICES.txt');
const pkgs = ['react', 'react-dom', 'scheduler'];

describe('third-party notices (T3-S3-028)', () => {
  it('public/THIRD-PARTY-NOTICES.txt exists and holds each licence verbatim under a name and version heading', () => {
    expect(existsSync(notices)).toBe(true);
    const text = readFileSync(notices, 'utf8');
    for (const name of pkgs) {
      const dir = join(root, 'node_modules', name);
      const version = (
        JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }
      ).version;
      expect(text).toContain(`${name} ${version}`);
      expect(text).toContain(readFileSync(join(dir, 'LICENSE'), 'utf8').trim());
    }
  });

  it('the app links the notices file without innerHTML', () => {
    const app = readFileSync(join(root, 'src', 'App.tsx'), 'utf8');
    expect(app).toContain('THIRD-PARTY-NOTICES.txt');
    expect(app).not.toMatch(/innerHTML|dangerouslySetInnerHTML/u);
  });
});
