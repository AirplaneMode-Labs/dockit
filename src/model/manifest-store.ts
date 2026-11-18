import type { ManifestStorePort } from './model-service.ts';

const DB = 'dockit';
const STORE = 'manifest';

interface IdbRequestLike<T = unknown> {
  result: T;
  error?: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: ((e: { target: unknown }) => void) | null;
}
interface IdbFactoryLike {
  open(name: string, version: number): IdbRequestLike<IdbDatabaseLike>;
}
interface IdbDatabaseLike {
  objectStoreNames: { contains(n: string): boolean };
  createObjectStore(n: string): unknown;
  transaction(n: string, mode: 'readonly' | 'readwrite'): IdbTransactionLike;
  close(): void;
}
interface IdbTransactionLike {
  objectStore(n: string): {
    get(k: string): IdbRequestLike;
    put(v: unknown, k: string): IdbRequestLike;
    delete(k: string): IdbRequestLike;
  };
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
}

const req = <T>(r: IdbRequestLike<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('indexedDB request failed'));
  });

/**
 * The verified manifest document, stored as raw bytes in IndexedDB database 'dockit', object store 'manifest', keyed by
 * the manifest id (S-OFF-1). It is re-verified on every load: this store is a cache of a document, never a trust anchor.
 */
export async function openManifestStore(
  factory: IdbFactoryLike = indexedDB as unknown as IdbFactoryLike,
): Promise<ManifestStorePort> {
  const opening = factory.open(DB, 1);
  opening.onupgradeneeded = () => {
    const db = opening.result;
    if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
  };
  const db = await req(opening);
  const tx = (mode: 'readonly' | 'readwrite') => db.transaction(STORE, mode);
  return {
    async get(id) {
      const v = await req(tx('readonly').objectStore(STORE).get(id));
      return v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : undefined;
    },
    async put(id, bytes) {
      await req(tx('readwrite').objectStore(STORE).put(bytes, id));
    },
    async delete(id) {
      await req(tx('readwrite').objectStore(STORE).delete(id));
    },
  };
}
