import { describe, expect, it, vi } from 'vitest';
import { electLeader } from '../src/index.js';
import { tick, uniq, waitFor } from './helpers.js';

describe('electLeader (Web Locks)', () => {
  it('elects exactly one leader and fails over when it abdicates', async () => {
    const name = uniq('leader');
    const tabs = [electLeader(name), electLeader(name), electLeader(name)];
    await tabs[0]?.whenLeader;
    await tick();
    expect(tabs.filter((t) => t.isLeader)).toHaveLength(1);
    expect(tabs[0]?.isLeader).toBe(true);

    tabs[0]?.abdicate();
    await tabs[1]?.whenLeader;
    expect(tabs[0]?.isLeader).toBe(false);
    expect(tabs[1]?.isLeader).toBe(true);
    expect(tabs[2]?.isLeader).toBe(false);

    tabs[1]?.abdicate();
    await tabs[2]?.whenLeader;
    expect(tabs[2]?.isLeader).toBe(true);
    tabs[2]?.abdicate();
  });

  it('runs onLeader and its cleanup, and notifies subscribers', async () => {
    const cleanup = vi.fn();
    const onLeader = vi.fn(() => cleanup);
    const election = electLeader(uniq('leader'), { onLeader });
    const changes: boolean[] = [];
    election.subscribe((v) => changes.push(v));
    await election.whenLeader;
    expect(onLeader).toHaveBeenCalledOnce();
    election.abdicate();
    election.abdicate();
    await waitFor(() => changes.length === 2);
    expect(changes).toEqual([true, false]);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('a waiting candidate can withdraw without ever leading', async () => {
    const name = uniq('leader');
    const leader = electLeader(name);
    await leader.whenLeader;
    const onLeader = vi.fn();
    const candidate = electLeader(name, { onLeader });
    candidate.abdicate();
    leader.abdicate();
    const next = electLeader(name);
    await next.whenLeader;
    await tick();
    expect(onLeader).not.toHaveBeenCalled();
    expect(candidate.isLeader).toBe(false);
    next.abdicate();
  });

  it('respects an AbortSignal', async () => {
    const controller = new AbortController();
    const election = electLeader(uniq('leader'), { signal: controller.signal });
    await election.whenLeader;
    controller.abort();
    await waitFor(() => !election.isLeader);

    const pre = electLeader(uniq('leader'), { signal: AbortSignal.abort() });
    await tick();
    expect(pre.isLeader).toBe(false);
  });

  it('accepts a custom lock manager and throws without one', async () => {
    const request = vi.fn((_name: string, _opts: unknown, cb: () => Promise<unknown>) => cb());
    const election = electLeader('custom', { locks: { request } });
    await election.whenLeader;
    expect(request.mock.calls[0]?.[0]).toBe('tabmesh:leader:custom');
    election.abdicate();

    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    try {
      expect(() => electLeader('x')).toThrow(/Web Locks/);
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original);
    }
  });
});
