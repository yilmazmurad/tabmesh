import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSharedStore, isNewer, type SharedStore } from '../src/index.js';
import { MemoryStorage, tick, uniq, waitFor } from './helpers.js';

const open: SharedStore<unknown>[] = [];
function make<T>(...args: Parameters<typeof createSharedStore<T>>): SharedStore<T> {
  const store = createSharedStore<T>(...args);
  open.push(store as SharedStore<unknown>);
  return store;
}
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

describe('isNewer', () => {
  it('orders by counter, then by tab id', () => {
    expect(isNewer({ v: 2, by: 'a' }, { v: 1, by: 'z' })).toBe(true);
    expect(isNewer({ v: 1, by: 'b' }, { v: 1, by: 'a' })).toBe(true);
    expect(isNewer({ v: 1, by: 'a' }, { v: 1, by: 'a' })).toBe(false);
    expect(isNewer({ v: 0, by: '' }, { v: 1, by: 'a' })).toBe(false);
  });
});

describe('createSharedStore', () => {
  it('syncs values between tabs and notifies subscribers with the source', async () => {
    const name = uniq('store');
    const a = make(name, { count: 0 });
    const b = make(name, { count: 0 });
    const seenA = vi.fn();
    const seenB = vi.fn();
    a.subscribe(seenA);
    b.subscribe(seenB);
    a.set((s) => ({ count: s.count + 1 }));
    expect(a.get()).toEqual({ count: 1 });
    expect(seenA).toHaveBeenCalledWith({ count: 1 }, 'local');
    await waitFor(() => b.get().count === 1);
    expect(seenB).toHaveBeenCalledWith({ count: 1 }, 'remote');
    expect(b.clock()).toEqual(a.clock());
  });

  it('a newly opened tab receives the current state via snapshot', async () => {
    const name = uniq('store');
    const a = make(name, 'light');
    a.set('dark');
    const late = make(name, 'light');
    expect(late.get()).toBe('light');
    await waitFor(() => late.get() === 'dark');
  });

  it('does not answer snapshots with an untouched initial value', async () => {
    const name = uniq('store');
    make(name, 'initial-a');
    const b = make(name, 'initial-b');
    await tick(40);
    expect(b.get()).toBe('initial-b');
  });

  it('concurrent writes converge to the same value in every tab', async () => {
    const name = uniq('store');
    const tabs = ['t1', 't2', 't3'].map((tabId) => make(name, 0, { tabId, requestSnapshot: false }));
    tabs[0]?.set(10);
    tabs[1]?.set(20);
    tabs[2]?.set(30);
    await tick(50);
    const values = tabs.map((t) => t.get());
    expect(new Set(values).size).toBe(1);
    // Same counter (1) everywhere, so the highest tab id wins deterministically.
    expect(values[0]).toBe(30);
  });

  it('later writes win over earlier ones (Lamport clock)', async () => {
    const name = uniq('store');
    const a = make(name, 0, { tabId: 'z' });
    const b = make(name, 0, { tabId: 'a' });
    a.set(1);
    await waitFor(() => b.get() === 1);
    b.set(2); // v=2 by "a" beats v=1 by "z"
    await waitFor(() => a.get() === 2);
    expect(a.clock()).toEqual({ v: 2, by: 'a' });
  });

  it('skips no-op updates', async () => {
    const name = uniq('store');
    const a = make(name, 5);
    const listener = vi.fn();
    a.subscribe(listener);
    a.set(5);
    a.set((x) => x);
    expect(listener).not.toHaveBeenCalled();
    expect(a.clock().v).toBe(0);
  });

  it('rejects invalid remote values when a validator is given', async () => {
    const name = uniq('store');
    const isNumber = (v: unknown): v is number => typeof v === 'number';
    const safe = make<number>(name, 0, { validate: isNumber });
    const evil = make<unknown>(name, 0);
    evil.set('not a number');
    await tick(40);
    expect(safe.get()).toBe(0);
    evil.set(9);
    await waitFor(() => safe.get() === 9);
  });

  it('persists to storage and restores on startup', () => {
    const storage = new MemoryStorage();
    const name = uniq('store');
    const a = make(name, [] as string[], { storage, requestSnapshot: false });
    a.set(['x']);
    a.close();
    const b = make(name, [] as string[], { storage, requestSnapshot: false });
    expect(b.get()).toEqual(['x']);
    expect(b.clock().v).toBe(1);
  });

  it('survives corrupt storage', () => {
    const storage = new MemoryStorage();
    const name = uniq('store');
    storage.setItem(`tabmesh:store:${name}`, '{not json');
    const s = make(name, 'fallback', { storage });
    expect(s.get()).toBe('fallback');
    const throwing = { getItem: () => 'null', setItem: () => { throw new Error('quota'); } };
    const t = make(uniq('store'), 1, { storage: throwing });
    expect(() => t.set(2)).not.toThrow();
  });

  it('stops syncing after close and throws on set', async () => {
    const name = uniq('store');
    const a = make(name, 0);
    const b = make(name, 0);
    b.close();
    b.close();
    a.set(1);
    await tick(30);
    expect(b.get()).toBe(0);
    expect(() => b.set(3)).toThrow(/closed/);
  });

  it('unsubscribe stops notifications', () => {
    const s = make(uniq('store'), 0, { requestSnapshot: false });
    const fn = vi.fn();
    const off = s.subscribe(fn);
    s.set(1);
    off();
    s.set(2);
    expect(fn).toHaveBeenCalledOnce();
  });
});
