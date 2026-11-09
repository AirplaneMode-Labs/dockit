import {
  STORAGE_KEY_MAX,
  STORAGE_NS_PATTERN,
  StorageError,
  type QueryHit,
  type StorableValue,
  type StorageApi,
} from '../contracts/storage-api.ts';

interface Row {
  value: StorableValue;
  bytes: number;
  expiresAt?: number;
}

const BINARY_TAGS = new Set([
  '[object ArrayBuffer]',
  '[object Uint8Array]',
  '[object Int8Array]',
  '[object Uint16Array]',
  '[object Int16Array]',
  '[object Uint32Array]',
  '[object Int32Array]',
  '[object Float32Array]',
  '[object Float64Array]',
  '[object BigInt64Array]',
  '[object BigUint64Array]',
  '[object Blob]',
  '[object File]',
]);

function isStorable(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return true;
    case 'object':
      break;
    default:
      return false;
  }
  const tag = Object.prototype.toString.call(value);
  if (BINARY_TAGS.has(tag) || tag === '[object Date]') return true;
  if (Array.isArray(value)) return value.every((v) => isStorable(v, depth + 1));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value as Record<string, unknown>).every((v) => isStorable(v, depth + 1));
}

function approxBytes(value: StorableValue): number {
  if (value instanceof Blob) return value.size;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

function checkNamespace(ns: string): void {
  if (!STORAGE_NS_PATTERN.test(ns)) {
    throw new StorageError('invalid_namespace', `invalid namespace ${JSON.stringify(ns)}`);
  }
}

function checkKey(key: string): void {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > STORAGE_KEY_MAX ||
    key.includes('\u0000')
  ) {
    throw new StorageError('invalid_key', 'key must be 1..1024 UTF-16 units without U+0000');
  }
}

/**
 * In-process StorageApi used by the dockit pipeline stubs. Nothing persists beyond the page.
 * The real drivers (OPFS, IndexedDB) live in @airplanemode/localdata.
 */
export class MemoryStore implements StorageApi {
  readonly driver = 'memory' as const;
  readonly #rows = new Map<string, Map<string, Row>>();
  #closed = false;

  #ns(ns: string): Map<string, Row> {
    if (this.#closed) throw new StorageError('closed', 'store is closed');
    checkNamespace(ns);
    let m = this.#rows.get(ns);
    if (!m) {
      m = new Map();
      this.#rows.set(ns, m);
    }
    return m;
  }

  async set(
    ns: string,
    key: string,
    value: StorableValue,
    opts?: { ttlMs?: number },
  ): Promise<void> {
    const m = this.#ns(ns);
    checkKey(key);
    if (!isStorable(value)) {
      throw new StorageError('invalid_value', 'value is not a StorableValue');
    }
    const row: Row = { value: structuredClone(value), bytes: approxBytes(value) };
    if (opts?.ttlMs !== undefined) row.expiresAt = Date.now() + opts.ttlMs;
    m.set(key, row);
  }

  async get<T extends StorableValue = StorableValue>(
    ns: string,
    key: string,
  ): Promise<T | undefined> {
    const m = this.#ns(ns);
    checkKey(key);
    const row = m.get(key);
    if (!row) return undefined;
    if (row.expiresAt !== undefined && row.expiresAt <= Date.now()) {
      m.delete(key);
      return undefined;
    }
    return structuredClone(row.value) as T;
  }

  async delete(ns: string, key: string): Promise<boolean> {
    const m = this.#ns(ns);
    checkKey(key);
    return m.delete(key);
  }

  async query(
    ns: string,
    _vector: Float32Array,
    _k: number,
    _opts?: { filterPrefix?: string },
  ): Promise<QueryHit[]> {
    this.#ns(ns);
    throw new StorageError(
      'not_implemented',
      'query() is not implemented in Storage API 0.1; the vector index arrives in Sprint 4',
    );
  }

  async usage(ns?: string): Promise<{ bytes: number; quotaBytes?: number; items: number }> {
    if (this.#closed) throw new StorageError('closed', 'store is closed');
    let bytes = 0;
    let items = 0;
    const spaces = ns === undefined ? [...this.#rows.values()] : [this.#ns(ns)];
    for (const m of spaces) {
      for (const row of m.values()) {
        bytes += row.bytes;
        items++;
      }
    }
    return { bytes, items };
  }

  async clear(ns: string): Promise<void> {
    this.#ns(ns).clear();
  }

  async list(
    ns: string,
    opts?: { prefix?: string; limit?: number; cursor?: string },
  ): Promise<{ keys: string[]; cursor?: string }> {
    const m = this.#ns(ns);
    let keys = [...m.keys()].sort();
    if (opts?.prefix !== undefined) keys = keys.filter((k) => k.startsWith(opts.prefix!));
    if (opts?.cursor !== undefined) keys = keys.filter((k) => k > opts.cursor!);
    const limit = opts?.limit ?? keys.length;
    const page = keys.slice(0, limit);
    const last = page.at(-1);
    return keys.length > page.length && last !== undefined
      ? { keys: page, cursor: last }
      : { keys: page };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#rows.clear();
  }
}
