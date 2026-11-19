import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChannel, type ChannelLike, type TabChannel } from '../src/index.js';
import { tick, uniq, waitFor } from './helpers.js';

type Msgs = { logout: { reason: string }; ping: undefined; count: number };

const open: TabChannel<Msgs>[] = [];
const make = (name: string, tabId?: string): TabChannel<Msgs> => {
  const ch = createChannel<Msgs>(name, tabId ? { tabId } : {});
  open.push(ch);
  return ch;
};
afterEach(() => {
  for (const ch of open.splice(0)) ch.close();
});

describe('createChannel', () => {
  it('delivers typed messages to other tabs with metadata', async () => {
    const name = uniq('ch');
    const a = make(name, 'tab-a');
    const b = make(name, 'tab-b');
    const received: unknown[] = [];
    b.on('logout', (payload, meta) => received.push({ payload, from: meta.from, at: typeof meta.at }));
    a.post('logout', { reason: 'expired' });
    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual({ payload: { reason: 'expired' }, from: 'tab-a', at: 'number' });
  });

  it('does not deliver messages back to the sender', async () => {
    const name = uniq('ch');
    const a = make(name);
    const b = make(name);
    const self = vi.fn();
    const other = vi.fn();
    a.on('ping', self);
    b.on('ping', other);
    a.post('ping');
    await waitFor(() => other.mock.calls.length === 1);
    await tick();
    expect(self).not.toHaveBeenCalled();
  });

  it('broadcasts to many tabs and isolates channel names', async () => {
    const name = uniq('ch');
    const sender = make(name);
    const listeners = [make(name), make(name), make(name)].map((ch) => {
      const fn = vi.fn();
      ch.on('count', fn);
      return fn;
    });
    const foreign = vi.fn();
    make(uniq('other')).on('count', foreign);
    sender.post('count', 42);
    await waitFor(() => listeners.every((fn) => fn.mock.calls.length === 1));
    for (const fn of listeners) expect(fn.mock.calls[0]?.[0]).toBe(42);
    expect(foreign).not.toHaveBeenCalled();
  });

  it('supports unsubscribe and only routes matching types', async () => {
    const name = uniq('ch');
    const a = make(name);
    const b = make(name);
    const count = vi.fn();
    const off = b.on('count', count);
    const ping = vi.fn();
    b.on('ping', ping);
    a.post('count', 1);
    await waitFor(() => count.mock.calls.length === 1);
    off();
    a.post('count', 2);
    a.post('ping');
    await waitFor(() => ping.mock.calls.length === 1);
    expect(count).toHaveBeenCalledTimes(1);
  });

  it('once() resolves with the next payload and can be aborted', async () => {
    const name = uniq('ch');
    const a = make(name);
    const b = make(name);
    const next = b.once('count');
    a.post('count', 7);
    await expect(next).resolves.toBe(7);

    const controller = new AbortController();
    const pending = b.once('count', { signal: controller.signal });
    controller.abort(new Error('nope'));
    await expect(pending).rejects.toThrow('nope');
    await expect(b.once('count', { signal: AbortSignal.abort(new Error('early')) })).rejects.toThrow('early');
  });

  it('ignores foreign / malformed messages on the same transport', async () => {
    const name = uniq('ch');
    const b = make(name);
    const fn = vi.fn();
    b.on('ping', fn);
    const raw = new BroadcastChannel(`tabmesh:ch:${name}`);
    raw.postMessage('hello');
    raw.postMessage({ type: 'ping' });
    raw.postMessage(null);
    await tick(30);
    raw.close();
    expect(fn).not.toHaveBeenCalled();
  });

  it('close() is idempotent and post() after close throws', () => {
    const ch = make(uniq('ch'));
    ch.close();
    ch.close();
    expect(ch.closed).toBe(true);
    expect(() => ch.post('ping')).toThrow(/closed/);
    expect(ch.on('ping', () => undefined)).toBeTypeOf('function');
  });

  it('accepts a custom channel factory', () => {
    const posted: unknown[] = [];
    const fake: ChannelLike = {
      postMessage: (m) => posted.push(m),
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const factory = vi.fn(() => fake);
    const ch = createChannel<Msgs>('custom', { channelFactory: factory, tabId: 't1' });
    ch.post('count', 3);
    ch.close();
    expect(factory).toHaveBeenCalledWith('tabmesh:ch:custom');
    expect(posted[0]).toMatchObject({ t: 'msg', type: 'count', payload: 3, from: 't1' });
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('isolates handler errors so other handlers still run', async () => {
    const name = uniq('ch');
    const a = make(name);
    const b = make(name);
    const errors: unknown[] = [];
    const onError = (e: unknown): void => {
      errors.push(e);
    };
    process.on('uncaughtException', onError);
    const good = vi.fn();
    b.on('ping', () => {
      throw new Error('boom');
    });
    b.on('ping', good);
    a.post('ping');
    await waitFor(() => good.mock.calls.length === 1);
    await tick();
    process.off('uncaughtException', onError);
    expect(good).toHaveBeenCalledOnce();
  });
});
