/**
 * The area the map shows, as [south, west, north, east], or null before the map reports one.
 *
 * Kept outside the app's reducer because the map sets it after every move, and it is read
 * when something is asked for the view (stations, soils, a cropped animation), not drawn:
 * in the reducer each move rendered the whole page. Moving the map *to* a place is still
 * an action, APPLY_VIEW_BOUNDS.
 */
import { useSyncExternalStore } from 'react';

export type ViewBounds = [south: number, west: number, north: number, east: number];

let bounds: ViewBounds | null = null;
const listeners = new Set<() => void>();

export const getViewBounds = (): ViewBounds | null => bounds;

export function setViewBounds(next: ViewBounds | null): void {
  if (next === bounds || (next && bounds && next.every((v, i) => v === bounds![i]))) return;
  bounds = next;
  listeners.forEach(l => l());
}

/** The bounds a map reports, rounded to 6 decimals (about 0.1 m). */
export function roundedBounds(south: number, west: number, north: number, east: number): ViewBounds {
  const r = (v: number) => parseFloat(v.toFixed(6));
  return [r(south), r(west), r(north), r(east)];
}

/** For what draws from the view. What only needs it on a click reads getViewBounds() then. */
export function useViewBounds(): ViewBounds | null {
  return useSyncExternalStore(
    l => { listeners.add(l); return () => { listeners.delete(l); }; },
    getViewBounds,
  );
}
