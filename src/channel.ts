import { defaultChannelFactory, isRecord, PREFIX, randomId, type ChannelFactory, type ChannelLike } from './util.js';

/** A map of message type -> payload type, e.g. `{ logout: { reason: string }; ping: void }`. */
export type MessageMap = Record<string, unknown>;

export interface MessageMeta {
  /** Id of the tab that sent the message. */
  from: string;
  /** Sender timestamp (ms since epoch). */
  at: number;
}

export type MessageHandler<P> = (payload: P, meta: MessageMeta) => void;

export interface TabChannelOptions {
  /** Identifier for this tab. Defaults to a random UUID. */
  tabId?: string;
  /** Custom transport factory (defaults to `BroadcastChannel`). */
  channelFactory?: ChannelFactory;
}

export interface TabChannel<M extends MessageMap> {
  readonly name: string;
  readonly tabId: string;
  /** Broadcast a typed message to every other tab listening on the same channel. */
  post<K extends keyof M & string>(type: K, ...payload: undefined extends M[K] ? [payload?: M[K]] : [payload: M[K]]): void;
  /** Listen for a message type. Returns an unsubscribe function. */
  on<K extends keyof M & string>(type: K, handler: MessageHandler<M[K]>): () => void;
  /** Listen once, resolving with the next payload of the given type. Rejects if aborted. */
  once<K extends keyof M & string>(type: K, options?: { signal?: AbortSignal }): Promise<M[K]>;
  /** Close the underlying transport and drop all handlers. Idempotent. */
  close(): void;
  readonly closed: boolean;
}

interface Envelope {
  t: 'msg';
  type: string;
  payload: unknown;
  from: string;
  at: number;
}

function isEnvelope(data: unknown): data is Envelope {
  return isRecord(data) && data.t === 'msg' && typeof data.type === 'string' && typeof data.from === 'string' && typeof data.at === 'number';
}

/**
 * Create a typed cross-tab message channel on top of BroadcastChannel.
 *
 * ```ts
 * const bus = createChannel<{ logout: { reason: string } }>('auth');
 * bus.on('logout', ({ reason }) => location.assign('/login?r=' + reason));
 * bus.post('logout', { reason: 'expired' });
 * ```
 */
export function createChannel<M extends MessageMap>(name: string, options: TabChannelOptions = {}): TabChannel<M> {
  const tabId = options.tabId ?? randomId();
  const transport: ChannelLike = (options.channelFactory ?? defaultChannelFactory)(`${PREFIX}ch:${name}`);
  const handlers = new Map<string, Set<MessageHandler<unknown>>>();
  let closed = false;

  const listener = (event: MessageEvent): void => {
    const data: unknown = event.data;
    if (!isEnvelope(data) || data.from === tabId) return;
    const set = handlers.get(data.type);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(data.payload, { from: data.from, at: data.at });
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  };
  transport.addEventListener('message', listener);

  const on = <K extends keyof M & string>(type: K, handler: MessageHandler<M[K]>): (() => void) => {
    if (closed) return () => undefined;
    let set = handlers.get(type);
    if (!set) {
      set = new Set();
      handlers.set(type, set);
    }
    const h = handler as MessageHandler<unknown>;
    set.add(h);
    return () => {
      set.delete(h);
      if (set.size === 0) handlers.delete(type);
    };
  };

  return {
    name,
    tabId,
    get closed() {
      return closed;
    },
    post(type, ...rest) {
      if (closed) throw new Error(`tabmesh: channel "${name}" is closed`);
      const envelope: Envelope = { t: 'msg', type, payload: rest[0], from: tabId, at: Date.now() };
      transport.postMessage(envelope);
    },
    on,
    once(type, { signal } = {}) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const onAbort = (): void => {
          off();
          reject(signal?.reason);
        };
        const off = on(type, (payload) => {
          off();
          signal?.removeEventListener('abort', onAbort);
          resolve(payload);
        });
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    close() {
      if (closed) return;
      closed = true;
      handlers.clear();
      transport.removeEventListener('message', listener);
      transport.close();
    },
  };
}
