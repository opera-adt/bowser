/**
 * The page channel's browser side: Bowser's tools act on this page (src/bowser/assistant/page.py).
 *
 * The page listens on GET /page/events with a random id, runs each command it receives through
 * the same page tools the Assistant uses (./pageTools.ts) and posts the answer to
 * POST /page/result. It tells the server when it has the focus (POST /page/focus, on focus and
 * every few seconds while focused), so with several tabs open only the one the user last looked
 * at acts. The server opens the channel only on the user's own computer (BOWSER_ASSISTANT_PAGE_KEYS);
 * elsewhere the stream is refused and the page stops trying.
 */

export interface ChannelCommand { type: 'command'; id: string; name: string; input: Record<string, unknown> }

export interface ChannelOptions {
  /** Runs a page tool; throws with a message for the model. */
  run: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  /** Tests give their own; the browser's otherwise. */
  EventSource?: typeof EventSource;
  fetch?: typeof fetch;
  win?: Window;
  doc?: Document;
  /** Seconds between focus heartbeats. */
  heartbeat?: number;
}

export const HEARTBEAT_SECONDS = 10;

/** A random id for this page (letters, digits, - and _). */
export function newPageId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'[b % 64]).join('');
}

/** Open the channel; returns the function that closes it. */
export function startPageChannel(opts: ChannelOptions): () => void {
  const ES = opts.EventSource ?? window.EventSource;
  const post = opts.fetch ?? window.fetch.bind(window);
  const win = opts.win ?? window;
  const doc = opts.doc ?? document;
  const page = newPageId();
  let closed = false;

  const send = (path: string, body: unknown) =>
    post(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .catch(() => undefined);
  let last = 0;
  const focus = () => {
    // At most once a second (clicks also count as focus).
    if (closed || !doc.hasFocus() || Date.now() - last < 1000) return;
    last = Date.now();
    void send('/page/focus', { page, focused: true });
  };

  const es = new ES(`/page/events?page=${page}`);
  es.onopen = () => focus();
  es.onmessage = (e: MessageEvent) => {
    let msg: ChannelCommand;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type !== 'command') return;
    void (async () => {
      try {
        const result = await opts.run(msg.name, msg.input ?? {});
        await send('/page/result', { page, id: msg.id, ok: true, result: result ?? null });
      } catch (err) {
        await send('/page/result', { page, id: msg.id, ok: false, error: String((err as Error).message ?? err).slice(0, 2000) });
      }
    })();
  };
  // A refused stream (another computer, the gate off) is closed for good, not retried.
  es.onerror = () => { if (es.readyState === 2) closed = true; };

  const onVisible = () => { if (doc.visibilityState === 'visible') focus(); };
  win.addEventListener('focus', focus);
  doc.addEventListener('visibilitychange', onVisible);
  doc.addEventListener('pointerdown', focus);
  const timer = win.setInterval(focus, (opts.heartbeat ?? HEARTBEAT_SECONDS) * 1000);

  return () => {
    closed = true;
    es.close();
    win.removeEventListener('focus', focus);
    doc.removeEventListener('visibilitychange', onVisible);
    doc.removeEventListener('pointerdown', focus);
    win.clearInterval(timer);
  };
}
