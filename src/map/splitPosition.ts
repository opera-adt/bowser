/**
 * Where the split-screen divider stands, as a fraction of the map's width (0 = left edge).
 *
 * Kept outside the app's reducer because a drag sets it on every mouse move, and only the
 * divider and the two maps draw from it: in the reducer each move rendered the whole page.
 */
import { useSyncExternalStore } from 'react';

export const DEFAULT_SPLIT_POSITION = 0.5;

let position = DEFAULT_SPLIT_POSITION;
const listeners = new Set<() => void>();

export const getSplitPosition = (): number => position;

export function setSplitPosition(next: number): void {
  if (next === position) return;
  position = next;
  listeners.forEach(l => l());
}

export function useSplitPosition(): number {
  return useSyncExternalStore(
    l => { listeners.add(l); return () => { listeners.delete(l); }; },
    getSplitPosition,
  );
}
