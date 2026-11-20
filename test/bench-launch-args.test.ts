import { readFileSync, readdirSync, statSync } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { launchArgs, launchOptions } from '../scripts/lib/e2e-harness.mjs';
import { closeServer, serveStatic } from '../scripts/lib/static-server.mjs';
import { SPAWN_TEST_TIMEOUT_MS } from './helpers/timeouts.ts';

// S1 (B6 hardening): the benchmark and the Playwright specs drive installed Chrome with its sandbox and site isolation intact, and serve the app from
// 127.0.0.1 only. A flag that weakens either would make a figure unrepresentative and the offline proof weaker.
const root = join(import.meta.dirname, '..');
vi.setConfig({ testTimeout: SPAWN_TEST_TIMEOUT_MS });
const FORBIDDEN = [
  '--no-sandbox',
  '--disable-web-security',
  '--disable-site-isolation-trials',
  '--allow-file-access-from-files',
  '--remote-debugging-address',
  '--disable-features=IsolateOrigins',
  '--disable-setuid-sandbox',
  '--disable-gpu-sandbox',
  '--ignore-certificate-errors',
  '--disable-extensions-except',
];

describe('the Playwright launch arguments', () => {
  it.each([true, false])('contain none of the sandbox-weakening flags (watch %s)', (watch) => {
    const args = launchArgs({ watch });
    expect(args).toContain('--enable-precise-memory-info');
    for (const f of FORBIDDEN)
      expect(
        args.some((a: string) => a.startsWith(f)),
        f,
      ).toBe(false);
  });

  it('the debugging port is opened only when the request ledger is on, on a port Chrome picks, and never with a remote address', () => {
    expect(launchArgs({ watch: true })).toContain('--remote-debugging-port=0');
    expect(
      launchArgs({ watch: false }).some((a: string) => a.startsWith('--remote-debugging')),
    ).toBe(false);
  });

  it("the launch options keep Chrome's sandbox on when asked (Playwright adds --no-sandbox itself unless chromiumSandbox is true), and the emulated run asks for it", () => {
    expect(launchOptions({ sandbox: true }).chromiumSandbox).toBe(true);
    expect(launchOptions({ sandbox: false }).chromiumSandbox).toBe(false);
    expect(launchOptions({}).chromiumSandbox).toBe(false); // the local default is unchanged: the committed macOS figures stay comparable
    expect(launchOptions({ sandbox: true }).channel).toBe('chrome');
    expect(launchOptions({ sandbox: true }).args).toEqual(launchArgs({ watch: true }));
    const bench = readFileSync(join(root, 'scripts', 'bench-e2e.mjs'), 'utf8');
    expect(bench).toMatch(/sandbox: EMULATED/u);
  });

  it('no script or spec in the repository names a forbidden flag (this file excepted)', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(m?[jt]s|ps1|ya?ml)$/u.test(n)) files.push(p);
      }
    };
    for (const d of ['scripts', 'test', '.github']) walk(join(root, d));
    expect(files.length).toBeGreaterThan(10);
    const offenders = files
      .filter(
        (f) =>
          !/(bench-launch-args\.test|win-jobobject-text\.test|failfast-crash\.spec)\.ts$/u.test(f),
      )
      .filter((f) => FORBIDDEN.some((flag) => readFileSync(f, 'utf8').includes(flag)))
      .map((f) => f.slice(root.length + 1));
    expect(offenders).toEqual([]);
  });
});

describe('the static server binds 127.0.0.1 only', () => {
  it('listens on the loopback address', async () => {
    const server = await serveStatic(join(root, 'test', 'fixtures'), 0, { prefix: '/dockit/' });
    try {
      const a = server.address() as { address: string; port: number };
      expect(a.address).toBe('127.0.0.1');
      const status = await new Promise<number>((res, rej) => {
        const r = request(
          { host: '127.0.0.1', port: a.port, path: '/other', method: 'GET' },
          (m) => {
            m.resume();
            res(m.statusCode ?? 0);
          },
        );
        r.on('error', rej);
        r.end();
      });
      expect(status).toBe(404); // the sub-path shape: anything outside /dockit/ is a 404
    } finally {
      await closeServer(server);
    }
  });

  it('is not reachable on a non-loopback interface address of this machine', async () => {
    const server = await serveStatic(join(root, 'test', 'fixtures'), 0);
    try {
      const a = server.address() as { port: number };
      const others = Object.values(os.networkInterfaces())
        .flat()
        .filter((i) => i !== undefined && i.family === 'IPv4' && !i.internal)
        .map((i) => i!.address);
      for (const host of others.slice(0, 2)) {
        const refused = await new Promise<boolean>((res) => {
          const r = request(
            { host, port: a.port, path: '/', method: 'GET', timeout: 2000 },
            (m) => {
              m.resume();
              res(false);
            },
          );
          r.on('error', () => res(true));
          r.on('timeout', () => (r.destroy(), res(true)));
          r.end();
        });
        expect(refused, `${host} must not answer`).toBe(true);
      }
    } finally {
      await closeServer(server);
    }
  });

  it('the source listens with the literal loopback address and names no wildcard address', () => {
    const src = readFileSync(join(root, 'scripts', 'lib', 'static-server.mjs'), 'utf8');
    expect(src).toMatch(/listen\(port, '127\.0\.0\.1'/u);
    expect(src).not.toMatch(/0\.0\.0\.0|'::'|listen\(port\)/u);
  });
});
