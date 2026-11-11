/**
 * What a time series can support: gaps, thin months, noise and lasting jumps (`seriesChecks`,
 * ported from the OPERA DISP Portal's series checks with its real test series,
 * tests/data/series_checks_cases.json), and what may be wrong in it (`seriesFlags`): one-date
 * outliers, and jumps or outliers of about half the radar wavelength (or a multiple), the size an
 * unwrapping error leaves. The chart tool `check_series` (src/assistant/chartTools.ts) runs both.
 */

// Thresholds set on real series (Three Sisters, Ridgecrest, Parkfield, Houston, Okmok, Central Valley).
const GAP_DAYS = 90;
const JUMP_WINDOW = 5;
const JUMP_MIN_MM = 10;
const JUMP_MIN_SCATTER = 6;
const THIN_MONTH_SHARE = 0.25;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86400000;
const YEAR_DAYS = 365.25;

/** A date (epoch ms, UTC) and a value in metres. */
export interface SeriesPoint {
  t: number;
  value: number;
}

export interface SeriesChecks {
  masked: number;
  span_years: number;
  gaps: { from: string; to: string; days: number }[];
  months_thin: string[];
  scatter_mm: number;
  /** Net trend over the record divided by the scatter; null when there is no scatter to compare. */
  trend_vs_noise: number | null;
  /** Lasting offsets: the last date before and the first date after, with the median change across them. */
  jumps: { before: string; after: string; size_mm: number; across_gap: boolean }[];
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

function linearRate(x: number[], y: number[]): number {
  const mx = x.reduce((a, b) => a + b, 0) / x.length;
  const my = y.reduce((a, b) => a + b, 0) / y.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < x.length; i++) {
    num += (x[i] - mx) * (y[i] - my);
    den += (x[i] - mx) ** 2;
  }
  return den > 0 ? num / den : 0;
}

/** Epoch-to-epoch scatter (mm): the robust spread of the date-to-date changes, per date. */
function scatterOf(mm: number[]): number {
  const diffs = mm.slice(1).map((v, i) => v - mm[i]);
  const mid = diffs.length ? median(diffs) : 0;
  return diffs.length ? (1.4826 * median(diffs.map((d) => Math.abs(d - mid)))) / Math.SQRT2 : 0;
}

/** Gaps, thin months, scatter, trend against the noise and lasting jumps of a series (dates in order). */
export function seriesChecks(points: SeriesPoint[], masked = 0): SeriesChecks {
  const mm = points.map((p) => p.value * 1000);
  const days = points.map((p) => Math.round(p.t / DAY_MS));
  const steps = days.slice(1).map((d, i) => d - days[i]);
  const gaps = steps.flatMap((s, i) => (s >= GAP_DAYS ? [{ from: day(points[i].t), to: day(points[i + 1].t), days: s }] : []));
  const counts = new Array<number>(12).fill(0);
  for (const p of points) counts[new Date(p.t).getUTCMonth()] += 1;
  const thinBelow = THIN_MONTH_SHARE * median(counts);
  const diffs = mm.slice(1).map((v, i) => v - mm[i]);
  const scatter = scatterOf(mm);
  const years = points.length ? (days[days.length - 1] - days[0]) / YEAR_DAYS : 0;
  const rate = linearRate(days.map((d) => d / YEAR_DAYS), mm);
  const offsets: { off: number; i: number }[] = [];
  for (let i = JUMP_WINDOW; i <= mm.length - JUMP_WINDOW; i++) offsets.push({ off: median(mm.slice(i, i + JUMP_WINDOW)) - median(mm.slice(i - JUMP_WINDOW, i)), i });
  offsets.sort((a, b) => Math.abs(b.off) - Math.abs(a.off) || a.i - b.i);
  const picked: typeof offsets = [];
  for (const o of offsets) {
    if (Math.abs(o.off) >= Math.max(JUMP_MIN_MM, JUMP_MIN_SCATTER * scatter) && picked.every((p) => Math.abs(p.i - o.i) >= JUMP_WINDOW)) picked.push(o);
  }
  picked.sort((a, b) => a.i - b.i);
  return {
    masked,
    span_years: round1(years),
    gaps,
    months_thin: MONTHS.filter((_, i) => counts[i] < thinBelow),
    scatter_mm: round1(scatter),
    trend_vs_noise: scatter > 0 ? round1((Math.abs(rate) * years) / scatter) : null,
    jumps: picked.map((o) => {
      // the windows tie around a step: date it at the largest single change in the jump's direction
      const sign = Math.sign(o.off);
      let j = Math.max(1, o.i - JUMP_WINDOW + 1);
      for (let k = j; k < Math.min(mm.length, o.i + JUMP_WINDOW); k++) if (sign * diffs[k - 1] > sign * diffs[j - 1]) j = k;
      return { before: day(points[j - 1].t), after: day(points[j].t), size_mm: round1(o.off), across_gap: steps[j - 1] >= GAP_DAYS };
    }),
  };
}

// ── what may be wrong: outliers and unwrapping-sized jumps ─────────────────────────────

/** An outlier differs from the dates around it by this many scatters (and OUTLIER_MIN_MM). */
const OUTLIER_SCATTER = 5;
const OUTLIER_MIN_MM = 10;
/** Dates on each side whose median an outlier is compared with. */
const OUTLIER_WINDOW = 3;
/** A jump within this share of k × half a wavelength (k = 1-3) is unwrapping-sized. */
const UNWRAP_TOLERANCE = 0.2;
const UNWRAP_MAX_CYCLES = 3;

export interface UnwrapMatch {
  /** The jump is about ``cycles`` × half the radar wavelength. */
  cycles: number;
  half_wavelength_mm: number;
}

export interface SeriesFlags {
  /** Lasting jumps (seriesChecks), with the date a model step would go at and whether the size fits an unwrapping error. */
  steps: { before: string; after: string; step_date: string; size_mm: number; change_mm: number; across_gap: boolean; possible_unwrapping: UnwrapMatch | null }[];
  /** Single dates far from the dates on both sides (the neighbours agreeing with each other). */
  outliers: { date: string; offset_mm: number; possible_unwrapping: UnwrapMatch | null }[];
}

/** k when |size| is within UNWRAP_TOLERANCE of k half wavelengths, else null. */
export function unwrapMatch(sizeMm: number, wavelengthM: number | null): UnwrapMatch | null {
  if (!wavelengthM || !(wavelengthM > 0)) return null;
  const half = (wavelengthM * 1000) / 2;
  const k = Math.round(Math.abs(sizeMm) / half);
  if (k < 1 || k > UNWRAP_MAX_CYCLES) return null;
  return Math.abs(Math.abs(sizeMm) - k * half) <= UNWRAP_TOLERANCE * half ? { cycles: k, half_wavelength_mm: round1(half) } : null;
}

/** Steps (from seriesChecks' jumps), outliers and unwrapping-sized changes of a series (dates in order, values in metres). */
export function seriesFlags(points: SeriesPoint[], checks: SeriesChecks, wavelengthM: number | null): SeriesFlags {
  const mm = points.map((p) => p.value * 1000);
  const index = new Map(points.map((p, i) => [day(p.t), i]));
  const steps = checks.jumps.map((j) => {
    const i = index.get(j.after) ?? 0;
    const change = i > 0 ? mm[i] - mm[i - 1] : 0;
    // The lasting change (median windows) or the change between the two dates, whichever fits.
    const match = unwrapMatch(j.size_mm, wavelengthM) ?? unwrapMatch(change, wavelengthM);
    return { ...j, step_date: j.after, change_mm: round1(change), possible_unwrapping: match };
  });
  const scatter = scatterOf(mm);
  const limit = Math.max(OUTLIER_MIN_MM, OUTLIER_SCATTER * scatter);
  const outliers: SeriesFlags['outliers'] = [];
  for (let i = 1; i < mm.length - 1; i++) {
    const around = [...mm.slice(Math.max(0, i - OUTLIER_WINDOW), i), ...mm.slice(i + 1, i + 1 + OUTLIER_WINDOW)];
    const off = mm[i] - median(around);
    // A spike, not the edge of a step: both neighbours are on the same side and close to each other.
    const spike = Math.sign(mm[i] - mm[i - 1]) === Math.sign(mm[i] - mm[i + 1]) && Math.abs(mm[i - 1] - mm[i + 1]) < Math.abs(off) / 2;
    if (Math.abs(off) >= limit && spike) {
      outliers.push({ date: day(points[i].t), offset_mm: round1(off), possible_unwrapping: unwrapMatch(off, wavelengthM) });
    }
  }
  return { steps, outliers };
}

// ── the radar wavelength ─────────────────────────────────────────────────────────────

/** Sentinel-1 (C band) and NISAR (L band) wavelengths, m. */
export const SENTINEL1_WAVELENGTH = 0.05546576;
export const NISAR_L_WAVELENGTH = 0.23840545;

/**
 * The radar wavelength of a cube, m, and where it came from: the cube's own metadata
 * (``radar_wavelength_m`` of GET /datasets), else the sensor named in the layers' text, else null.
 */
export function cubeWavelength(layers: Record<string, { radar_wavelength_m?: number | null; description?: string; source_description?: string | null; label?: string }>):
  { m: number | null; source: string } {
  for (const info of Object.values(layers)) {
    const w = info.radar_wavelength_m;
    if (typeof w === 'number' && w > 0) return { m: w, source: 'cube metadata' };
  }
  const text = Object.entries(layers).map(([name, i]) => `${name} ${i.label ?? ''} ${i.description ?? ''} ${i.source_description ?? ''}`).join(' ');
  if (/nisar|l-band/i.test(text)) return { m: NISAR_L_WAVELENGTH, source: "NISAR L band, named in the layers' descriptions" };
  if (/sentinel-?1|disp-s1|c-band/i.test(text)) return { m: SENTINEL1_WAVELENGTH, source: "Sentinel-1 C band, named in the layers' descriptions" };
  return { m: null, source: 'unknown: give wavelength_m' };
}
