// STUB of the runtime build: lets `npm run build:check` and CI (three OSes) type-check and bundle the app without the
// four sibling builds. Every call throws. A stub build carries a banner and is never deployed.
const stub = (name: string) => () => {
  throw new Error(
    `dockit stub build: runtime.${name} is not available (assemble the real build with scripts/assemble-deps.mjs)`,
  );
};
export const installEgressGuard = stub('installEgressGuard');
export const startModuleWorker = stub('startModuleWorker');
export const detectCapabilities = stub('detectCapabilities');
export const satisfies = stub('satisfies');
export const AssetManager = stub('AssetManager');
export const WorkerAdapter = stub('WorkerAdapter');
export const AssetError = class AssetError extends Error {};
export const sessionId = stub('sessionId');
