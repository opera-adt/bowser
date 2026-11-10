/**
 * How many of the Assistant's questions wait for the user (a signed-in agent's requests to run a
 * tool), so the panel's rail can show a badge on the Assistant tab while another tab is open.
 */
import { useSyncExternalStore } from 'react';

let waiting = 0;
const listeners = new Set<() => void>();

export function setWaiting(n: number): void {
  if (n === waiting) return;
  waiting = n;
  listeners.forEach(l => l());
}

export function useWaiting(): number {
  return useSyncExternalStore(
    l => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => waiting,
  );
}
