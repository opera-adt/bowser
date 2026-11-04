/**
 * The time-series model chosen in the chart's Model card (as in the OPERA DISP portal):
 * polynomial order, seasonal terms, segment breaks, steps and outlier rejection, with
 * dates kept as YYYY-MM-DD. fit.ts does the least squares; this file adapts the chart's
 * series to it and says what came out.
 */
import { fitModel, type FitModel, type FitResult } from './fit';

export interface FitSettings {
  polyOrder: 0 | 1 | 2 | 3;
  annual: boolean;
  semiannual: boolean;
  steps: string[];
  breaks: string[];
  rejectOutliers: boolean;
}

export const DEFAULT_FIT: FitSettings = { polyOrder: 1, annual: false, semiannual: false, steps: [], breaks: [], rejectOutliers: false };

const DAY_MS = 86_400_000;
const isoMs = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

export function toFitModel(s: FitSettings): FitModel {
  return { ...s, steps: s.steps.map(isoMs), breaks: s.breaks.map(isoMs) };
}

export function modelLabel(s: FitSettings): string {
  const parts = [['offset', 'linear', 'quadratic', 'cubic'][s.polyOrder]];
  if (s.annual) parts.push('annual');
  if (s.semiannual) parts.push('semi-annual');
  if (s.breaks.length) parts.push(`${s.breaks.length + 1} segments`);
  if (s.steps.length) parts.push(`${s.steps.length} step(s)`);
  if (s.rejectOutliers) parts.push('3σ outliers');
  return parts.join(' + ');
}

/** Fit a chart series ({x: YYYY-MM-DD…, y}) in its own units; null when there are too few epochs. */
export function fitSeries(points: { x: string; y: number }[], s: FitSettings): FitResult | null {
  const pts = points.filter(p => Number.isFinite(p.y)).map(p => ({ t: isoMs(p.x), value: p.y }));
  return pts.length >= 3 ? fitModel(pts, toFitModel(s)) : null;
}

/**
 * The model drawn as a line: every few days across each segment, with a gap (null) between
 * segments and on both sides of a step so jumps aren't drawn as slopes.
 */
export function modelCurve(fit: FitResult, everyDays = 6): { x: string; y: number | null }[] {
  const cuts = [...fit.model.steps].sort((a, b) => a - b);
  const out: { x: string; y: number | null }[] = [];
  fit.segments.forEach((g, i) => {
    if (i > 0) out.push({ x: isoDay(g.t0 - DAY_MS / 2), y: null });
    const bounds = [g.t0, ...cuts.filter(c => c > g.t0 && c < g.t1), g.t1];
    bounds.slice(0, -1).forEach((a, j) => {
      const b = bounds[j + 1];
      if (j > 0) out.push({ x: isoDay(a - DAY_MS / 2), y: null });
      for (let t = a; t < b; t += everyDays * DAY_MS) out.push({ x: isoDay(t), y: fit.predict(t) });
      out.push({ x: isoDay(b - (j < bounds.length - 2 ? DAY_MS : 0)), y: fit.predict(b - (j < bounds.length - 2 ? DAY_MS : 0)) });
    });
  });
  return out;
}

/** R² of the fit on the points it used. */
export function rSquared(points: { x: string; y: number }[], fit: FitResult): number {
  const used = points.filter((p, i) => Number.isFinite(p.y) && fit.used[i] !== false);
  if (used.length < 2) return 0;
  const mean = used.reduce((a, p) => a + p.y, 0) / used.length;
  const tot = used.reduce((a, p) => a + (p.y - mean) ** 2, 0);
  const res = used.reduce((a, p) => a + (p.y - fit.predict(isoMs(p.x))) ** 2, 0);
  return tot > 0 ? 1 - res / tot : 0;
}

/**
 * The fit in words: values times ``mm`` (default 1), labelled ``unit`` (default mm when ``mm``
 * is given, otherwise "units"); inches get two decimals.
 */
export function describeFit(fit: FitResult | null, mm: number | null, unit = ''): string {
  if (!fit) return 'model not estimable (too few epochs for the chosen terms)';
  const k = mm ?? 1;
  const u = unit || (mm !== null ? 'mm' : 'units');
  const d = u === 'in' ? 2 : 1;
  const f = (v: number, dp = d) => `${v * k >= 0 ? '+' : ''}${(v * k).toFixed(dp)}`;
  const e = (v: number) => (v * k).toFixed(d);
  const m = fit.model;
  const parts: string[] = [];
  if (fit.segments.length > 1) {
    for (const g of fit.segments) parts.push(`${isoDay(g.t0)}…${isoDay(g.t1)}: ${f(g.rate)} ± ${e(g.rateStd)} ${u}/yr`);
  } else if (m.polyOrder >= 1) {
    parts.push(`rate ${f(fit.rate)} ± ${e(fit.rateStd)} ${u}/yr`);
    if (m.polyOrder >= 2) parts.push(`mean rate ${f(fit.meanRate)} ${u}/yr`, `accel ${f(2 * fit.coefficients[2], 2)} ${u}/yr²`);
  }
  if (fit.annual) parts.push(`annual ${e(fit.annual.amplitude)} ± ${e(fit.annual.amplitudeStd)} ${u} (peak DOY ${fit.annual.peakDoy})`);
  if (fit.semiannual) parts.push(`semi-annual ${e(fit.semiannual.amplitude)} ± ${e(fit.semiannual.amplitudeStd)} ${u}`);
  for (const s of fit.steps) parts.push(`step ${isoDay(s.t)} ${f(s.size)} ± ${e(s.std)} ${u}`);
  if (fit.droppedSteps.length) parts.push(`step(s) ${fit.droppedSteps.map(isoDay).join(', ')} not estimable`);
  if (fit.droppedBreaks.length) parts.push(`break(s) ${fit.droppedBreaks.map(isoDay).join(', ')} dropped (too few epochs)`);
  parts.push(`RMS ${e(fit.rms)} ${u}`);
  if (fit.nOutliers) parts.push(`${fit.nOutliers} outlier(s) excluded`);
  return parts.join(' · ');
}
