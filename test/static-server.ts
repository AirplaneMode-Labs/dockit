// The static server lives in scripts/lib/ (plain ESM) so the benchmark script can run it with plain node; the specs import it from here.
export { serveStatic, closeServer, type ServeOptions } from '../scripts/lib/static-server.mjs';
