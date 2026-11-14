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

/** One diagnostic message: when it was said, and whether it reports a problem. */
export interface DebugMessage { at: number; text: string; warn: boolean }

/** The most messages kept (oldest go first). */
export const DEBUG_MESSAGES_MAX = 100;
const MESSAGES_EVENT = 'bowser-debug-messages';
let messages: DebugMessage[] = [];

/**
 * Note a diagnostic message (also in the console). Kept whether or not diagnostics are
 * on, so turning them on shows what led to the current state; the same message twice
 * in a row is noted once.
 */
export function debugMessage(text: string, warn = false): void {
  if (messages[messages.length - 1]?.text === text) return;
  messages = [...messages, { at: Date.now(), text, warn }].slice(-DEBUG_MESSAGES_MAX);
  (warn ? console.warn : console.info)(`[bowser] ${text}`);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(MESSAGES_EVENT));
}

/** Forget the messages (tests). */
export function clearDebugMessages(): void {
  messages = [];
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(MESSAGES_EVENT));
}

/** Every diagnostic message so far, oldest first; follows new ones. */
export function useDebugMessages(): DebugMessage[] {
  const [list, setList] = useState(messages);
  useEffect(() => {
    const update = () => setList(messages);
    update();
    window.addEventListener(MESSAGES_EVENT, update);
    return () => window.removeEventListener(MESSAGES_EVENT, update);
  }, []);
  return list;
}
