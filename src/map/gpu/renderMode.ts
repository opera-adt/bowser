import { useEffect, useState } from 'react';
import { parseRenderMode, type RenderMode } from './capability';

/**
 * Which renderer the viewer asked for: server tiles (the default), the GPU, or automatic
 * (the GPU when the browser has a capable one). ``?render=`` in the address decides for
 * that visit; otherwise the Project tab's choice, kept in this browser.
 */
export const RENDER_KEY = 'bowser.render';
const RENDER_EVENT = 'bowser-render';

/** The order the Project tab's button goes through. */
export const RENDER_MODES: readonly RenderMode[] = ['tiles', 'auto', 'gpu'];

const isMode = (v: string | null): v is RenderMode => v === 'tiles' || v === 'auto' || v === 'gpu';

export function renderMode(): RenderMode {
  try {
    const search = window.location.search;
    if (isMode(new URLSearchParams(search).get('render'))) return parseRenderMode(search);
    const kept = localStorage.getItem(RENDER_KEY);
    return isMode(kept) ? kept : 'tiles';
  } catch {
    return 'tiles';   // private mode or no window: the default
  }
}

/** Keep ``mode`` for this browser. A ``?render=`` in the address would overrule it, so it goes. */
export function setRenderMode(mode: RenderMode): void {
  try {
    if (mode === 'tiles') localStorage.removeItem(RENDER_KEY);
    else localStorage.setItem(RENDER_KEY, mode);
  } catch { /* not kept */ }
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has('render')) {
      url.searchParams.delete('render');
      window.history.replaceState(window.history.state, '', url);
    }
  } catch { /* the address stays */ }
  window.dispatchEvent(new Event(RENDER_EVENT));
}

/** The renderer asked for; follows the Project tab's button (also from another tab). */
export function useRenderMode(): RenderMode {
  const [mode, setMode] = useState(renderMode);
  useEffect(() => {
    const update = () => setMode(renderMode());
    window.addEventListener(RENDER_EVENT, update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(RENDER_EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, []);
  return mode;
}
