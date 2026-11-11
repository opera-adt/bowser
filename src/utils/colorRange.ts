/** The "2–98%" range of a layer's histogram, rounded as the button sets it. */
export function percentileRange(stats: { p2: number; p98: number }): [number, number] {
  return [parseFloat(stats.p2.toFixed(4)), parseFloat(stats.p98.toFixed(4))];
}

/**
 * True when a colour range is kept for this layer: one the viewer chose earlier
 * (MainTab keeps it per layer in localStorage) or one a loaded project put there.
 */
export function hasStoredRange(dataset: string): boolean {
  try {
    return localStorage.getItem(`${dataset}-vmin`) !== null || localStorage.getItem(`${dataset}-vmax`) !== null;
  } catch {
    return false;
  }
}
