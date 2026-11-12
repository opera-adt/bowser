import { useEffect, useState } from 'react';

/**
 * Diagnostics ("debug mode"): extra messages about how the page works, such as which
 * renderer draws the data layer and why. Off by default; the Project tab's bug icon
 * turns it on (kept in this browser), and so does ``?debug=1`` in the address.
 */
export const DEBUG_KEY = 'bowser.debug';
const DEBUG_EVENT = 'bowser-debug';

export function debugOn(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get('debug') === '1') return true;
    return localStorage.getItem(DEBUG_KEY) === '1';
  } catch {
    return false;   // private mode or no window: off
  }
}

export function setDebug(on: boolean): void {
  try {
    if (on) localStorage.setItem(DEBUG_KEY, '1');
    else localStorage.removeItem(DEBUG_KEY);
  } catch { /* not kept */ }
  window.dispatchEvent(new Event(DEBUG_EVENT));
}

/** Whether diagnostics are on; follows the toggle (also from another tab). */
export function useDebug(): boolean {
  const [on, setOn] = useState(debugOn);
  useEffect(() => {
    const update = () => setOn(debugOn());
    window.addEventListener(DEBUG_EVENT, update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(DEBUG_EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, []);
  return on;
}
