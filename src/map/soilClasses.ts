/**
 * How the soils layer is coloured: the InSAR classes (soils.ts), or any attribute of the
 * map units in view, with as many classes as asked for (the rest grouped as "Other").
 */
import { SOIL_CLASSES } from './soils';
import type { Overlay } from '../types';

export type SoilField = 'class' | 'order' | 'drainage' | 'flooding' | 'soil' | 'map_unit'
  | 'hydric_pct' | 'shrink_swell_lep_pct' | 'organic_matter_pct';

export const SOIL_FIELDS: { key: SoilField; label: string; numeric?: boolean }[] = [
  { key: 'class', label: 'InSAR classes (peat, clay, wet)' },
  { key: 'order', label: 'Soil order (taxonomy)' },
  { key: 'drainage', label: 'Drainage class' },
  { key: 'flooding', label: 'Flooding frequency' },
  { key: 'soil', label: 'Main soil component' },
  { key: 'map_unit', label: 'Map unit' },
  { key: 'hydric_pct', label: 'Hydric soils (%)', numeric: true },
  { key: 'shrink_swell_lep_pct', label: 'Shrink-swell, LEP (%)', numeric: true },
  { key: 'organic_matter_pct', label: 'Organic matter (%)', numeric: true },
];

const CATEGORICAL = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#17becf', '#bcbd22', '#393b79', '#ad494a', '#7f7f7f'];
const SEQUENTIAL = ['#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#bd0026', '#800026'];
export const OTHER_COLOR = '#a3a3a3';

type Props = Record<string, unknown> | null | undefined;
type Feature = { properties?: Props };

const fmt = (v: number) => String(+v.toPrecision(3));

/** Most classes a layer shows; the rest are grouped as "Other". */
export const MAX_CLASSES = 60;

const hex = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const toHex = (rgb: number[]) => `#${rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** ``n`` colours along the sequential ramp, light to dark, interpolated so each class has its own. */
function ramp(n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (i * (SEQUENTIAL.length - 1)) / Math.max(1, n - 1);
    const k = Math.min(SEQUENTIAL.length - 2, Math.floor(t));
    const [a, b] = [hex(SEQUENTIAL[k]), hex(SEQUENTIAL[k + 1])];
    return toHex(a.map((v, j) => v + (b[j] - v) * (t - k)));
  });
}

/** The i-th categorical colour: the 12 base colours, then distinct hues spread by the golden angle. */
export function categoricalColor(i: number): string {
  if (i < CATEGORICAL.length) return CATEGORICAL[i];
  const h = ((i - CATEGORICAL.length) * 137.508 + 20) % 360;
  const l = [0.45, 0.6, 0.35][Math.floor((i - CATEGORICAL.length) / 12) % 3];
  const s = 0.65;
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return 255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return toHex([f(0), f(8), f(4)]);
}

/** The overlay fields that colour soils by ``field`` with at most ``maxClasses`` classes. */
export function soilColoring(features: Feature[], field: SoilField, maxClasses: number): Pick<Overlay, 'classColors' | 'legend'> {
  if (field === 'class') return { classColors: { property: 'class', classes: SOIL_CLASSES }, legend: SOIL_CLASSES };
  const n = Math.max(2, Math.min(MAX_CLASSES, Math.round(maxClasses)));
  const def = SOIL_FIELDS.find(f => f.key === field);
  if (def?.numeric) {
    const values = features.map(feat => feat.properties?.[field]).filter(v => v !== null && v !== undefined && v !== '')
      .map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const lo = values[0] ?? 0;
    const hi = values[values.length - 1] ?? 0;
    const distinct = [...new Set(values)];
    let breaks: number[];
    let labels: string[];
    if (distinct.length <= n) {
      // Few values (hydric % is mostly 0 or 100): one class each.
      breaks = distinct.slice(1);
      labels = distinct.map(fmt);
    } else {
      // Quantiles, unless ties collapse them (then equal steps between min and max).
      breaks = [...new Set(Array.from({ length: n - 1 }, (_, i) => values[Math.floor(((i + 1) * values.length) / n)]))]
        .filter(v => v > lo && v < hi);
      if (breaks.length < n - 1) breaks = Array.from({ length: n - 1 }, (_, i) => lo + ((i + 1) * (hi - lo)) / n);
      const edges = [lo, ...breaks, hi];
      labels = edges.slice(0, -1).map((e, i) => `${fmt(e)}–${fmt(edges[i + 1])}`);
    }
    const colors = ramp(labels.length);
    const classes: [string, string][] = labels.map((l, i) => [l, colors[i]]);
    return {
      classColors: { property: field, classes, breaks, other: OTHER_COLOR },
      legend: [...classes, ['no data', OTHER_COLOR]],
    };
  }
  const counts = new Map<string, number>();
  for (const feat of features) {
    const v = feat.properties?.[field];
    if (v !== null && v !== undefined && v !== '') counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
  const keep = ranked.length > n ? ranked.slice(0, n - 1) : ranked;
  const classes: [string, string][] = keep.map((v, i) => [v, categoricalColor(i)]);
  const rest = ranked.length - keep.length;
  return {
    classColors: { property: field, classes, other: OTHER_COLOR },
    legend: [...classes, [rest > 0 ? `Other (${rest} more)` : 'Other / no data', OTHER_COLOR]],
  };
}

/** The MapLibre colour expression for class colours (match on text, step on numbers). */
export function classColorExpression(cc: NonNullable<Overlay['classColors']>, fallback: string): unknown {
  const other = cc.other ?? fallback;
  if (cc.breaks) {
    const step: unknown[] = ['step', ['to-number', ['get', cc.property]], cc.classes[0]?.[1] ?? other];
    cc.breaks.forEach((b, i) => step.push(b, cc.classes[i + 1]?.[1] ?? other));
    return ['case', ['==', ['typeof', ['get', cc.property]], 'number'], step, other];
  }
  return ['match', ['to-string', ['get', cc.property]], ...cc.classes.flatMap(([label, c]) => [label, c]), other];
}
