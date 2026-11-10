/** The page channel's browser side: subscribe, run each command, post the answer, say when focused. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPageChannel } from './pageChannel';

class FakeEventSource {
  static last: FakeEventSource;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeEventSource.last = this; }
  send(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent); }
  close() { this.closed = true; }
}

let posts: { url: string; body: any }[];
let focused: boolean;
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  posts.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
  return new Response('{"ok":true}');
});
const doc = { hasFocus: () => focused, visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers();
  posts = [];
  focused = true;
  fetchMock.mockClear();
});
afterEach(() => vi.useRealTimers());

const flush = async () => { await vi.advanceTimersByTimeAsync(0); };

describe('page channel', () => {
  it('runs each command through the page tools and posts the answer with its id', async () => {
    const run = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'fly_to') return { ok: true, center: [input.lon, input.lat] };
      throw new Error('No layer "x".');
    });
    const stop = startPageChannel({ run, EventSource: FakeEventSource as never, fetch: fetchMock as never, win: window, doc: doc as never });
    const es = FakeEventSource.last;
    expect(es.url).toMatch(/^\/page\/events\?page=[A-Za-z0-9_-]{12}$/);
    const page = es.url.split('=')[1];
    es.send({ type: 'hello', page });
    es.send({ type: 'command', id: 'c1', name: 'fly_to', input: { lon: -90.1, lat: 34.8 } });
    await flush();
    expect(run).toHaveBeenCalledWith('fly_to', { lon: -90.1, lat: 34.8 });
    expect(posts).toContainEqual({ url: '/page/result', body: { page, id: 'c1', ok: true, result: { ok: true, center: [-90.1, 34.8] } } });
    es.send({ type: 'command', id: 'c2', name: 'switch_layer', input: { layer: 'x' } });
    await flush();
    expect(posts).toContainEqual({ url: '/page/result', body: { page, id: 'c2', ok: false, error: 'No layer "x".' } });
    stop();
    expect(es.closed).toBe(true);
  });

  it('says when it has the focus: on open, on focus and every few seconds, not when unfocused', async () => {
    const stop = startPageChannel({ run: vi.fn(), EventSource: FakeEventSource as never, fetch: fetchMock as never, win: window, doc: doc as never, heartbeat: 5 });
    const es = FakeEventSource.last;
    const page = es.url.split('=')[1];
    es.onopen?.();
    await flush();
    expect(posts).toEqual([{ url: '/page/focus', body: { page, focused: true } }]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(posts).toHaveLength(2);
    focused = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(posts).toHaveLength(2);
    focused = true;
    await vi.advanceTimersByTimeAsync(1500);
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(posts).toHaveLength(3);
    stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(posts).toHaveLength(3);
  });
});
