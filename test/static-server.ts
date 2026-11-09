import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/**
 * Minimal static server bound to 127.0.0.1 only, shared by the Playwright specs. It serves
 * exactly the files under `dir`: a directory URL maps to its index.html and anything else that
 * is not a file is a 404, so serving `<tmp>` with dist/ copied to `<tmp>/dockit/` yields a
 * server that answers only under /dockit/ (the GitHub Pages sub-path shape).
 */
export function serveStatic(dir: string, port: number): Promise<Server> {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    const rel = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
    const file = normalize(join(root, rel));
    if (!file.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    let body: Buffer;
    try {
      body = readFileSync(file);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok(server));
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((r) => server.close(() => r()));
}
