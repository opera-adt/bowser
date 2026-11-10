/**
 * An area's statistics as shown: per date (reference taken off), at one date or averaged over
 * the record, the linear trend of the median, the area's bounds, and the Stats tab's CSV.
 */
import type { ChartArea } from '../types';
import { AREA_PERCENTILES, type PolygonTimeSeries } from './polygonSeries';
import { DEFAULT_FIT, fitSeries } from '../map/fitSettings';
import type { DisplayUnit } from './units';

export interface AreaRow {
  label: string;
  count: number;
  mean: number | null;
  median: number | null;
  std: number | null;
  p10: number | null;
  p90: number | null;
}

/** Convert "YYYYMMDD_YYYYMMDD" or "YYYYMMDD" → "YYYY-MM-DD" (secondary/only date).
 *
 * Stringify defensively: some datasets surface numeric x-values (e.g.
 * integer indices when a dim has no date coord), and Chart.js hands them
 * straight to us. Without this, `.includes` throws on the numeric branch.
 */
export function toIsoDate(xVal: string | number): string {
  const s = typeof xVal === 'string' ? xVal : String(xVal);
  const dateStr = s.includes('_') ? s.split('_').pop()! : s;
  if (/^\d{8}$/.test(dateStr)) {
    return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
  }
  return s;
}

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Each date's statistics in data units, minus ``reference[i]`` (the viewer's spatial reference
 * on that date) when given, and minus each statistic's own value at ``refIndex`` (a chosen
 * reference date) when given, as point series are. Subtracting one number per date shifts every
 * statistic alike; the spread (std) is not shifted. A value with no reference is null.
 */
export function areaRows(result: PolygonTimeSeries, reference: number[] | null, refIndex: number | null = null): AreaRow[] {
  const [lo, hi] = AREA_PERCENTILES.map(String);
  const rows = result.statistics.map((r, i) => {
    const ref = reference ? reference[i] : 0;
    const shift = (v: number | null | undefined) => (finite(v) && finite(ref) ? v - ref : null);
    return {
      label: String(result.labels[i]), count: r.count,
      mean: shift(r.mean), median: shift(r.median), std: finite(r.spatial_std) ? r.spatial_std : null,
      p10: shift(r.percentiles[lo]), p90: shift(r.percentiles[hi]),
    };
  });
  if (refIndex === null) return rows;
  const at = rows[refIndex];
  const less = (v: number | null, base: number | null | undefined) => (finite(v) && finite(base) ? v - base : null);
  return rows.map(r => ({
    ...r, mean: less(r.mean, at?.mean), median: less(r.median, at?.median), p10: less(r.p10, at?.p10), p90: less(r.p90, at?.p90),
  }));
}

/** The statistics averaged over every date that has them (the "whole record" view). */
export function recordAverage(rows: AreaRow[]): AreaRow {
  const avg = (pick: (r: AreaRow) => number | null) => {
    const v = rows.map(pick).filter(finite);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  return {
    label: 'all dates', count: Math.max(0, ...rows.map(r => r.count)),
    mean: avg(r => r.mean), median: avg(r => r.median), std: avg(r => r.std), p10: avg(r => r.p10), p90: avg(r => r.p90),
  };
}

/** The median's linear trend per year, in the shown unit's rate (mm/yr, in/yr), or null. */
export function medianTrend(rows: AreaRow[], toIso: (label: string) => string, unit: DisplayUnit): number | null {
  const points = rows.filter(r => finite(r.median)).map(r => ({ x: toIso(r.label), y: r.median! * unit.factor }));
  const fit = fitSeries(points, DEFAULT_FIT);
  return fit ? fit.rate * (unit.rate?.factor ?? 1) : null;
}

/** [south, west, north, east] of a Polygon or MultiPolygon, as APPLY_VIEW_BOUNDS takes. */
export function geometryBounds(geometry: ChartArea['geometry']): [number, number, number, number] | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const walk = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
      w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]);
    } else if (Array.isArray(c)) c.forEach(walk);
  };
  walk(geometry.coordinates);
  return Number.isFinite(w) ? [s, w, n, e] : null;
}

export interface StatsTableRow {
  name: string;
  layer: string;
  pixels: number | null;
  stats: AreaRow | null;
  trend: number | null;
}

/** The Stats tab's table as CSV: one line per area, values in the shown units. */
export function statsCsv(rows: StatsTableRow[], o: { dataset: string; when: string; unit: string; rateUnit: string; factor: number }): string {
  const num = (v: number | null | undefined, k = o.factor) => (finite(v) ? String(+(v * k).toPrecision(6)) : '');
  const quote = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const head = ['name', 'source', 'layer', 'date', 'pixels',
    `mean_${o.unit}`, `median_${o.unit}`, `std_${o.unit}`, `p10_${o.unit}`, `p90_${o.unit}`, `median_trend_${o.rateUnit}_per_yr`];
  const lines = rows.map(r => [
    quote(r.name), quote(r.layer), quote(o.dataset), quote(o.when), r.pixels === null ? '' : String(r.pixels),
    num(r.stats?.mean), num(r.stats?.median), num(r.stats?.std), num(r.stats?.p10), num(r.stats?.p90), num(r.trend, 1),
  ].join(','));
  return [head.join(','), ...lines].join('\n') + '\n';
}
