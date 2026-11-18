import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
};

// `opts.prefix` (for example '/dockit/') serves `dir` at that path and 404s everything else: the GitHub Pages sub-path shape, without
// copying the build. `opts.onRequest(pathname, status)` is called for every request answered (404s included).
/**
 * Minimal static server bound to 127.0.0.1 only, shared by the Playwright specs. It serves exactly the files under `dir`: a directory
 * URL maps to its index.html and anything else that is not a file is a 404. Files are streamed and Range requests are answered with
 * 206, as GitHub Pages does, because the model download resumes with Range.
 */
export function serveStatic(dir, port, opts = {}) {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    const done = (status, headers = {}) => {
      opts.onRequest?.(pathname, status);
      res.writeHead(status, headers);
    };
    let pathname = '/';
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    } catch {
      done(400);
      res.end();
      return;
    }
    let rel = pathname;
    if (opts.prefix !== undefined) {
      if (!pathname.startsWith(opts.prefix)) {
        done(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      rel = `/${pathname.slice(opts.prefix.length)}`;
    }
    rel = rel.endsWith('/') ? `${rel}index.html` : rel;
    const file = normalize(join(root, rel));
    if (!file.startsWith(root + sep)) {
      done(403);
      res.end();
      return;
    }
    let size;
    try {
      const st = statSync(file);
      if (!st.isFile()) throw new Error('not a file');
      size = st.size;
    } catch {
      done(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const type = MIME[extname(file)] ?? 'application/octet-stream';
    const range = /^bytes=(\d*)-(\d*)$/u.exec(req.headers.range ?? '');
    if (range !== null && (range[1] !== '' || range[2] !== '')) {
      const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
      const end =
        range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
      if (start > end || start >= size) {
        done(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      done(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      });
      if (req.method === 'HEAD') res.end();
      else createReadStream(file, { start, end }).pipe(res);
      return;
    }
    done(200, {
      'Content-Type': type,
      'Content-Length': size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok(server));
  });
}

export function closeServer(server) {
  return new Promise((r) => server.close(() => r()));
}
