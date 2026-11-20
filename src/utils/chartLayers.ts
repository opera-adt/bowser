import type { RasterGroup } from '../types';

type Layers = { [key: string]: RasterGroup };

/**
 * True when a layer has more than one step to plot. Velocity and other 2-D cube
 * variables have an empty axis; a single-file COG layer has one entry.
 */
export function hasTimeAxis(info: RasterGroup | undefined): boolean {
  return Array.isArray(info?.x_values) && info.x_values.length > 1;
}

/** Names of the layers a time-series chart can show, in catalogue order. */
export function timeSeriesLayers(layers: Layers): string[] {
  return Object.keys(layers).filter(name => hasTimeAxis(layers[name]));
}

/**
 * The layer a chart shows when it follows the map: the map's layer if it has a
 * time axis, otherwise displacement, otherwise the first layer with a time axis.
 */
export function chartLayerFor(current: string, layers: Layers): string | null {
  if (hasTimeAxis(layers[current])) return current;
  const names = timeSeriesLayers(layers);
  return names.find(name => name.toLowerCase() === 'displacement')
    ?? names.find(name => name.toLowerCase().includes('displacement'))
    ?? names[0]
    ?? null;
}

/**
 * The window's layer list after picking `added` from "+ layer…". A window that
 * follows the map (empty list) keeps the layer it shows and adds the new one,
 * so the chart gets both layers instead of swapping one for the other.
 */
export function addChartLayer(chosen: string[], followed: string | null, added: string): string[] {
  const shown = chosen.length > 0 ? chosen : (followed ? [followed] : []);
  return shown.includes(added) ? shown : [...shown, added];
}

/**
 * The time step of ``date`` on a layer's axis: its own position there, or null when the layer
 * has no step on that day. A chart point's position in its series is not that: a mask or a
 * date range leaves a series with fewer dates than the layer.
 */
export function timeIndexOfDate(xValues: readonly (string | number)[] | undefined, date: string | number): number | null {
  const day = (v: string | number) => {
    const s = String(v);
    const tail = s.includes('_') ? s.split('_').pop()! : s;
    return /^\d{8}$/.test(tail) ? `${tail.slice(0, 4)}-${tail.slice(4, 6)}-${tail.slice(6, 8)}` : tail.slice(0, 10);
  };
  const wanted = day(date);
  const i = (xValues ?? []).findIndex(v => day(v) === wanted);
  return i >= 0 ? i : null;
}

/** A chart series' observed values: a point's data, a buffer median, an area median. */
const OBSERVED = new Set(['data', 'median', 'area_median']);

type ChartPoint = { x?: unknown } | null | undefined;
type ChartSeries = { hidden?: boolean; data?: ChartPoint[]; _series?: { role?: string } };

/**
 * The date of the observed chart point nearest ``time`` (ms), for a click on the chart.
 * Fitted models, residuals and area bands are left out: their dates are not acquisitions,
 * and in the chart's "index" interaction their index does not line up with the data's.
 * Null when no observed series has a point.
 */
export function observedDateNear(datasets: readonly ChartSeries[], time: number): string | null {
  let best: string | null = null;
  let bestGap = Infinity;
  for (const series of datasets) {
    if (series.hidden || !OBSERVED.has(series._series?.role ?? '')) continue;
    for (const point of series.data ?? []) {
      const x = point && typeof point === 'object' ? point.x : undefined;
      if (typeof x !== 'string') continue;
      const gap = Math.abs(Date.parse(x.length === 10 ? `${x}T00:00:00Z` : x) - time);
      if (gap < bestGap) { bestGap = gap; best = x; }
    }
  }
  return best;
}
