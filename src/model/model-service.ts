import type { EventSink } from '../contracts/event.ts';
import { MANIFEST_ID_PATTERN } from './manifest-id.ts';
import { memoryLineOf } from './entries.ts';
import type { EngineKind, LoadedEngine } from './model-pool.ts';
import { assessMemory, memoryRefusalMessage } from '../pipeline/memory-line.ts';
import { mapAdapterError } from '../pipeline/pipeline.ts';
import { Refusal, isRefusal } from '../pipeline/reasons.ts';

export type { EngineKind, LoadedEngine };

/** The size cap on a manifest document, fetched or stored. The dockit bundle's manifest is a few KiB. */
export const MANIFEST_MAX_BYTES = 1024 * 1024;
/** The pause before the one retry of an engine load that failed with the code 'backend'. */
export const LOAD_RETRY_PAUSE_MS = 1500;

export interface ManifestEntryLike {
  id: string;
  url: string;
  size: number;
  sha256: string;
  kind: string;
  pin?: boolean;
  /** The signed minimum profile of this entry (manifest 0.1.x). minProfile.ramGb of the answer entry is the memory line. */
  minProfile?: { ramGb?: number; [k: string]: unknown };
}

export interface ManifestLike {
  id?: string;
  entries: ManifestEntryLike[];
}

export interface AssetsPort {
  /** runtime AssetManager.loadManifest: verifies the signature against the trust set and the expected id. */
  loadManifest(
    manifest: unknown,
    trust: ReadonlyMap<string, Uint8Array>,
    opts: { baseUrl: string },
  ): Promise<unknown>;
  ensure(
    entryId: string,
    opts?: { signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void },
  ): Promise<unknown>;
  has(entryId: string): Promise<boolean>;
}

export interface DownloadProgress {
  entryId: string;
  received: number;
  total: number;
  resumedFrom: number;
}

export interface ManifestStorePort {
  get(manifestId: string): Promise<Uint8Array | undefined>;
  put(manifestId: string, bytes: Uint8Array): Promise<void>;
  delete(manifestId: string): Promise<void>;
}

export interface ModelServiceDeps {
  /** Required: the manifest id this app accepts ('dev.airplanemode.dockit-models'). The service throws at start without it. */
  expectManifestId: string;
  /** document.baseURI */
  baseURI: string;
  online(): boolean;
  /** GET <base>models/manifest.json, same origin. */
  fetchManifestBytes(): Promise<Uint8Array>;
  manifests: ManifestStorePort;
  assets: AssetsPort;
  /** The trust root compiled into the build (src/generated/trust-root.ts). Never fetched. */
  trust: ReadonlyMap<string, Uint8Array>;
  events: EventSink;
  /**
   * Builds ONE engine adapter (B1 M1: never two at a time) over the verified assets, a first load every time. With cacheOnly nothing is
   * downloaded: a cache miss is a refusal, never a fetch.
   */
  loadAdapter(
    kind: EngineKind,
    manifest: ManifestLike,
    assets: AssetsPort,
    opts: { cacheOnly: boolean },
  ): Promise<LoadedEngine>;
  /**
   * The runtime capability profile (ramGb 0 means the browser does not report its memory). Optional: without it there is no memory line.
   * A rejection is no verdict (nothing is refused).
   */
  profile?(): Promise<{ ramGb: number }>;
}

const refuse = (reason: string, message: string): Refusal =>
  new Refusal('manifest_refused', `The model files were refused: ${message}.`, { reason });

/**
 * Every resolved entry URL must stay under the app's own models/ path: the origin (github.io) is shared with other
 * projects, so an allowed-origin check alone would let a manifest point into a sibling project's files. Lexical rules
 * first (a backslash or a '..' segment is refused outright, S1-097), then the resolved URL against the models/ URL.
 */
export function assertEntriesUnderModels(manifest: { entries?: unknown }, baseURI: string): void {
  const entries = manifest?.entries;
  if (!Array.isArray(entries) || entries.length === 0)
    throw refuse('entries', 'the list of files is missing');
  const base = new URL('models/', baseURI);
  for (const e of entries) {
    const url = (e as { url?: unknown } | null)?.url;
    if (typeof url !== 'string' || url === '') throw refuse('path_prefix', 'a file has no address');
    // eslint-disable-next-line no-control-regex
    if (
      /[\\\u0000-\u001f\u007f]/u.test(url) ||
      url.startsWith('/') ||
      /^[a-z][a-z0-9+.-]*:/iu.test(url) ||
      /[?#]/u.test(url)
    ) {
      throw refuse('path_prefix', 'a file address is not a plain relative path');
    }
    for (const seg of url.split('/')) {
      let decoded = seg;
      try {
        decoded = decodeURIComponent(seg);
      } catch {
        throw refuse('path_prefix', 'a file address is not valid');
      }
      if (decoded === '..' || decoded === '.' || decoded.includes('/') || decoded.includes('\\'))
        throw refuse('path_prefix', 'a file address leaves the models folder');
    }
    const resolved = new URL(url, base);
    if (
      resolved.origin !== base.origin ||
      !resolved.pathname.startsWith(base.pathname) ||
      resolved.search !== '' ||
      resolved.hash !== ''
    ) {
      throw refuse('path_prefix', 'a file address is outside the models folder');
    }
  }
}

export interface ModelService {
  /** Online only: fetch the manifest, verify it, download every file, then store the verified manifest bytes. */
  download(opts: {
    signal?: AbortSignal;
    onProgress?: (p: DownloadProgress) => void;
  }): Promise<void>;
  /**
   * Re-verify the stored manifest bytes (S-OFF-1), check the memory line against the verified manifest, and load ONE engine from the cache
   * only. Every call is a first load (R19): nothing is remembered between calls.
   */
  load(kind: EngineKind): Promise<LoadedEngine & { manifest: ManifestLike }>;
  /** The memory line, minProfile.ramGb of the answer entry of the verified manifest; undefined when there is none or no manifest verifies. */
  memoryLine(): Promise<number | undefined>;
  status(): Promise<{ cached: boolean }>;
  /** Total bytes the Download button would fetch, or undefined when it cannot be known (offline, nothing stored). */
  plannedBytes(): Promise<number | undefined>;
}

export function createModelService(deps: ModelServiceDeps): ModelService {
  if (
    typeof deps.expectManifestId !== 'string' ||
    !MANIFEST_ID_PATTERN.test(deps.expectManifestId)
  ) {
    throw new TypeError(
      'dockit: expectManifestId is required (a manifest id such as dev.airplanemode.dockit-models)',
    );
  }
  const id = deps.expectManifestId;
  const baseUrl = new URL('models/', deps.baseURI).href;

  async function verifyBytes(bytes: Uint8Array): Promise<ManifestLike> {
    if (bytes.byteLength > MANIFEST_MAX_BYTES)
      throw refuse('too_large', 'the manifest is too large');
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw refuse('parse', 'the manifest is not valid JSON');
    }
    assertEntriesUnderModels(parsed as { entries?: unknown }, deps.baseURI); // before the asset manager sees it
    try {
      await deps.assets.loadManifest(parsed, deps.trust, { baseUrl });
    } catch (e) {
      const r = (e as { reason?: unknown; code?: unknown } | null) ?? {};
      const reason =
        typeof r.reason === 'string' ? r.reason : typeof r.code === 'string' ? r.code : 'unknown';
      throw refuse(reason, `the signed list did not check out (${reason})`);
    }
    return parsed as ManifestLike;
  }

  async function fetchAndVerify(): Promise<{ bytes: Uint8Array; manifest: ManifestLike }> {
    let bytes: Uint8Array;
    try {
      bytes = await deps.fetchManifestBytes();
    } catch {
      throw new Refusal('model_not_cached'); // the network is not there: connect once and press Download
    }
    return { bytes, manifest: await verifyBytes(bytes) };
  }

  async function download(opts: {
    signal?: AbortSignal;
    onProgress?: (p: DownloadProgress) => void;
  }): Promise<void> {
    if (!deps.online()) throw new Refusal('model_not_cached');
    const { bytes, manifest } = await fetchAndVerify();
    for (const entry of manifest.entries) {
      await deps.assets.ensure(entry.id, {
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        ...(opts.onProgress === undefined ? {} : { onProgress: opts.onProgress }),
      });
    }
    await deps.manifests.put(id, bytes);
  }

  const lineOf = memoryLineOf;

  /**
   * B1 M6: below the line the load is refused with unsupported_profile, after the manifest is verified and before any model byte is read. An
   * unknown memory (ramGb 0) is not below it (TD-84), and neither is a profile that cannot be read.
   */
  async function assertMemoryLine(manifest: ManifestLike): Promise<void> {
    const required = lineOf(manifest);
    if (required === undefined || deps.profile === undefined) return;
    let ramGb: number;
    try {
      ramGb = (await deps.profile()).ramGb;
    } catch {
      return;
    }
    const v = assessMemory(ramGb, required);
    if (v.kind === 'below')
      throw new Refusal('unsupported_profile', memoryRefusalMessage(v.reportedGb, v.requiredGb));
  }

  async function memoryLine(): Promise<number | undefined> {
    try {
      let bytes = await deps.manifests.get(id);
      if (bytes === undefined) {
        if (!deps.online()) return undefined;
        bytes = (await fetchAndVerify()).bytes;
      }
      return lineOf(await verifyBytes(bytes));
    } catch {
      return undefined;
    }
  }

  async function load(kind: EngineKind) {
    let stored = await deps.manifests.get(id);
    if (stored === undefined) throw new Refusal('model_not_cached');
    let manifest: ManifestLike;
    try {
      manifest = await verifyBytes(stored);
    } catch (e) {
      if (!isRefusal(e)) throw e;
      if (!deps.online()) throw e; // offline: the stored manifest fails, so nothing is loaded
      // online: refetch, which replaces the stored bytes once the new manifest verifies. If the refetch cannot happen (the browser says online but there is no network), the
      // stored manifest's own refusal is what the user needs to hear, so it is kept.
      try {
        await download({});
      } catch (refetch) {
        if (refetch instanceof Refusal && refetch.reason === 'model_not_cached') throw e;
        throw refetch;
      }
      stored = await deps.manifests.get(id);
      manifest = await verifyBytes(stored!);
    }
    await assertMemoryLine(manifest);
    try {
      let models: LoadedEngine;
      try {
        models = await deps.loadAdapter(kind, manifest, deps.assets, { cacheOnly: true });
      } catch (first) {
        // Observed in Chrome 157: a model file that was written less than about a second ago can fail its first read by the engine (code
        // 'backend'); the same load a moment later succeeds. One more try after a pause; an integrity failure is never retried.
        if (
          (first as { name?: string; code?: string } | null)?.name !== 'AdapterError' ||
          (first as { code?: string }).code !== 'backend'
        )
          throw first;
        await new Promise((r) => setTimeout(r, LOAD_RETRY_PAUSE_MS));
        models = await deps.loadAdapter(kind, manifest, deps.assets, { cacheOnly: true });
      }
      return { ...models, manifest };
    } catch (raw) {
      const e = mapAdapterError(raw);
      if (isRefusal(e)) throw e;
      if ((raw as { name?: string; code?: string } | null)?.name === 'AssetError')
        throw new Refusal('model_not_cached');
      throw e;
    }
  }

  async function status() {
    try {
      const stored = await deps.manifests.get(id);
      if (stored === undefined) return { cached: false };
      const manifest = await verifyBytes(stored);
      for (const e of manifest.entries)
        if (!(await deps.assets.has(e.id))) return { cached: false };
      return { cached: true };
    } catch {
      return { cached: false };
    }
  }

  async function plannedBytes() {
    try {
      let bytes = await deps.manifests.get(id);
      if (bytes === undefined) {
        if (!deps.online()) return undefined;
        bytes = await deps.fetchManifestBytes();
      }
      const entries =
        (JSON.parse(new TextDecoder().decode(bytes)) as { entries?: { size?: unknown }[] })
          .entries ?? [];
      return entries.reduce((n, e) => n + (typeof e.size === 'number' ? e.size : 0), 0);
    } catch {
      return undefined;
    }
  }

  return { download, load, memoryLine, status, plannedBytes };
}
