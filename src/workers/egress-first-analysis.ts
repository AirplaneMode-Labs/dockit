/** Imported FIRST by the analysis worker: the egress guard allows only the vendor/ folder (the two WASM builds). */
import { installEgressGuard } from '../deps/worker-support.ts';

installEgressGuard({
  allowPathPrefixes: [new URL(/* @vite-ignore */ '../vendor/', import.meta.url).pathname],
});
