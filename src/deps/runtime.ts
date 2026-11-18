/**
 * dockit's typed view of the runtime build (vendor/runtime, from deps.lock.json): the main-thread parts (asset manager, engine
 * adapters, capability detection). A worker imports ./worker-support.ts instead. A stub build (DOCKIT_DEPS=stub) compiles without it.
 */
import * as rt from 'virtual:dockit-deps/runtime/index.js';

/** The whole namespace; the parts are typed where they are used (AssetManager, adapters, detectCapabilities). */
export const runtime = rt as unknown as Record<string, unknown>;
