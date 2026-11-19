import { defaultChannelFactory, isRecord, PREFIX, randomId, type ChannelFactory, type ChannelLike } from './util.js';

/** Minimal Storage subset used for optional persistence (e.g. `localStorage`). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SharedStoreOptions<T> {
  /** Identifier for this tab. Defaults to a random UUID. */
  tabId?: string;
  /** Custom transport factory (defaults to `BroadcastChannel`). */
  channelFactory?: ChannelFactory;
  /** Persist the latest value (with its clock) so new tabs start from it, e.g. `localStorage`. */
  storage?: StorageLike;
  /** Runtime guard applied to values coming from other tabs or storage. Invalid values are ignored. */
  validate?: (value: unknown) => value is T;
  /** Ask already-open tabs for their state on creation (default: `true`). */
  requestSnapshot?: boolean;
}

export type Updater<T> = T | ((previous: T) => T);

/** Logical (Lamport) clock used for last-writer-wins conflict resolution. */
export interface Clock {
  /** Monotonic counter. 0 means "initial value, never written". */
  v: number;
  /** Tab id of the writer, used as a deterministic tie-breaker. */
  by: string;
}

export interface SharedStore<T> {
  readonly name: string;
  readonly tabId: string;
  /** Current value. Stable reference until it changes (safe for `useSyncExternalStore`). */
  get(): T;
  /** Current logical clock of the value. */
  clock(): Clock;
  /** Update locally and broadcast to other tabs. */
  set(next: Updater<T>): void;
  /** Subscribe to changes (local and remote). Returns an unsubscribe function. */
  subscribe(listener: (value: T, source: 'local' | 'remote') => void): () => void;
  /** Stop syncing. Idempotent. */
  close(): void;
}

type Wire<T> =
  | { t: 'state'; value: T; clock: Clock }
  | { t: 'hello'; from: string };

/** Returns true when clock `a` wins over clock `b`. */
export function isNewer(a: Clock, b: Clock): boolean {
  return a.v > b.v || (a.v === b.v && a.by > b.by);
}

function isClock(value: unknown): value is Clock {
  return isRecord(value) && typeof value.v === 'number' && Number.isFinite(value.v) && typeof value.by === 'string';
}

/**
 * Create a piece of state that stays in sync across all tabs of the same origin.
 * Concurrent writes are resolved deterministically with a Lamport clock (last writer wins,
 * ties broken by tab id), so every tab converges to the same value.
 */
export function createSharedStore<T>(name: string, initial: T, options: SharedStoreOptions<T> = {}): SharedStore<T> {
  const tabId = options.tabId ?? randomId();
  const validate = options.validate ?? ((v: unknown): v is T => v !== undefined);
  const storageKey = `${PREFIX}store:${name}`;
  const transport: ChannelLike = (options.channelFactory ?? defaultChannelFactory)(`${PREFIX}store:${name}`);
  const listeners = new Set<(value: T, source: 'local' | 'remote') => void>();

  let value = initial;
  let clock: Clock = { v: 0, by: '' };
  let closed = false;

  if (options.storage) {
    try {
      const raw = options.storage.getItem(storageKey);
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw);
        if (isRecord(parsed) && isClock(parsed.clock) && validate(parsed.value)) {
          value = parsed.value;
          clock = parsed.clock;
        }
      }
    } catch {
      // Corrupt or inaccessible storage: fall back to the initial value.
    }
  }

  const persist = (): void => {
    if (!options.storage) return;
    try {
      options.storage.setItem(storageKey, JSON.stringify({ value, clock }));
    } catch {
      // Quota exceeded / private mode: syncing still works without persistence.
    }
  };

  const emit = (source: 'local' | 'remote'): void => {
    for (const listener of [...listeners]) listener(value, source);
  };

  const send = (message: Wire<T>): void => {
    if (!closed) transport.postMessage(message);
  };

  const listener = (event: MessageEvent): void => {
    const data: unknown = event.data;
    if (!isRecord(data)) return;
    if (data.t === 'hello') {
      if (clock.v > 0) send({ t: 'state', value, clock });
      return;
    }
    if (data.t === 'state' && isClock(data.clock) && validate(data.value)) {
      if (!isNewer(data.clock, clock)) return;
      value = data.value;
      clock = data.clock;
      persist();
      emit('remote');
    }
  };
  transport.addEventListener('message', listener);

  if (options.requestSnapshot !== false) send({ t: 'hello', from: tabId });

  return {
    name,
    tabId,
    get: () => value,
    clock: () => ({ ...clock }),
    set(next) {
      if (closed) throw new Error(`tabmesh: store "${name}" is closed`);
      const resolved = typeof next === 'function' ? (next as (previous: T) => T)(value) : next;
      if (Object.is(resolved, value)) return;
      value = resolved;
      clock = { v: clock.v + 1, by: tabId };
      persist();
      send({ t: 'state', value, clock });
      emit('local');
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      transport.removeEventListener('message', listener);
      transport.close();
    },
  };
}
