import type { CapabilityProfile } from '../contracts/capability-profile.ts';
import type { EventSink } from '../contracts/event.ts';
import type { ModelService, LoadedModels, DownloadProgress } from '../model/model-service.ts';
import {
  adapterOutcome,
  createPipeline,
  isAdapterError,
  mapAdapterError,
  type Answer,
  type KeptDocument,
  type OpenedDocument,
  type Pipeline,
  type PipelineDeps,
} from '../pipeline/pipeline.ts';
import { DEFAULT_SPECIAL_TOKENS } from '../pipeline/prompt.ts';
import {
  Refusal,
  isRefusal,
  REFUSAL_MESSAGES,
  PIPELINE_STAGES,
  type PipelineReason,
  type PipelineStage,
} from '../pipeline/reasons.ts';
import { sanitiseDisplay } from '../ui/answer-text.ts';

export interface RefusalInfo {
  /** A PipelineReason, or 'failed': a plain failure that is not a documented refusal (shown as 'The answer failed.'). It never reaches an event. */
  reason: PipelineReason | 'failed';
  message: string;
  /** manifest_refused carries the verifier's reason. */
  detail?: string;
  /** no_text_layer carries per-page reasons. */
  pages?: { page: number; message: string }[];
}

export type StageStatus = 'waiting' | 'working' | 'ok' | 'refused' | 'error' | 'skipped';
export interface StageRow {
  stage: PipelineStage;
  status: StageStatus;
  ms?: number;
}

export interface AppState {
  framed: boolean;
  online: boolean;
  capability: {
    profile: CapabilityProfile | null;
    verdict: 'meets' | 'below' | 'unknown';
    note: string;
  };
  model: {
    /** cached: verified on this device, nothing loaded. loading: being loaded (reloading true after a Stop). ready: loaded in the engine workers. */
    status: 'unknown' | 'absent' | 'downloading' | 'cached' | 'loading' | 'ready' | 'refused';
    /** True while a model that a Stop ended is being loaded again from the files already on the device. */
    reloading?: boolean;
    plannedBytes: number | undefined;
    receivedBytes: number;
    totalBytes: number;
    refusal: RefusalInfo | undefined;
  };
  doc: {
    status: 'none' | 'working' | 'ready' | 'refused';
    stages: StageRow[];
    info: OpenedDocument | undefined;
    refusal: RefusalInfo | undefined;
    keep: boolean;
  };
  ask: {
    /** stopped: the user pressed Stop before the first token (a Stop after it keeps the partial text as a 'done' answer). */
    status: 'idle' | 'working' | 'done' | 'refused' | 'stopped';
    answer: Answer | undefined;
    displayText: string;
    refusal: RefusalInfo | undefined;
    streamed: string;
  };
  /** Documents the user chose to keep on this device. */
  kept: KeptDocument[];
}

export interface ControllerDeps {
  framed: boolean;
  events: EventSink & {
    subscribe(fn: (e: import('../contracts/event.ts').Event) => void): () => void;
  };
  models: ModelService;
  /** Defaults to createPipeline; tests inject a fake. */
  makePipeline?: (deps: PipelineDeps) => Pipeline;
  pipelineDeps: Omit<PipelineDeps, 'embedder' | 'generator' | 'specialTokens' | 'events'>;
  detectCapability(): Promise<{ profile: CapabilityProfile; verdict: 'meets' | 'below' }>;
  online(): boolean;
}

/** Chrome reports navigator.deviceMemory rounded to a power of two (32 on a 48 GB Mac), so the note says only that: no cap is claimed (TD-57). */
export const CAPABILITY_NOTE =
  'This is the rounded memory the browser reports (navigator.deviceMemory), not free memory.';

/** The ask card's line for a failure that is neither a documented refusal nor the user's Stop. */
export const ANSWER_FAILED_MESSAGE = 'The answer failed.';

const initialStages = (): StageRow[] =>
  PIPELINE_STAGES.filter((s) => s !== 'retrieve' && s !== 'generate').map((stage) => ({
    stage,
    status: 'waiting' as const,
  }));

export function refusalInfo(e: unknown): RefusalInfo | undefined {
  if (!isRefusal(e)) return undefined;
  const info: RefusalInfo = { reason: e.reason, message: e.message || REFUSAL_MESSAGES[e.reason] };
  const cause = (e.detail as { cause?: unknown } | undefined)?.cause;
  if (typeof cause === 'string') console.warn(`dockit: ${e.reason}: ${cause}`); // a library error name and message, for diagnosis
  const d = e.detail as
    { reason?: unknown; pages?: { page: number; reason: PipelineReason }[] } | undefined;
  if (typeof d?.reason === 'string') info.detail = d.reason;
  if (Array.isArray(d?.pages))
    info.pages = d.pages
      .filter((p) => p.reason)
      .map((p) => ({ page: p.page, message: REFUSAL_MESSAGES[p.reason] }));
  return info;
}

export class AppController {
  #state: AppState;
  #listeners = new Set<() => void>();
  #pipeline: Pipeline | undefined;
  /** The adapters that are loaded now. Undefined before the first use and after a Stop (the worker host ends the engine worker on an abort, R8). */
  #loaded: LoadedModels | undefined;
  #loading: Promise<LoadedModels> | undefined;
  /** True once the engine was ended: the next load is a re-load, and says so. */
  #reloadNeeded = false;
  /** Releasing the ended adapters; a re-load waits for it so two models never sit in memory together. */
  #unloading: Promise<void> | undefined;
  #abort: AbortController | undefined;
  readonly #deps: ControllerDeps;
  readonly #progress = new Map<string, { received: number; total: number }>();

  constructor(deps: ControllerDeps) {
    this.#deps = deps;
    this.#state = {
      framed: deps.framed,
      online: deps.online(),
      capability: { profile: null, verdict: 'unknown', note: CAPABILITY_NOTE },
      model: {
        status: 'unknown',
        plannedBytes: undefined,
        reloading: false,
        receivedBytes: 0,
        totalBytes: 0,
        refusal: undefined,
      },
      doc: {
        status: 'none',
        stages: initialStages(),
        info: undefined,
        refusal: undefined,
        keep: false,
      },
      ask: { status: 'idle', answer: undefined, displayText: '', refusal: undefined, streamed: '' },
      kept: [],
    };
    deps.events.subscribe((e) => {
      if (e.name !== 'pipeline.stage') return;
      const stage = e.attrs['stage'] as PipelineStage;
      const outcome = e.attrs['outcome'] as StageStatus;
      this.#set((s) => ({
        ...s,
        doc: {
          ...s.doc,
          stages: s.doc.stages.map((r) =>
            r.stage === stage
              ? {
                  stage,
                  status: outcome,
                  ...(e.durationMs === undefined ? {} : { ms: e.durationMs }),
                }
              : r,
          ),
        },
      }));
    });
  }

  subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  };
  getState = (): AppState => this.#state;
  #set(f: (s: AppState) => AppState): void {
    this.#state = f(this.#state);
    for (const l of this.#listeners) l();
  }

  async init(): Promise<void> {
    if (this.#state.framed) return;
    const cap = this.#deps.detectCapability().then(
      ({ profile, verdict }) =>
        this.#set((s) => ({ ...s, capability: { profile, verdict, note: CAPABILITY_NOTE } })),
      () => undefined,
    );
    const planned = this.#deps.models.plannedBytes();
    const status = this.#deps.models.status();
    const [{ cached }, plannedBytes] = await Promise.all([status, planned, cap]);
    this.#set((s) => ({
      ...s,
      model: { ...s.model, status: cached ? 'cached' : 'absent', plannedBytes },
    }));
    await this.refreshKept();
  }

  async refreshKept(): Promise<void> {
    try {
      const kept = await this.#pipelineOnce().listKept();
      this.#set((s) => ({ ...s, kept }));
    } catch {
      this.#set((s) => ({ ...s, kept: [] }));
    }
  }

  /** Makes a kept document current without reading a PDF. */
  async useKept(docId: string): Promise<void> {
    if (this.#state.framed) return this.#refuseFramed('doc');
    try {
      const info = await this.#pipelineOnce().adopt(docId);
      this.#set((s) => ({
        ...s,
        doc: { ...s.doc, status: 'ready', info, refusal: undefined },
        ask: {
          status: 'idle',
          answer: undefined,
          displayText: '',
          refusal: undefined,
          streamed: '',
        },
      }));
    } catch (e) {
      this.#set((s) => ({
        ...s,
        doc: {
          ...s.doc,
          status: 'refused',
          refusal: refusalInfo(e) ?? { reason: 'no_index', message: REFUSAL_MESSAGES.no_index },
        },
      }));
    }
  }

  async removeKept(docId: string): Promise<void> {
    await this.#pipelineOnce().remove(docId);
    if (this.#state.doc.info?.docId === docId)
      this.#set((s) => ({
        ...s,
        doc: {
          status: 'none',
          stages: initialStages(),
          info: undefined,
          refusal: undefined,
          keep: s.doc.keep,
        },
      }));
    await this.refreshKept();
  }

  setOnline(online: boolean): void {
    this.#set((s) => ({ ...s, online }));
  }

  setKeep(keep: boolean): void {
    this.#set((s) => ({ ...s, doc: { ...s.doc, keep } }));
  }

  async download(): Promise<void> {
    if (this.#state.framed) return this.#refuseFramed('model');
    this.#progress.clear();
    this.#set((s) => ({
      ...s,
      model: {
        ...s.model,
        status: 'downloading',
        receivedBytes: 0,
        totalBytes: s.model.plannedBytes ?? 0,
        refusal: undefined,
      },
    }));
    try {
      await this.#deps.models.download({
        onProgress: (p: DownloadProgress) => {
          this.#progress.set(p.entryId, { received: p.received, total: p.total });
          let received = 0;
          let total = 0;
          for (const v of this.#progress.values()) {
            received += v.received;
            total += v.total;
          }
          this.#set((s) => ({
            ...s,
            model: {
              ...s.model,
              receivedBytes: received,
              totalBytes: Math.max(total, s.model.plannedBytes ?? 0),
            },
          }));
        },
      });
      this.#set((s) => ({ ...s, model: { ...s.model, status: 'cached', refusal: undefined } }));
    } catch (e) {
      this.#set((s) => ({
        ...s,
        model: {
          ...s.model,
          status: refusalInfo(e)?.reason === 'model_not_cached' ? 'absent' : 'refused',
          refusal: refusalInfo(e) ?? { reason: 'corrupt', message: 'The download failed.' },
        },
      }));
    }
  }

  /**
   * The models are loaded the first time a stage needs them: a refusal that comes earlier (scanned, too large, ...) never loads them. After a
   * Stop the engine is gone, so the next use goes through the SAME load path again (models.load(): re-verifies the stored manifest, S-OFF-1,
   * checks the signature and the expected id, loads from the cached files, hashes every file in the worker, R15). Nothing is downloaded. While
   * that runs the card says so (status loading, reloading true); if it fails, the card and the ask show the real reason.
   */
  #getModels(): Promise<LoadedModels> {
    if (this.#loaded) return Promise.resolve(this.#loaded);
    this.#loading ??= (async () => {
      const again = this.#reloadNeeded;
      this.#set((s) => ({
        ...s,
        model: { ...s.model, status: 'loading', reloading: again, refusal: undefined },
      }));
      try {
        await this.#unloading; // the engine that was stopped is released before the next one is loaded
        this.#unloading = undefined;
        const m = await this.#deps.models.load();
        this.#loaded = m;
        this.#reloadNeeded = false;
        this.#set((s) => ({ ...s, model: { ...s.model, status: 'ready', reloading: false } }));
        return m;
      } catch (e) {
        const r = mapAdapterError(e);
        const info = refusalInfo(r) ?? {
          reason: 'failed' as const,
          message: 'The model could not be loaded.',
        };
        this.#set((s) => ({
          ...s,
          model: {
            ...s.model,
            status: info.reason === 'model_not_cached' ? 'absent' : 'refused',
            reloading: false,
            refusal: info,
          },
        }));
        throw r;
      } finally {
        this.#loading = undefined;
      }
    })();
    return this.#loading;
  }

  /** The engine behind `models` is gone (a Stop, or a worker that ended): forget it, release it, and say that nothing is loaded now. */
  #invalidate(models: LoadedModels): void {
    if (this.#loaded !== models) return; // a newer load has already replaced it
    this.#loaded = undefined;
    this.#reloadNeeded = true;
    this.#unloading = (async () => {
      try {
        await models.unload?.();
      } catch {
        // releasing an adapter that is already gone is not an error worth showing
      }
    })();
    this.#set((s) =>
      s.model.status === 'ready' ? { ...s, model: { ...s.model, status: 'cached' } } : s,
    );
  }

  /**
   * Runs `use` on the loaded models. An abort ends the engine, so the models are marked as not loaded; a 'not_loaded' (the engine was ended earlier,
   * or its worker crashed) is re-loaded ONCE and retried. A re-load that fails throws its own reason (manifest_refused, integrity, or
   * model_not_cached only when a file is really missing); a not_loaded that survives the one re-load is a plain failure, never 'not downloaded'.
   */
  async #useModels<T>(
    use: (m: LoadedModels) => Promise<T>,
    endedBy?: (result: T) => boolean,
  ): Promise<T> {
    let m = await this.#getModels();
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await use(m);
        if (endedBy?.(result) === true) this.#invalidate(m);
        return result;
      } catch (e) {
        if (isAdapterError(e, 'aborted')) {
          this.#invalidate(m);
          throw e;
        }
        if (isAdapterError(e, 'not_loaded') && attempt === 0) {
          this.#invalidate(m);
          m = await this.#getModels();
          continue;
        }
        throw e;
      }
    }
  }

  #pipelineOnce(): Pipeline {
    this.#pipeline ??= (this.#deps.makePipeline ?? createPipeline)({
      ...this.#deps.pipelineDeps,
      events: this.#deps.events,
      specialTokens: () => this.#loaded?.specialTokens ?? DEFAULT_SPECIAL_TOKENS,
      embedder: { embed: (t, o) => this.#useModels((m) => m.embedder.embed(t, o)) },
      generator: {
        generate: (p, o) =>
          this.#useModels(
            (m) => m.generator.generate(p, o),
            (r) => r.finishReason === 'abort', // the worker host terminated the engine worker
          ),
      },
    });
    return this.#pipeline;
  }

  #refuseFramed(where: 'doc' | 'ask' | 'model'): void {
    const refusal = refusalInfo(new Refusal('framed'));
    if (where === 'doc')
      this.#set((s) => ({ ...s, doc: { ...s.doc, status: 'refused', refusal } }));
    else if (where === 'ask')
      this.#set((s) => ({ ...s, ask: { ...s.ask, status: 'refused', refusal } }));
    else this.#set((s) => ({ ...s, model: { ...s.model, status: 'refused', refusal } }));
  }

  async openFile(file: Blob): Promise<void> {
    if (this.#state.framed) return this.#refuseFramed('doc');
    this.#set((s) => ({
      ...s,
      doc: {
        ...s.doc,
        status: 'working',
        stages: initialStages(),
        info: undefined,
        refusal: undefined,
      },
      ask: { status: 'idle', answer: undefined, displayText: '', refusal: undefined, streamed: '' },
    }));
    try {
      const info = await this.#pipelineOnce().open(file, { keep: this.#state.doc.keep });
      this.#set((s) => ({ ...s, doc: { ...s.doc, status: 'ready', info, refusal: undefined } }));
    } catch (e) {
      const m = mapAdapterError(e);
      const refusal = refusalInfo(m);
      if (!refusal) {
        const code = isAdapterError(m) ? m.code : 'error';
        // the library's own error name and message, for diagnosis: never document text
        const cause = (m as { cause?: unknown } | null)?.cause;
        const causeText =
          cause instanceof Error
            ? `${cause.name}: ${cause.message}`
            : cause === undefined
              ? ''
              : String(cause);
        console.warn(
          `dockit: ${(m as Error)?.name ?? 'Error'}: ${String((m as Error)?.message ?? m).slice(0, 300)}${causeText === '' ? '' : ` (cause: ${causeText.slice(0, 300)})`}`,
        );
        this.#set((s) => ({
          ...s,
          doc: {
            ...s.doc,
            status: 'refused',
            refusal: { reason: 'corrupt', message: `Something went wrong (${code}).` },
          },
        }));
        return;
      }
      this.#set((s) => ({ ...s, doc: { ...s.doc, status: 'refused', refusal } }));
    }
  }

  async ask(question: string): Promise<void> {
    if (this.#state.framed) return this.#refuseFramed('ask');
    // Ask is disabled in the card while an answer, or the re-load of the model that a Stop ended, is under way; a second call is ignored
    if (this.#state.ask.status === 'working') return;
    this.#abort = new AbortController();
    this.#set((s) => ({
      ...s,
      ask: {
        status: 'working',
        answer: undefined,
        displayText: '',
        refusal: undefined,
        streamed: '',
      },
    }));
    try {
      const answer = await this.#pipelineOnce().ask(question, {
        signal: this.#abort.signal,
        onToken: (t) =>
          this.#set((s) => ({ ...s, ask: { ...s.ask, streamed: s.ask.streamed + t } })),
      });
      if (answer.finishReason === 'abort' && answer.text.trim() === '') {
        this.#showStopped();
        return;
      }
      this.#set((s) => ({
        ...s,
        ask: {
          status: 'done',
          answer,
          displayText: sanitiseDisplay(answer.text),
          refusal: undefined,
          streamed: '',
        },
      }));
    } catch (e) {
      const outcome = adapterOutcome(e);
      if (outcome?.kind === 'stopped') {
        this.#showStopped(); // BUG-T1-S5-R2-02: the user's own Stop before the first token: a plain 'Stopped.', not a failure
        return;
      }
      const refusal = refusalInfo(mapAdapterError(e)) ?? {
        reason: 'failed' as const,
        message: ANSWER_FAILED_MESSAGE,
      };
      this.#set((s) => ({
        ...s,
        ask: { status: 'refused', answer: undefined, displayText: '', refusal, streamed: '' },
      }));
    } finally {
      this.#abort = undefined;
    }
  }

  #showStopped(): void {
    this.#set((s) => ({
      ...s,
      ask: {
        status: 'stopped',
        answer: undefined,
        displayText: '',
        refusal: undefined,
        streamed: '',
      },
    }));
  }

  stop(): void {
    this.#abort?.abort();
  }

  async remove(): Promise<void> {
    const info = this.#state.doc.info;
    if (info) await this.#pipelineOnce().remove(info.docId);
    this.#set((s) => ({
      ...s,
      doc: {
        status: 'none',
        stages: initialStages(),
        info: undefined,
        refusal: undefined,
        keep: s.doc.keep,
      },
      ask: { status: 'idle', answer: undefined, displayText: '', refusal: undefined, streamed: '' },
    }));
    await this.refreshKept();
  }
}
