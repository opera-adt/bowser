/** Moving through a layer's time steps: the panel's arrows and play, and the map's date badge. */

/** ``next`` kept within a layer's ``count`` steps (0 when it has none). */
export function clampTimeIndex(next: number, count: number): number {
  return Math.max(0, Math.min(count - 1, next));
}

/** Play speeds offered on right-click of the arrows, in time steps per second. */
export const PLAY_SPEEDS = [0.5, 1, 2, 4] as const;
export const DEFAULT_PLAY_SPEED = 1;

const STORAGE_KEY = 'bowser-play-speed';

export function readPlaySpeed(): number {
  try {
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    return (PLAY_SPEEDS as readonly number[]).includes(saved) ? saved : DEFAULT_PLAY_SPEED;
  } catch {
    return DEFAULT_PLAY_SPEED;
  }
}

export function savePlaySpeed(speed: number): void {
  try { localStorage.setItem(STORAGE_KEY, String(speed)); } catch { /* this session only */ }
}
