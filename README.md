**English** | [Türkçe](README.tr.md)

# tabmesh

[![CI](https://github.com/yilmazmurad/tabmesh/actions/workflows/ci.yml/badge.svg)](https://github.com/yilmazmurad/tabmesh/actions/workflows/ci.yml)
![license](https://img.shields.io/badge/license-MIT-blue)
![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

**Zero-dependency, type-safe cross-tab toolkit for TypeScript and React 19.**
Users open your app in many tabs. `tabmesh` keeps them coordinated using only modern web platform APIs:

- 📨 **Typed messaging** – a `BroadcastChannel` wrapper where message types and payloads are checked by TypeScript.
- 🔄 **Shared state** – a store synced across tabs, with **Lamport-clock last-writer-wins** conflict resolution so every tab converges to the same value, plus snapshot hand-off to newly opened tabs and optional `localStorage` persistence.
- 👑 **Leader election** – exactly one tab is the leader, built on the **Web Locks API**. When the leader tab closes, the browser hands leadership to another tab automatically. No heartbeats or polling.
- ⚛️ **React hooks** – `useSharedStore` (built on `useSyncExternalStore`), `useIsLeader` and `useTabChannel` from `tabmesh/react`.

Common uses: "log out everywhere", sharing a theme or cart between tabs, running a single WebSocket / polling loop / token refresh in the leader tab only, and broadcasting its results to the others.

## Features

- No runtime dependencies. React is an optional peer dependency and is only needed for `tabmesh/react`.
- ESM with full `.d.ts` types. Works in browsers, Web Workers, Deno, Bun and Node.js ≥ 20 (Node.js 24 also has `navigator.locks`).
- Messages are wrapped in an envelope. Malformed or foreign messages are ignored, and an optional `validate` guard rejects untrusted values.
- The transport (`channelFactory`) and lock manager (`locks`) are injectable, which keeps everything easy to test or adapt.
- Errors thrown by one handler can't break the others. Every `close()`/`abdicate()` is idempotent and `AbortSignal` is supported.

## Installation

```bash
npm install github:yilmazmurad/tabmesh
# or
bun add github:yilmazmurad/tabmesh
```

The package is built automatically during install (via the `prepare` script).

## Usage

### Typed messaging

```ts
import { createChannel } from 'tabmesh';

type AuthEvents = {
  logout: { reason: string };
  ping: undefined;
};

const auth = createChannel<AuthEvents>('auth');

auth.on('logout', ({ reason }, meta) => {
  console.log(`tab ${meta.from} logged out: ${reason}`);
  location.assign('/login');
});

auth.post('logout', { reason: 'user-clicked' }); // ✅ type-checked
auth.post('ping');                                // ✅ no payload needed
// auth.post('logout', { why: 1 });               // ❌ compile error

const next = await auth.once('ping', { signal: AbortSignal.timeout(5000) });
```

### Shared state

```ts
import { createSharedStore } from 'tabmesh';

type Theme = 'light' | 'dark';
const isTheme = (v: unknown): v is Theme => v === 'light' || v === 'dark';

export const theme = createSharedStore<Theme>('theme', 'light', {
  storage: localStorage, // optional: new tabs start from the last value
  validate: isTheme,     // optional: ignore invalid values from other tabs / storage
});

theme.subscribe((value, source) => {
  document.documentElement.dataset.theme = value; // source: 'local' | 'remote'
});

theme.set('dark');                                       // every tab updates
theme.set((prev) => (prev === 'dark' ? 'light' : 'dark')); // updater form
```

How conflicts are resolved: each write increments a logical clock `{ v, by: tabId }`. A tab accepts a remote value only when it is *newer* (a higher `v`, with ties broken by tab id). This makes concurrent writes converge to the same value in every tab. When a tab opens, it asks its peers for a snapshot.

### Leader election

```ts
import { createChannel, electLeader } from 'tabmesh';

const bus = createChannel<{ notification: unknown }>('live');

const election = electLeader('notifications', {
  onLeader() {
    const ws = new WebSocket('wss://example.com/live'); // only ONE tab connects
    ws.onmessage = (e) => bus.post('notification', JSON.parse(e.data));
    return () => ws.close(); // cleanup when leadership ends
  },
});

await election.whenLeader;   // resolves when this tab becomes leader
election.isLeader;           // boolean
election.subscribe((isLeader) => console.log({ isLeader }));
election.abdicate();         // hand over to another tab
```

### React 19

```tsx
import { createSharedStore } from 'tabmesh';
import { useIsLeader, useSharedStore, useTabChannel } from 'tabmesh/react';

const cart = createSharedStore<string[]>('cart', [], { storage: localStorage });

function CartButton() {
  const [items, setItems] = useSharedStore(cart);
  return <button onClick={() => setItems((xs) => [...xs, 'book'])}>Cart ({items.length})</button>;
}

function LeaderBadge() {
  const isLeader = useIsLeader('sync');
  return <span>{isLeader ? '👑 leader tab' : 'follower tab'}</span>;
}

function LogoutButton() {
  const post = useTabChannel<{ logout: undefined }>('auth', {
    logout: () => location.assign('/login'),
  });
  return <button onClick={() => post('logout')}>Log out everywhere</button>;
}
```

## API overview

| Function | Description |
| --- | --- |
| `createChannel<M>(name, { tabId?, channelFactory? })` | Typed channel with `post`, `on`, `once`, `close` |
| `createSharedStore<T>(name, initial, { storage?, validate?, tabId?, channelFactory?, requestSnapshot? })` | Synced store with `get`, `set`, `subscribe`, `clock`, `close` |
| `electLeader(name, { onLeader?, signal?, locks? })` | Leader election with `isLeader`, `whenLeader`, `subscribe`, `abdicate` |
| `isNewer(a, b)` | Compares two Lamport clocks |
| `useSharedStore(store)` | `[value, set]` for a shared store |
| `useIsLeader(name, { onLeader?, locks? })` | `true` while this tab is the leader |
| `useTabChannel<M>(name, handlers?, options?)` | Listens to messages and returns a stable `post` |

## Development

```bash
npm install
npm test           # vitest (29 tests, real BroadcastChannel + Web Locks in Node 24, jsdom for React)
npm run typecheck  # tsc --noEmit (strict)
npm run lint       # eslint + typescript-eslint (strict)
npm run build      # emit ESM + .d.ts to dist/
npm run check      # all of the above
```

## License

[MIT](LICENSE) © 2026 Murat Yılmaz
