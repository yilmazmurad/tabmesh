import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createChannel, type MessageHandler, type MessageMap, type TabChannel, type TabChannelOptions } from './channel.js';
import { electLeader, type LeaderOptions } from './leader.js';
import type { SharedStore, Updater } from './store.js';

/**
 * Subscribe a component to a shared store. Works like `useState`, but the value is shared
 * by every tab. Create the store once at module level (or memoize it).
 */
export function useSharedStore<T>(store: SharedStore<T>): [T, (next: Updater<T>) => void] {
  const subscribe = useCallback((onChange: () => void) => store.subscribe(onChange), [store]);
  const value = useSyncExternalStore(subscribe, store.get, store.get);
  const set = useCallback((next: Updater<T>) => store.set(next), [store]);
  return [value, set];
}

/** Returns `true` while this tab is the elected leader for `name`. */
export function useIsLeader(name: string, options: Omit<LeaderOptions, 'signal'> = {}): boolean {
  const [isLeader, setIsLeader] = useState(false);
  const { locks } = options;
  const onLeaderRef = useRef(options.onLeader);
  onLeaderRef.current = options.onLeader;
  useEffect(() => {
    const election = electLeader(name, { ...(locks ? { locks } : {}), onLeader: () => onLeaderRef.current?.() });
    const off = election.subscribe(setIsLeader);
    setIsLeader(election.isLeader);
    return () => {
      off();
      election.abdicate();
      setIsLeader(false);
    };
  }, [name, locks]);
  return isLeader;
}

/**
 * Open a typed channel for the lifetime of the component and optionally listen to messages.
 * Handlers may change between renders (the latest one is always called), but the set of
 * message types is fixed when the channel opens. Returns a stable `post` function.
 */
export function useTabChannel<M extends MessageMap>(
  name: string,
  handlers: { [K in keyof M & string]?: MessageHandler<M[K]> } = {},
  options: TabChannelOptions = {},
): TabChannel<M>['post'] {
  const [channel, setChannel] = useState<TabChannel<M> | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const { channelFactory, tabId } = options;

  useEffect(() => {
    const ch = createChannel<M>(name, { ...(channelFactory ? { channelFactory } : {}), ...(tabId ? { tabId } : {}) });
    setChannel(ch);
    const offs = Object.keys(handlersRef.current).map((type) =>
      ch.on(type, (payload, meta) => {
        const handler = handlersRef.current[type] as MessageHandler<unknown> | undefined;
        handler?.(payload, meta);
      }),
    );
    return () => {
      for (const off of offs) off();
      ch.close();
      setChannel(null);
    };
  }, [name, channelFactory, tabId, handlersRef]);

  return useCallback<TabChannel<M>['post']>(
    (type, ...payload) => {
      if (!channel) throw new Error('tabmesh: useTabChannel is not mounted yet');
      channel.post(type, ...payload);
    },
    [channel],
  );
}
