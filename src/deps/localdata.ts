/** dockit's typed view of the localdata build (vendor/localdata). */
import * as ld from 'virtual:dockit-deps/localdata/index.js';
import type { EventSink } from '../contracts/event.ts';
import type { StorageApi } from '../contracts/storage-api.ts';

export interface CreateStoreOptions {
  /** 'memory' by default in dockit (documents stay in memory); 'opfs' only with the opt-in. */
  driver?: 'opfs' | 'indexeddb' | 'memory' | 'auto';
  quotaBytes?: number;
  events?: EventSink;
  eventSession?: string;
}

export const createStore = (opts: CreateStoreOptions = {}): Promise<StorageApi> =>
  (ld as unknown as { createStore(o: CreateStoreOptions): Promise<StorageApi> }).createStore(opts);
