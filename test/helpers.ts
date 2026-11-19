export const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(condition: () => boolean, timeout = 1000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error('waitFor: timed out');
    await tick(5);
  }
}

let counter = 0;
/** Unique channel name per test so tests never interfere with each other. */
export const uniq = (base: string): string => `${base}-${process.pid}-${++counter}-${Math.random().toString(36).slice(2)}`;

export class MemoryStorage {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}
