[English](README.md) | **Türkçe**

# tabmesh

[![CI](https://github.com/yilmazmurad/tabmesh/actions/workflows/ci.yml/badge.svg)](https://github.com/yilmazmurad/tabmesh/actions/workflows/ci.yml)
![lisans](https://img.shields.io/badge/lisans-MIT-blue)
![bağımlılık](https://img.shields.io/badge/ba%C4%9F%C4%B1ml%C4%B1l%C4%B1k-0-brightgreen)

**TypeScript ve React 19 için sıfır bağımlılıklı, tip güvenli sekmeler arası (cross-tab) araç seti.**
Kullanıcılar uygulamanızı çok sayıda sekmede açar. `tabmesh`, yalnızca modern web platformu API'lerini kullanarak bu sekmelerin uyum içinde çalışmasını sağlar:

- 📨 **Tipli mesajlaşma**: Mesaj tiplerini ve payload'ları TypeScript'in denetlediği bir `BroadcastChannel` sarmalayıcısı.
- 🔄 **Paylaşılan durum (state)**: Sekmeler arasında senkronize edilen bir store. Çakışmaları **Lamport saatiyle son-yazan-kazanır** yöntemiyle çözer, böylece tüm sekmeler aynı değerde buluşur. Yeni açılan sekmelere anlık görüntü (snapshot) aktarır ve isteğe bağlı olarak `localStorage` ile kalıcılık sağlar.
- 👑 **Lider seçimi**: **Web Locks API** üzerine kurulu bir mekanizmayla tam olarak bir sekme lider olur. Lider sekme kapandığında tarayıcı liderliği otomatik olarak başka bir sekmeye devreder. Heartbeat ya da polling gerekmez.
- ⚛️ **React hook'ları**: `tabmesh/react` içinden `useSharedStore` (`useSyncExternalStore` tabanlı), `useIsLeader` ve `useTabChannel`.

Tipik kullanım alanları: "her yerden çıkış yap", tema veya sepeti sekmeler arasında paylaşmak, WebSocket bağlantısını, polling döngüsünü veya token yenilemeyi yalnızca lider sekmede çalıştırıp sonuçları diğer sekmelere yayınlamak.

## Özellikler

- Çalışma zamanı bağımlılığı yoktur. React isteğe bağlı bir peer bağımlılıktır ve yalnızca `tabmesh/react` için gerekir.
- Tam `.d.ts` tipleriyle gelen ESM paketidir. Tarayıcılarda, Web Worker'larda, Deno'da, Bun'da ve Node.js ≥ 20'de çalışır (Node.js 24'te `navigator.locks` de bulunur).
- Mesajlar bir zarf (envelope) içinde taşınır. Hatalı veya yabancı mesajlar yok sayılır. İsteğe bağlı `validate` koruyucusu güvenilmeyen değerleri reddeder.
- Taşıma katmanı (`channelFactory`) ve kilit yöneticisi (`locks`) dışarıdan verilebilir. Bu sayede test etmek ve uyarlamak kolaydır.
- Bir handler'ın fırlattığı hata diğer handler'ları bozmaz. Tüm `close()`/`abdicate()` çağrıları idempotenttir ve `AbortSignal` desteklenir.

## Kurulum

```bash
npm install github:yilmazmurad/tabmesh
# veya
bun add github:yilmazmurad/tabmesh
```

Paket, kurulum sırasında (`prepare` script'iyle) otomatik olarak derlenir.

## Kullanım

### Tipli mesajlaşma

```ts
import { createChannel } from 'tabmesh';

type AuthEvents = {
  logout: { reason: string };
  ping: undefined;
};

const auth = createChannel<AuthEvents>('auth');

auth.on('logout', ({ reason }, meta) => {
  console.log(`${meta.from} sekmesi çıkış yaptı: ${reason}`);
  location.assign('/login');
});

auth.post('logout', { reason: 'user-clicked' }); // ✅ tip denetimli
auth.post('ping');                                // ✅ payload gerekmez
// auth.post('logout', { why: 1 });               // ❌ derleme hatası

const next = await auth.once('ping', { signal: AbortSignal.timeout(5000) });
```

### Paylaşılan durum

```ts
import { createSharedStore } from 'tabmesh';

type Theme = 'light' | 'dark';
const isTheme = (v: unknown): v is Theme => v === 'light' || v === 'dark';

export const theme = createSharedStore<Theme>('theme', 'light', {
  storage: localStorage, // isteğe bağlı: yeni sekmeler son değerle başlar
  validate: isTheme,     // isteğe bağlı: diğer sekmelerden/depolamadan gelen geçersiz değerleri yok say
});

theme.subscribe((value, source) => {
  document.documentElement.dataset.theme = value; // source: 'local' | 'remote'
});

theme.set('dark');                                         // tüm sekmeler güncellenir
theme.set((prev) => (prev === 'dark' ? 'light' : 'dark')); // updater biçimi
```

Çakışmalar şöyle çözülür: Her yazma işlemi `{ v, by: tabId }` biçimindeki mantıksal saati bir artırır. Bir sekme, uzak bir değeri yalnızca *daha yeniyse* kabul eder (daha büyük `v`; eşitlik durumunda sekme kimliği belirler). Böylece eşzamanlı yazmalar tüm sekmelerde aynı değerde buluşur. Yeni açılan bir sekme, diğer sekmelerden anlık görüntü ister.

### Lider seçimi

```ts
import { createChannel, electLeader } from 'tabmesh';

const bus = createChannel<{ notification: unknown }>('live');

const election = electLeader('notifications', {
  onLeader() {
    const ws = new WebSocket('wss://example.com/live'); // yalnızca TEK sekme bağlanır
    ws.onmessage = (e) => bus.post('notification', JSON.parse(e.data));
    return () => ws.close(); // liderlik bitince temizlik
  },
});

await election.whenLeader;   // bu sekme lider olunca resolve olur
election.isLeader;           // boolean
election.subscribe((isLeader) => console.log({ isLeader }));
election.abdicate();         // liderliği başka sekmeye devret
```

### React 19

```tsx
import { createSharedStore } from 'tabmesh';
import { useIsLeader, useSharedStore, useTabChannel } from 'tabmesh/react';

const cart = createSharedStore<string[]>('cart', [], { storage: localStorage });

function CartButton() {
  const [items, setItems] = useSharedStore(cart);
  return <button onClick={() => setItems((xs) => [...xs, 'kitap'])}>Sepet ({items.length})</button>;
}

function LeaderBadge() {
  const isLeader = useIsLeader('sync');
  return <span>{isLeader ? '👑 lider sekme' : 'takipçi sekme'}</span>;
}

function LogoutButton() {
  const post = useTabChannel<{ logout: undefined }>('auth', {
    logout: () => location.assign('/login'),
  });
  return <button onClick={() => post('logout')}>Her yerden çıkış yap</button>;
}
```

## API özeti

| Fonksiyon | Açıklama |
| --- | --- |
| `createChannel<M>(name, { tabId?, channelFactory? })` | `post`, `on`, `once`, `close` içeren tipli kanal |
| `createSharedStore<T>(name, initial, { storage?, validate?, tabId?, channelFactory?, requestSnapshot? })` | `get`, `set`, `subscribe`, `clock`, `close` içeren senkron store |
| `electLeader(name, { onLeader?, signal?, locks? })` | `isLeader`, `whenLeader`, `subscribe`, `abdicate` içeren lider seçimi |
| `isNewer(a, b)` | İki Lamport saatini karşılaştırır |
| `useSharedStore(store)` | Paylaşılan store için `[value, set]` döndürür |
| `useIsLeader(name, { onLeader?, locks? })` | Bu sekme liderken `true` döndürür |
| `useTabChannel<M>(name, handlers?, options?)` | Mesajları dinler ve sabit bir `post` döndürür |

## Geliştirme

```bash
npm install
npm test           # vitest (29 test; Node 24'te gerçek BroadcastChannel + Web Locks, React için jsdom)
npm run typecheck  # tsc --noEmit (strict)
npm run lint       # eslint + typescript-eslint (strict)
npm run build      # dist/ klasörüne ESM + .d.ts üretir
npm run check      # yukarıdakilerin hepsi
```

## Lisans

[MIT](LICENSE) © 2026 Murat Yılmaz
