import {
  EVENT_ATTR_KEY_PATTERN,
  EVENT_ATTR_STRING_MAX,
  EVENT_ATTRS_MAX_KEYS,
  EVENT_FORBIDDEN_KEY_PATTERN,
  EVENT_NAME_PATTERN,
  EVENT_SOURCE_PATTERN,
  EVENT_SPEC,
  type Event,
  type EventAttrs,
  type EventAttrValue,
  type EventKind,
  type EventLevel,
  type EventSink,
} from '../contracts/event.ts';

/**
 * Local copy of the runtime's attrs rules. Library code owns attrs, so these checks run in
 * every build, not only in development.
 */

function randomId(): string {
  return crypto.randomUUID().replace(/-/gu, '').slice(0, 16);
}

/** One random session id per page load (or per process in tests); never persisted. */
export const SESSION_ID = randomId();

export interface EventInit {
  source: string;
  kind: EventKind;
  name: string;
  level: EventLevel;
  durationMs?: number;
  bytes?: number;
  attrs?: Record<string, EventAttrValue>;
}

const QUERY_AFTER_SCHEME = /^([a-z][a-z0-9+.-]*:\/\/[^?#]*)\?[^#]*(#.*)?$/iu;

function sanitiseString(value: string): string {
  let v = value;
  const m = QUERY_AFTER_SCHEME.exec(v);
  if (m) v = m[1]!;
  if (v.length > EVENT_ATTR_STRING_MAX) v = v.slice(0, EVENT_ATTR_STRING_MAX);
  return v;
}

export function sanitiseAttrs(attrs: Record<string, EventAttrValue> | undefined): EventAttrs {
  if (attrs === undefined) return {};
  const keys = Object.keys(attrs);
  if (keys.length > EVENT_ATTRS_MAX_KEYS) {
    throw new TypeError(`event attrs: more than ${EVENT_ATTRS_MAX_KEYS} keys`);
  }
  const out: EventAttrs = {};
  for (const key of keys) {
    if (!EVENT_ATTR_KEY_PATTERN.test(key)) throw new TypeError(`event attrs: invalid key ${key}`);
    if (EVENT_FORBIDDEN_KEY_PATTERN.test(key)) {
      throw new TypeError(`event attrs: key ${key} may carry document text or identifiers`);
    }
    const value = attrs[key];
    if (value === undefined) continue;
    if (typeof value === 'string') out[key] = sanitiseString(value);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null)
      out[key] = value;
    else throw new TypeError(`event attrs: value for ${key} is not a primitive`);
  }
  return out;
}

export function newEvent(init: EventInit): Event {
  if (!EVENT_SOURCE_PATTERN.test(init.source))
    throw new TypeError(`event: invalid source ${init.source}`);
  if (!EVENT_NAME_PATTERN.test(init.name)) throw new TypeError(`event: invalid name ${init.name}`);
  const e: Event = {
    spec: EVENT_SPEC,
    id: crypto.randomUUID(),
    ts: Date.now(),
    session: SESSION_ID,
    source: init.source,
    kind: init.kind,
    name: init.name,
    level: init.level,
    attrs: sanitiseAttrs(init.attrs),
  };
  if (typeof performance !== 'undefined') e.mono = performance.now();
  if (init.durationMs !== undefined) e.durationMs = init.durationMs;
  if (init.bytes !== undefined) e.bytes = init.bytes;
  return e;
}

export type EventListener = (e: Event) => void;

/** In-memory ring buffer sink with subscribe(); the only sink dockit has. */
export class EventLog implements EventSink {
  readonly #capacity: number;
  readonly #buffer: Event[] = [];
  readonly #listeners = new Set<EventListener>();

  constructor(capacity = 1000) {
    this.#capacity = capacity;
  }

  emit(e: Event): void {
    this.#buffer.push(e);
    if (this.#buffer.length > this.#capacity)
      this.#buffer.splice(0, this.#buffer.length - this.#capacity);
    for (const l of this.#listeners) l(e);
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  snapshot(): Event[] {
    return [...this.#buffer];
  }

  clear(): void {
    this.#buffer.length = 0;
  }
}
