import { PREFIX } from './util.js';

/** Minimal subset of the Web Locks API (`navigator.locks`). */
export interface LockManagerLike {
  request(name: string, options: { signal?: AbortSignal; mode?: 'exclusive' }, callback: () => Promise<unknown>): Promise<unknown>;
}

export interface LeaderOptions {
  /** Custom lock manager (defaults to `navigator.locks`). */
  locks?: LockManagerLike;
  /** Stop competing / give up leadership when this signal aborts. */
  signal?: AbortSignal;
  /** Called when this tab becomes leader. May return a cleanup function, run on abdication. */
  onLeader?: () => unknown;
}

export interface LeaderElection {
  /** Whether this tab currently holds leadership. */
  readonly isLeader: boolean;
  /** Resolves when this tab becomes leader. */
  readonly whenLeader: Promise<void>;
  /** Subscribe to leadership changes. Returns an unsubscribe function. */
  subscribe(listener: (isLeader: boolean) => void): () => void;
  /** Give up leadership (or stop waiting for it). Another tab will take over. Idempotent. */
  abdicate(): void;
}

function defaultLocks(): LockManagerLike {
  const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
  if (!nav?.locks) {
    throw new Error('tabmesh: Web Locks API (navigator.locks) is not available; pass a custom `locks` implementation.');
  }
  return nav.locks;
}

/**
 * Elect exactly one leader tab among all tabs that call `electLeader` with the same name.
 * Built on the Web Locks API: the leader holds an exclusive lock, and when its tab closes
 * (or it abdicates) the browser hands the lock to the next waiting tab automatically.
 */
export function electLeader(name: string, options: LeaderOptions = {}): LeaderElection {
  const locks = options.locks ?? defaultLocks();
  const listeners = new Set<(isLeader: boolean) => void>();
  const controller = new AbortController();
  let isLeader = false;
  let done = false;
  let release: (() => void) | undefined;
  let resolveLeader!: () => void;
  const whenLeader = new Promise<void>((resolve) => {
    resolveLeader = resolve;
  });

  const setLeader = (next: boolean): void => {
    if (isLeader === next) return;
    isLeader = next;
    for (const listener of [...listeners]) listener(next);
  };

  const abdicate = (): void => {
    if (done) return;
    done = true;
    controller.abort();
    release?.();
  };

  if (options.signal?.aborted) {
    done = true;
  } else {
    options.signal?.addEventListener('abort', abdicate, { once: true });
    locks
      .request(`${PREFIX}leader:${name}`, { signal: controller.signal, mode: 'exclusive' }, async () => {
        if (done) return;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        setLeader(true);
        resolveLeader();
        const cleanup = options.onLeader?.();
        await held;
        if (typeof cleanup === 'function') (cleanup as () => void)();
        setLeader(false);
      })
      .catch((error: unknown) => {
        // AbortError is expected when abdicating while still waiting for the lock.
        if (!(error instanceof Error && error.name === 'AbortError') && !controller.signal.aborted) {
          queueMicrotask(() => {
            throw error;
          });
        }
      });
  }

  return {
    get isLeader() {
      return isLeader;
    },
    whenLeader,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    abdicate,
  };
}
