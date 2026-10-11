/**
 * Vitest setup. Node >= 25 defines its own global ``localStorage`` that shadows
 * jsdom's and has no working methods unless Node is started with
 * ``--localstorage-file``; give every test a fresh in-memory Storage instead.
 */
import { beforeEach } from 'vitest';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.has(key) ? this.data.get(key)! : null; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  removeItem(key: string) { this.data.delete(key); }
  setItem(key: string, value: string) { this.data.set(key, String(value)); }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true, writable: true });
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: globalThis.localStorage, configurable: true, writable: true });
  }
});
