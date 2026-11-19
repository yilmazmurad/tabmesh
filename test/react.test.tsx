// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor as rtlWaitFor } from '@testing-library/react';
import { locks as nodeLocks } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LockManagerLike } from '../src/index.js';
import { createChannel, createSharedStore, type SharedStore } from '../src/index.js';
import { useIsLeader, useSharedStore, useTabChannel } from '../src/react.js';
import { uniq, waitFor } from './helpers.js';

const stores: SharedStore<unknown>[] = [];
afterEach(() => {
  cleanup();
  for (const s of stores.splice(0)) s.close();
});

function Counter({ store }: { store: SharedStore<number> }) {
  const [count, setCount] = useSharedStore(store);
  return (
    <button type="button" onClick={() => setCount((c) => c + 1)}>
      count:{count}
    </button>
  );
}

describe('react hooks', () => {
  it('useSharedStore re-renders on local and remote updates', async () => {
    const name = uniq('react-store');
    const mine = createSharedStore(name, 0);
    const otherTab = createSharedStore(name, 0);
    stores.push(mine as SharedStore<unknown>, otherTab as SharedStore<unknown>);
    render(<Counter store={mine} />);
    expect(screen.getByRole('button').textContent).toBe('count:0');
    act(() => screen.getByRole('button').click());
    expect(screen.getByRole('button').textContent).toBe('count:1');
    await waitFor(() => otherTab.get() === 1);
    await act(async () => {
      otherTab.set(41);
      await waitFor(() => mine.get() === 41);
    });
    expect(screen.getByRole('button').textContent).toBe('count:41');
  });

  it('useIsLeader reflects leadership and releases on unmount', async () => {
    const name = uniq('react-leader');
    // jsdom's navigator has no Web Locks, so inject Node's implementation (stable reference).
    const locks = nodeLocks as unknown as LockManagerLike;
    function Badge() {
      return <span>{useIsLeader(name, { locks }) ? 'leader' : 'follower'}</span>;
    }
    const first = render(<Badge />);
    await rtlWaitFor(() => expect(first.container.textContent).toBe('leader'));
    const second = render(<Badge />);
    expect(second.container.textContent).toBe('follower');
    first.unmount();
    await rtlWaitFor(() => expect(second.container.textContent).toBe('leader'));
  });

  it('useTabChannel posts and receives with the latest handler', async () => {
    const name = uniq('react-ch');
    type M = { hi: string };
    const otherTab = createChannel<M>(name);
    const received = vi.fn();
    otherTab.on('hi', received);
    const seen: string[] = [];
    let post: ((type: 'hi', payload: string) => void) | undefined;
    function Chat({ prefix }: { prefix: string }) {
      post = useTabChannel<M>(name, { hi: (text) => seen.push(prefix + text) });
      return null;
    }
    const view = render(<Chat prefix="a:" />);
    await act(async () => undefined);
    act(() => post?.('hi', 'from-react'));
    await waitFor(() => received.mock.calls.length === 1);
    expect(received.mock.calls[0]?.[0]).toBe('from-react');

    view.rerender(<Chat prefix="b:" />);
    otherTab.post('hi', 'there');
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual(['b:there']);
    otherTab.close();
  });
});
