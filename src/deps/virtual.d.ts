// The two sibling builds the app bundle imports (TD-40). 'virtual:dockit-deps' is an alias that vite.config.ts points at
// vendor/ (assembled by scripts/assemble-deps.mjs) or, for a stub build, at src/deps/stub/. The shapes the app relies on
// are typed in src/deps/runtime.ts and src/deps/localdata.ts, not here, so a stub build and a real build type-check alike.
declare module 'virtual:dockit-deps/runtime/index.js' {
  const api: Record<string, unknown>;
  export = api;
}
declare module 'virtual:dockit-deps/runtime/backends/index.js' {
  const api: Record<string, unknown>;
  export = api;
}
declare module 'virtual:dockit-deps/runtime/worker-support.js' {
  const api: Record<string, unknown>;
  export = api;
}
declare module 'virtual:dockit-deps/localdata/index.js' {
  const api: Record<string, unknown>;
  export = api;
}
declare module 'virtual:dockit-deps/runtime/worker/engine-worker.js?worker&url' {
  const url: string;
  export default url;
}
declare module 'virtual:dockit-trust-root' {
  /** The public half of the build's ephemeral signing key: exactly one { keyId, publicKeyB64 } export. */
  const trust: Record<string, { keyId: string; publicKeyB64: string }>;
  export = trust;
}
