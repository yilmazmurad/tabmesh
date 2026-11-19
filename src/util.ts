/** Minimal structural type for a BroadcastChannel-like transport. */
export interface ChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/** Factory used to open a transport; override it for tests or custom transports. */
export type ChannelFactory = (name: string) => ChannelLike;

export const defaultChannelFactory: ChannelFactory = (name) => {
  if (typeof BroadcastChannel === 'undefined') {
    throw new Error('tabmesh: BroadcastChannel is not available in this environment; pass a custom `channelFactory`.');
  }
  const channel = new BroadcastChannel(name);
  // Do not keep Node.js processes alive just because a channel is open.
  (channel as unknown as { unref?: () => void }).unref?.();
  return channel as unknown as ChannelLike;
};

/** Returns a random, URL-safe identifier for the current tab. */
export function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export const PREFIX = 'tabmesh:';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
