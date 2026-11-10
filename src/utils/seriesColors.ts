/**
 * One palette for everything in the time-series chart: points clicked on the map, points and
 * polygons taken from a vector layer, and areas added with + Area. Each new series takes the
 * first colour nobody uses, so a point and an area never share one.
 */

/** Tableau 10, then its lighter half (Tableau 20): 20 colours before any repeats. */
export const SERIES_COLORS = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
  '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
  '#aec7e8', '#ffbb78', '#98df8a', '#ff9896', '#c5b0d5',
  '#c49c94', '#f7b6d2', '#c7c7c7', '#dbdb8d', '#9edae5',
] as const;

/** The first palette colour not in ``used``; once all are taken, they repeat in order. */
export function nextSeriesColor(used: Array<{ color: string }>): string {
  const taken = new Set(used.map(u => u.color));
  return SERIES_COLORS.find(c => !taken.has(c)) ?? SERIES_COLORS[used.length % SERIES_COLORS.length];
}
