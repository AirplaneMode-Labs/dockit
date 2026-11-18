// STUB of runtime's worker-support entry (see ./index.ts).
const stub = (name: string) => () => {
  throw new Error(
    `dockit stub build: runtime.${name} is not available (assemble the real build with scripts/assemble-deps.mjs)`,
  );
};
export const installEgressGuard = stub('installEgressGuard');
export const startModuleWorker = stub('startModuleWorker');
