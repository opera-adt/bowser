/**
 * Areas in the time-series chart: the polygons a user can pick, the POST /polygon_timeseries
 * request, and the chart series built from its answer (median, mean and the p10–p90 band).
 *
 * The server summarises stored values (the cube's own reference). When the viewer's reference
 * is on, the caller passes the reference values the map uses (one per date) and they are
 * subtracted here, so an area and a point are on the same footing. Subtracting one number per
 * date shifts the median, mean and every percentile by that number; the spread is unchanged.
 */
import type { ChartArea, Overlay } from '../types';

import { AREA_PERCENTILES, areaRows, type AreaRow } from './areaStats';
import { areaStyle, withOpacity, type AreaStyle } from '../map/seriesStyle';

export { AREA_PERCENTILES };

/** The band drawn around an area's lines: mean ± 1 std (default) or p10–p90. */
export type AreaBand = 'std' | 'pct';
export const AREA_BAND_LABELS: Record<AreaBand, string> = { std: 'mean ± 1 std', pct: 'p10–p90' };

const BAND_KEY = 'bowser-area-band';

/** The band this viewer chose last (per browser), mean ± 1 std until then. */
export function readAreaBand(): AreaBand {
  try {
    return localStorage.getItem(BAND_KEY) === 'pct' ? 'pct' : 'std';
  } catch {
    return 'std';
  }
}

export function saveAreaBand(band: AreaBand): void {
  try { localStorage.setItem(BAND_KEY, band); } catch { /* this session only */ }
}

export interface PolygonStatistics {
  count: number;
  mean: number | null;
  median: number | null;
  spatial_std: number | null;
  minimum: number | null;
  maximum: number | null;
  percentiles: Record<string, number | null>;
}

export interface PolygonTimeSeries {
  labels: string[];
  units: string | null;
  statistics: PolygonStatistics[];
  polygon_pixels?: number;
  common_pixels?: number;
  warnings?: string[];
}

/** A polygon on the map that can become a chart area. */
export interface PolygonChoice {
  key: string;
  name: string;
  geometry: ChartArea['geometry'];
  source: NonNullable<ChartArea['source']>;
}

/** A point feature that can become a time-series point. */
export interface PointChoice {
  key: string;
  name: string;
  /** [lat, lon], as TimeSeriesPoint.position. */
  position: [number, number];
}

interface GeoJsonFeature {
  geometry?: { type?: string; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
}

/** A feature's own name (name, Name, NAME, title or label), else ``fallback``. */
export function featureName(properties: Record<string, unknown> | null | undefined, fallback: string): string {
  const p = properties ?? {};
  const own = [p.name, p.Name, p.NAME, p.title, p.label].find(v => typeof v === 'string' && v.trim());
  return own ? String(own) : fallback;
}

const isPolygon = (g: GeoJsonFeature['geometry']) => g?.type === 'Polygon' || g?.type === 'MultiPolygon';
const isPoint = (g: GeoJsonFeature['geometry']) =>
  g?.type === 'Point' && Array.isArray(g.coordinates) && g.coordinates.length >= 2
  && g.coordinates.slice(0, 2).every(v => typeof v === 'number' && Number.isFinite(v));

/** Polygons drawn with the Draw tools or read from vector files, in layer order. */
export function polygonChoices(overlays: Overlay[]): PolygonChoice[] {
  const out: PolygonChoice[] = [];
  for (const o of overlays) {
    if (o.type !== 'vector' || !o.data) continue;
    let n = 0;
    (o.data.features as GeoJsonFeature[]).forEach((f, i) => {
      const g = f?.geometry;
      if (!g || !isPolygon(g)) return;
      n += 1;
      out.push({
        key: `${o.id}:${i}`,
        name: featureName(f.properties, `${o.name} ${n}`),
        geometry: { type: g.type as 'Polygon' | 'MultiPolygon', coordinates: g.coordinates },
        source: { overlayId: o.id, layer: o.name, index: i },
      });
    });
  }
  return out;
}

/** A vector layer's point features, named like its polygons ("<layer> N" without a name). */
export function pointChoices(o: Overlay): PointChoice[] {
  if (o.type !== 'vector' || !o.data) return [];
  const out: PointChoice[] = [];
  (o.data.features as GeoJsonFeature[]).forEach((f, i) => {
    if (!isPoint(f?.geometry)) return;
    const [lon, lat] = f.geometry!.coordinates as number[];
    out.push({ key: `${o.id}:${i}`, name: featureName(f.properties, `${o.name} ${out.length + 1}`), position: [lat, lon] });
  });
  return out;
}

/** Whether a layer has polygons or points to summarise (lines alone have none). */
export function zonalKinds(o: Overlay): { polygons: number; points: number } {
  if (o.type !== 'vector' || !o.data) return { polygons: 0, points: 0 };
  const features = o.data.features as GeoJsonFeature[];
  return {
    polygons: features.filter(f => isPolygon(f?.geometry)).length,
    points: features.filter(f => isPoint(f?.geometry)).length,
  };
}

/** Where an area's statistics for a layer are kept (AppState.areaStats). */
export const areaStatsKey = (dataset: string, areaId: string) => `${dataset}::${areaId}`;

/** The request body: the cube's own values on the dates' common pixels. */
export function polygonRequestBody(variable: string, geometry: ChartArea['geometry']) {
  return { variable, geometry, support: 'common' as const, percentiles: [...AREA_PERCENTILES] };
}

/** A short message for a failed request (422 bad or too-large polygon, 501 on bowser-lite). */
export function polygonErrorMessage(status: number, body: unknown): string {
  if (status === 501) return 'needs the full Bowser server';
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail) && typeof detail[0]?.msg === 'string') {
    return detail[0].msg.replace(/^Value error, /, '');
  }
  return `request failed (HTTP ${status})`;
}

/** Why an answer can't be drawn (no pixel had a value), or null when it can. */
export function polygonEmptyMessage(result: PolygonTimeSeries): string | null {
  return result.statistics.some(r => r.count > 0 && r.median !== null) ? null : 'no valid pixels inside the area';
}

export interface AreaSeriesOptions {
  result: PolygonTimeSeries;
  name: string;
  color: string;
  /** Data → display unit (displayUnit(...).factor). */
  factor: number;
  unit: string;
  yAxisID: string;
  /** The reference value per date (state.refValues[dataset]) when the viewer's reference is on. */
  reference: number[] | null;
  /**
   * The chosen reference date's index in ``result.labels`` (Main › Layers › ref), or null: each
   * line is then taken off its own value on that date, as point series are; -1 when the date
   * is not among the answer's (nothing can be drawn, as for a point).
   */
  refIndex?: number | null;
  /** The band: mean ± 1 std (default) or p10–p90. */
  band?: AreaBand;
  /** Line width and style, mean and band on or off, band opacity (Style button); defaults otherwise. */
  style?: Partial<AreaStyle>;
  /** A label → the chart's x value. */
  toX: (label: string) => string;
  /** Whether an x value is inside the chosen date range. */
  inRange: (x: string) => boolean;
}

/**
 * The Chart.js datasets for one area, all in its colour: the band's upper and lower edges
 * (the upper fills down to the lower; they must stay adjacent), the median and the dashed mean.
 * The std band is the mean ± the spatial std on each date (the std itself is never shifted).
 */
export function areaChartDatasets(o: AreaSeriesOptions): Record<string, unknown>[] {
  const relative = o.reference !== null || (o.refIndex ?? null) !== null;
  const band = o.band ?? 'std';
  const rows = o.refIndex === -1 ? [] : areaRows(o.result, o.reference, o.refIndex ?? null);
  const series = (pick: (r: AreaRow) => number | null) => {
    const out: { x: string; y: number }[] = [];
    for (const row of rows) {
      const v = pick(row);
      if (v === null || !Number.isFinite(v)) continue;
      const x = o.toX(row.label);
      if (o.inRange(x)) out.push({ x, y: v * o.factor });
    }
    return out;
  };
  const withStd = (sign: 1 | -1) => (r: AreaRow) => (r.mean !== null && r.std !== null ? r.mean + sign * r.std : null);
  const [lo, hi] = AREA_PERCENTILES;
  const edges = band === 'std'
    ? [{ label: '+1 std', pick: withStd(1) }, { label: '−1 std', pick: withStd(-1) }]
    : [{ label: `p${hi}`, pick: (r: AreaRow) => r.p90 }, { label: `p${lo}`, pick: (r: AreaRow) => r.p10 }];
  const bandName = `${o.name} ${AREA_BAND_LABELS[band]}`;
  const look = areaStyle(o.style ?? {});
  const common = {
    _area: true, _unit: o.unit, _note: relative ? 'relative to the reference' : undefined,
    yAxisID: o.yAxisID, tension: 0, borderColor: o.color, pointHoverRadius: 0,
    order: 1,  // behind the points (Chart.js draws higher orders first)
  };
  const bandSets = [
    {
      ...common, label: `${o.name} ${edges[0].label}`, _baseLabel: bandName, _legend: bandName,
      data: series(edges[0].pick),
      fill: '+1', backgroundColor: withOpacity(o.color, look.bandOpacity), borderWidth: 0, pointRadius: 0,
    },
    {
      ...common, label: `${o.name} ${edges[1].label}`, _baseLabel: bandName,
      data: series(edges[1].pick),
      fill: false, backgroundColor: 'transparent', borderWidth: 0, pointRadius: 0,
    },
  ];
  const median = {
    ...common, label: `${o.name} median`, _baseLabel: `${o.name} median`, _legend: `${o.name} median`,
    data: series(r => r.median),
    fill: false, backgroundColor: o.color, borderWidth: look.lineWidth, pointRadius: 0, pointHoverRadius: 3,
    showLine: look.line !== 'none', ...(look.line === 'dashed' ? { borderDash: [6, 4] } : {}),
  };
  const mean = {
    ...common, label: `${o.name} mean`, _baseLabel: `${o.name} mean`, _legend: `${o.name} mean`,
    data: series(r => r.mean),
    fill: false, backgroundColor: 'transparent', borderWidth: look.lineWidth, borderDash: [6, 4], pointRadius: 0,
  };
  return [...(look.showBand ? bandSets : []), median, ...(look.showMean ? [mean] : [])];
}
