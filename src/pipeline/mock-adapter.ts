import {
  AdapterError,
  type AssetSource,
  type BackendAdapter,
  type ChatMessage,
  type EmbedResult,
  type GenerateOptions,
  type GenerateResult,
  type LoadOptions,
} from '../contracts/backend-adapter.ts';
import {
  BACKEND_TIER_RANK,
  CAPABILITY_PROFILE_SPEC,
  type CapabilityProfile,
} from '../contracts/capability-profile.ts';
import type { ManifestEntry, MinProfile } from '../contracts/manifest.ts';

export const MOCK_EMBED_DIMS = 64;

/** satisfies() as specified for Manifest 0.1 MinProfile. */
export function satisfies(profile: CapabilityProfile, min: MinProfile): boolean {
  if (min.gpu !== undefined && min.gpu !== 'none' && profile.gpu !== 'webgpu') return false;
  if (min.ramGb !== undefined && profile.ramGb < min.ramGb) return false;
  if (min.storageFreeGb !== undefined && profile.storageFreeGb < min.storageFreeGb) return false;
  if (min.cores !== undefined && profile.cores < min.cores) return false;
  if (
    min.backendTier !== undefined &&
    BACKEND_TIER_RANK[profile.backendTier] < BACKEND_TIER_RANK[min.backendTier]
  ) {
    return false;
  }
  return true;
}

function fnv1a32(text: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function promptText(prompt: string | ChatMessage[]): string {
  if (typeof prompt === 'string') return prompt;
  return prompt
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n');
}

/**
 * Local copy of the runtime MockAdapter: echo generation and deterministic hashed
 * 64-dimensional embeddings. Used by the pipeline stubs; it never loads a model and never
 * touches the network.
 */
export class MockAdapter implements BackendAdapter {
  readonly id = 'mock';
  readonly tier = 'none' as const;
  readonly device = 'wasm' as const;
  #entry: ManifestEntry | null = null;

  static placeholderEntry(): ManifestEntry {
    return {
      id: 'placeholder-model',
      kind: 'model',
      url: 'assets/placeholder-model',
      sha256: '0'.repeat(64),
      size: 0,
      version: '0.0.0',
      licence: 'Apache-2.0',
      minProfile: {},
    };
  }

  static placeholderProfile(): CapabilityProfile {
    return {
      spec: CAPABILITY_PROFILE_SPEC,
      gpu: 'none',
      ramGb: 0,
      storageFreeGb: 0,
      cores: 1,
      backendTier: 'none',
      features: {
        webgpu: false,
        shaderF16: false,
        wasmSimd: false,
        wasmThreads: false,
        opfs: false,
        indexedDb: false,
        persistentStorage: false,
      },
      measuredAt: '1970-01-01T00:00:00Z',
    };
  }

  static placeholderAssets(): AssetSource {
    return {
      async getBlob(entryId) {
        throw new AdapterError(
          'backend',
          `no verified asset for ${entryId}; assets arrive in Sprint 5`,
        );
      },
      getEntry: () => MockAdapter.placeholderEntry(),
    };
  }

  static placeholderLoadOptions(): LoadOptions {
    return { assets: MockAdapter.placeholderAssets(), profile: MockAdapter.placeholderProfile() };
  }

  async available(_profile: CapabilityProfile): Promise<boolean> {
    return true;
  }

  capabilities(): { generate: boolean; embed: boolean; streaming: boolean } {
    return { generate: true, embed: true, streaming: true };
  }

  async load(entry: ManifestEntry, opts: LoadOptions): Promise<void> {
    if (!satisfies(opts.profile, entry.minProfile)) {
      throw new AdapterError('unsupported_profile', `${entry.id} needs more than this device has`);
    }
    opts.assets.getEntry(entry.id);
    this.#entry = entry;
  }

  async generate(prompt: string | ChatMessage[], opts?: GenerateOptions): Promise<GenerateResult> {
    if (this.#entry === null) throw new AdapterError('not_loaded', 'call load() first');
    if (opts?.signal?.aborted) throw new AdapterError('aborted', 'generation aborted');
    const text = `echo: ${promptText(prompt)}`;
    if (opts?.onToken) for (const token of text.split(' ')) opts.onToken(token);
    return {
      text,
      finishReason: 'stop',
      usage: { promptTokens: promptText(prompt).length, completionTokens: text.length },
      timings: { prefillMs: 0, decodeMs: 0, tokensPerSecond: 0 },
    };
  }

  async embed(texts: string[], opts?: { signal?: AbortSignal }): Promise<EmbedResult> {
    if (this.#entry === null) throw new AdapterError('not_loaded', 'call load() first');
    if (opts?.signal?.aborted) throw new AdapterError('aborted', 'embedding aborted');
    const vectors = texts.map((t) => {
      const v = new Float32Array(MOCK_EMBED_DIMS);
      let norm = 0;
      for (let i = 0; i < MOCK_EMBED_DIMS; i++) {
        const x = (fnv1a32(t, i) / 0xffffffff) * 2 - 1;
        v[i] = x;
        norm += x * x;
      }
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < MOCK_EMBED_DIMS; i++) v[i] = v[i]! / norm;
      return v;
    });
    return { vectors, dims: MOCK_EMBED_DIMS, normalized: true };
  }

  async unload(): Promise<void> {
    this.#entry = null;
  }
}
