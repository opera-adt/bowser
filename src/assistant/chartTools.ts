/**
 * The Assistant's chart tools: read exactly what the time-series chart shows (its series, the
 * fitted model and its terms with their errors), fit a model and add steps as the Model card
 * does, rename and restyle points and areas as the Points panel and the Style button do, set the
 * chart's layers, Display options and date range, export it, and check a series for steps,
 * outliers and unwrapping errors. Run by runPageTool (./pageTools.ts); their names, descriptions
 * and argument schemas are defined once, on the server (src/bowser/chart_tools.py).
 *
 * What the chart draws is read from the chart itself (./chartView.ts), so the numbers are those
 * on screen: the reference point and date, the masks, the date range and the units applied.
 */
import { describeFit, modelLabel, type FitSettings } from '../map/fitSettings';
import type { FitResult } from '../map/fit';
import { AREA_WIDTHS, areaStyle, LINES, MARKERS, type LineStyle, type MarkerShape } from '../map/seriesStyle';
import { timeSeriesLayers } from '../utils/chartLayers';
import { AREA_BAND_LABELS, type AreaBand } from '../utils/polygonSeries';
import { cubeWavelength, seriesChecks, seriesFlags } from '../utils/seriesChecks';
import { displayUnit } from '../utils/units';
import type { AppState, ChartArea, TimeSeriesPoint } from '../types';
import { CHART_TOOL_NAMES, getChart, type ChartHandle, type ChartSnapshot, type SeriesTag } from './chartView';
import { closeMatches, type PageContext } from './pageTools';

export { CHART_TOOL_NAMES };

/** Most values get_chart_data returns for one series, and for all of them. */
export const MAX_SERIES_VALUES = 2000;
export const MAX_TOTAL_VALUES = 4000;
/** Most steps or segment breaks in the model (as the Model card). */
const MAX_DATES = 20;
/** How long a tool waits for the chart to fetch and draw (the page channel waits 10 s). */
const WAIT_MS = 7000;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const isoMs = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

// ── the chart: open it and wait until it has drawn ──────────────────────────────────

function openChart(ctx: PageContext): void {
  if (!ctx.getState().showChart && !ctx.done.chartOpen) ctx.dispatch({ type: 'TOGGLE_CHART' });
  ctx.done.chartOpen = true;
}

/** Poll until ``ok`` holds (the state changes only after the next render), or give up. */
async function waitFor<T>(get: () => T, ok: (v: T) => boolean, ms = WAIT_MS): Promise<T> {
  const until = Date.now() + ms;
  let v = get();
  while (!ok(v) && Date.now() < until) {
    await sleep(40);
    v = get();
  }
  return v;
}

/** The chart, open and drawn; ``settled`` waits for a change to show (a new model, say). */
async function readyChart(ctx: PageContext, settled: (s: ChartSnapshot) => boolean = () => true): Promise<{ chart: ChartHandle; snap: ChartSnapshot }> {
  const s = ctx.getState();
  if (s.timeSeriesPoints.length === 0 && s.chartAreas.length === 0) {
    throw new Error('The chart has no points or areas: add one first (add_point).');
  }
  openChart(ctx);
  const snap = await waitFor(() => getChart()?.snapshot() ?? null,
    v => !!v && v.status !== 'loading' && drawsEveryPoint(ctx.getState(), v) && settled(v));
  const chart = getChart();
  if (!chart || !snap) throw new Error('The chart did not open.');
  if (snap.status === 'loading') throw new Error('The chart is still loading its data; try again in a moment.');
  if (snap.status === 'empty') throw new Error(`The chart has nothing to show: ${snap.message ?? 'no data'}`);
  return { chart, snap };
}

/** Whether the chart has drawn (or found masked) every visible point, on each of its layers. */
function drawsEveryPoint(state: AppState, snap: ChartSnapshot): boolean {
  if (snap.status !== 'ready') return true;
  const drawn = new Set(snap.datasets.flatMap(d => (d._series?.kind === 'point' ? [`${d._series.layer}|${d._series.id}`] : [])));
  const pointLayers = snap.layers.filter(ds => [...drawn].some(k => k.startsWith(`${ds}|`)));
  return state.timeSeriesPoints.filter(p => p.visible).every(p => pointLayers.every(ds => drawn.has(`${ds}|${p.id}`)));
}

// ── points and areas by id or name ──────────────────────────────────────────────────

function find<T extends { id: string; name: string }>(items: T[], ref: unknown, what: string): T {
  const want = String(ref ?? '').trim();
  if (!want) throw new Error(`Give the ${what}'s id or name.`);
  const hit = items.find(x => x.id === want) ?? items.find(x => x.name === want)
    ?? items.find(x => x.name.toLowerCase() === want.toLowerCase());
  if (hit) return hit;
  const names = items.map(x => x.name);
  const close = closeMatches(want, names);
  throw new Error(`No ${what} ${JSON.stringify(want)}${close.length ? ` (did you mean ${close.join(', ')}?)` : ''}. `
    + (names.length ? `${what[0].toUpperCase()}${what.slice(1)}s: ${names.join(', ')}.` : `There are no ${what}s.`));
}

const findPoint = (s: AppState, ref: unknown): TimeSeriesPoint => find(s.timeSeriesPoints, ref, 'point');
const findArea = (s: AppState, ref: unknown): ChartArea => find(s.chartAreas, ref, 'area');

const NAMED: Record<string, string> = {
  red: '#e53935', green: '#43a047', blue: '#1e88e5', orange: '#fb8c00', purple: '#8e24aa', black: '#000000',
  white: '#ffffff', gray: '#757575', grey: '#757575', yellow: '#fdd835', cyan: '#00acc1', magenta: '#d81b60',
  pink: '#ec407a', brown: '#6d4c41', teal: '#00897b',
};

/** A colour as the colour inputs give it (#rrggbb). */
function hexColor(v: unknown): string {
  const s = String(v ?? '').trim().toLowerCase();
  if (s in NAMED) return NAMED[s];
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  throw new Error(`Give color as #rrggbb or one of ${Object.keys(NAMED).join(', ')}.`);
}

function oneOf<T extends string>(v: unknown, options: readonly T[], what: string): T {
  if (typeof v === 'string' && (options as readonly string[]).includes(v)) return v as T;
  throw new Error(`${what} is one of ${options.join(', ')}.`);
}

// ── dates: within the series, and the nearest acquisition ────────────────────────────

/** The dates the chart's point series have (the shown range), else its layers' dates. */
function seriesDates(snap: ChartSnapshot, state: AppState): string[] {
  const out = new Set<string>();
  for (const d of snap.datasets) {
    const tag = d._series;
    if (tag && (tag.role === 'data' || tag.role === 'median' || tag.role === 'area_median')) {
      for (const p of d.data as { x: string }[]) out.add(String(p.x).slice(0, 10));
    }
  }
  if (!out.size) {
    for (const ds of snap.layers) for (const x of state.datasetInfo[ds]?.x_values ?? []) out.add(String(x).slice(0, 10));
  }
  return [...out].filter(d => ISO.test(d)).sort();
}

/** Check model dates against the series; a note for each that is not an acquisition. */
function checkDates(dates: unknown, what: string, all: string[]): { dates: string[]; notes: string[] } {
  if (!Array.isArray(dates)) throw new Error(`Give ${what} as a list of YYYY-MM-DD dates.`);
  if (dates.length > MAX_DATES) throw new Error(`At most ${MAX_DATES} ${what}.`);
  const out: string[] = [];
  const notes: string[] = [];
  const spacing = all.slice(1).map((d, i) => (isoMs(d) - isoMs(all[i])) / DAY_MS).sort((a, b) => a - b);
  const typical = spacing.length ? spacing[spacing.length >> 1] : 12;
  for (const raw of dates) {
    const d = String(raw ?? '');
    if (!ISO.test(d) || Number.isNaN(isoMs(d)) || day(isoMs(d)) !== d) throw new Error(`${JSON.stringify(raw)} is not a date (YYYY-MM-DD).`);
    if (all.length && (d <= all[0] || d > all[all.length - 1])) {
      throw new Error(`${d} is outside the series shown (${all[0]} to ${all[all.length - 1]}): a step or break needs dates on both sides.`);
    }
    out.push(d);
    if (all.includes(d)) continue;
    const next = all.find(a => a > d) as string;
    const prev = [...all].reverse().find(a => a < d) as string;
    const gap = (isoMs(next) - isoMs(prev)) / DAY_MS;
    const nearest = isoMs(d) - isoMs(prev) < isoMs(next) - isoMs(d) ? prev : next;
    notes.push(gap > Math.max(30, 3 * typical)
      ? `${d} falls in a ${gap}-day gap (${prev} to ${next}): the ${what === 'steps' ? 'step' : 'break'} takes all motion in the gap. The nearest acquisition is ${nearest}.`
      : `${d} is between the acquisitions ${prev} and ${next}; it acts at ${next} (nearest acquisition ${nearest}).`);
  }
  return { dates: [...new Set(out)].sort(), notes };
}

// ── what the chart shows ─────────────────────────────────────────────────────────────

type XY = { x: string; y: number | null };

interface SeriesOut {
  name: string;
  kind: SeriesTag['kind'];
  id: string;
  layer: string;
  unit: string;
  n: number;
  dates: string[];
  values: (number | null)[];
  [k: string]: unknown;
}

/** Every k-th value so a series keeps at most ``max`` (first and last kept). */
function thin<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const k = Math.ceil(rows.length / max);
  return rows.filter((_, i) => i % k === 0 || i === rows.length - 1);
}

function referenceOf(state: AppState, snap: ChartSnapshot) {
  const [lat, lon] = state.refMarkerPosition;
  return snap.layers.map(ds => {
    const info = state.datasetInfo[ds];
    const moving = !!info?.uses_spatial_ref && state.refEnabled;
    return {
      layer: ds,
      reference_point: moving ? [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5] : null,
      reference_circle_m: moving && state.refBufferEnabled ? state.refBufferRadius : null,
      reference_date: snap.referenceDates[ds] ?? null,
    };
  });
}

function chartData(state: AppState, snap: ChartSnapshot, includeModel: boolean) {
  const groups = new Map<string, { tag: SeriesTag; parts: Partial<Record<SeriesTag['role'], XY[]>> }>();
  for (const d of snap.datasets) {
    const tag = d._series;
    if (!tag || tag.role === 'sample' || tag.role === 'residual') continue;
    const key = `${tag.kind}|${tag.id}|${tag.layer}`;
    const g = groups.get(key) ?? { tag, parts: {} };
    g.parts[tag.role] = d.data as XY[];
    groups.set(key, g);
  }
  const notes: string[] = [];
  let budget = MAX_TOTAL_VALUES;
  const series: SeriesOut[] = [];
  const perSeries = Math.max(50, Math.min(MAX_SERIES_VALUES, Math.floor(MAX_TOTAL_VALUES / Math.max(1, groups.size * (includeModel ? 2 : 1)))));
  for (const { tag, parts } of groups.values()) {
    const main = parts.data ?? parts.median ?? parts.area_median ?? [];
    const rows = thin(main, Math.min(perSeries, Math.max(1, budget)));
    budget -= rows.length;
    if (rows.length < main.length) notes.push(`${tag.name} [${tag.layer}]: ${main.length} values, every ${Math.ceil(main.length / rows.length)}th returned.`);
    const out: SeriesOut = {
      name: tag.name, kind: tag.kind, id: tag.id, layer: tag.layer, unit: snap.units[tag.layer]?.label ?? '',
      n: main.length, dates: rows.map(p => p.x), values: rows.map(p => p.y),
    };
    if (parts.median) out.note = `In buffer mode: the median of the pixels within ${state.bufferRadius} m of the point.`;
    if (tag.kind === 'area') {
      // The mean and the band on the median's dates (null where they have none).
      const at = (part?: XY[]) => {
        if (!part) return undefined;
        const m = new Map(part.map(p => [p.x, p.y]));
        return rows.map(p => m.get(p.x) ?? null);
      };
      if (parts.area_mean) out.mean = at(parts.area_mean);
      if (parts.band_upper && parts.band_lower) {
        out.band = { kind: AREA_BAND_LABELS[state.areaBand], upper: at(parts.band_upper), lower: at(parts.band_lower) };
      }
      out.note = 'An area: the median of its pixels per date (mean and band as drawn). Masks are not applied to areas.';
    }
    if (parts.model) {
      if (includeModel) {
        const model = thin(parts.model, Math.min(perSeries, Math.max(1, budget)));
        budget -= model.length;
        // null marks where the drawn model line breaks (at a step or a segment break).
        out.model = { dates: model.map(p => p.x), values: model.map(p => p.y), note: 'The model line as drawn (every few days; null at a break).' };
      } else {
        out.model_shown = true;
      }
    }
    series.push(out);
  }
  const s = state;
  return {
    layers: snap.layers.map((ds, i) => ({
      layer: ds, axis: `y${i}`, unit: snap.units[ds]?.label ?? '', ...snap.display[ds],
    })),
    date_range: snap.dateRange,
    reference: referenceOf(s, snap),
    masks: s.layerMasks.map(m => ({ layer: m.dataset, threshold: m.threshold, mode: m.mode })),
    model: snap.showTrends ? { shown: true, terms: modelLabel(snap.fitSettings), residuals_shown: snap.showResiduals } : { shown: false },
    series,
    note: 'Values exactly as the chart draws them: relative to the reference point and date shown, with the masks, date range and units applied. '
      + 'A layer offset (Display options) moves only its y axis, not the values.'
      + (series.some(x => x.model_shown) ? ' Pass include_model=true for the model line.' : ''),
    ...(notes.length ? { thinned: notes } : {}),
  };
}

// ── the fit ──────────────────────────────────────────────────────────────────────────

const UNCERTAINTY = 'Each ± is a formal 1-sigma error from the least-squares covariance scaled by the residual variance '
  + '(sigma² (AᵀA)⁻¹, the chart\'s own fit). It assumes independent noise from date to date, so with correlated noise '
  + '(atmosphere, seasonal effects not in the model) the real uncertainty is larger.';

function fitOf(fit: FitResult | null, points: { x: string; y: number }[], k: number, unit: string, settings: FitSettings) {
  if (!fit) return { fit: null, note: 'Not estimable: too few dates for the chosen terms.' };
  const v = (x: number) => r3(x * k);
  const m = fit.model;
  const out: Record<string, unknown> = {
    model: modelLabel(settings), unit, rate_unit: `${unit}/yr`,
    fitted_from: points[0]?.x.slice(0, 10) ?? null, fitted_to: points[points.length - 1]?.x.slice(0, 10) ?? null,
    n_dates: points.length, n_used: fit.nUsed, n_outliers: fit.nOutliers,
  };
  if (m.polyOrder >= 1 && fit.segments.length === 1) out.rate = { value: v(fit.rate), sigma: v(fit.rateStd) };
  if (m.polyOrder >= 2) {
    out.mean_rate = v(fit.meanRate);
    if (fit.segments.length === 1) out.acceleration = { value: v(2 * fit.coefficients[2]), sigma: v(2 * fit.stdErrors[2]), unit: `${unit}/yr²` };
  }
  if (fit.segments.length > 1) {
    out.segments = fit.segments.map(g => ({
      from: day(g.t0), to: day(g.t1), n: g.n,
      ...(m.polyOrder >= 1 ? { rate: { value: v(g.rate), sigma: v(g.rateStd) }, mean_rate: v(g.meanRate) } : {}),
    }));
  }
  const harmonic = (h: NonNullable<FitResult['annual']>) => ({
    amplitude: { value: v(h.amplitude), sigma: v(h.amplitudeStd) },
    peak_day_of_year: { value: h.peakDoy, sigma: Math.round(h.peakDoyStd * 10) / 10 },
  });
  if (fit.annual) out.annual = harmonic(fit.annual);
  if (fit.semiannual) out.semiannual = harmonic(fit.semiannual);
  if (fit.steps.length || m.steps.length) out.steps = fit.steps.map(s => ({ date: day(s.t), size: { value: v(s.size), sigma: v(s.std) } }));
  if (fit.droppedSteps.length) out.steps_not_estimable = fit.droppedSteps.map(day);
  if (fit.droppedBreaks.length) out.breaks_dropped = fit.droppedBreaks.map(day);
  out.rms_residual = v(fit.rms);
  out.summary = describeFit(fit, k, unit);
  return out;
}

function fitResults(state: AppState, snap: ChartSnapshot) {
  if (!snap.showTrends) {
    return { model: { shown: false }, series: [], note: 'The model is off: fit one with set_fit (or add_step).' };
  }
  const series = Object.entries(snap.fits).map(([key, { fit, points }]) => {
    const [layer, pointId] = key.split('::');
    const name = state.timeSeriesPoints.find(p => p.id === pointId)?.name ?? pointId;
    const shown = snap.units[layer] ?? displayUnit(state.datasetInfo[layer]?.unit, state.units);
    // Lengths in mm (in inches in imperial units), as the chart's model summary; other layers in their own unit.
    const k = shown.rate?.factor ?? 1;
    const unit = shown.rate?.label ?? shown.label;
    return { series: name, point_id: pointId, layer, ...fitOf(fit, points, k, unit, snap.fitSettings) };
  });
  return {
    model: { shown: true, terms: modelLabel(snap.fitSettings), settings: settingsOut(snap.fitSettings) },
    date_range: snap.dateRange,
    series,
    uncertainty: UNCERTAINTY,
    ...(state.chartAreas.length ? { note: 'Areas are not fitted; only points are.' } : {}),
  };
}

const settingsOut = (s: FitSettings) => ({
  polynomial_order: s.polyOrder, annual: s.annual, semiannual: s.semiannual, steps: s.steps, segments: s.breaks,
  reject_outliers: s.rejectOutliers,
});

const sameSettings = (a: FitSettings, b: FitSettings) => JSON.stringify(settingsOut(a)) === JSON.stringify(settingsOut(b));

/** Turn the model on with ``patch`` (as the Model button and the Model card), wait for the refit; the fit results. */
async function applyFit(ctx: PageContext, patch: Partial<FitSettings>, notes: string[] = []) {
  const s = ctx.getState();
  const want = { ...s.fitSettings, ...patch };
  if (!s.showTrends) ctx.dispatch({ type: 'TOGGLE_TRENDS' });
  if (!sameSettings(s.fitSettings, want)) ctx.dispatch({ type: 'SET_FIT_SETTINGS', payload: patch });
  const { snap } = await readyChart(ctx, v => v.showTrends && sameSettings(v.fitSettings, want));
  if (!sameSettings(snap.fitSettings, want)) throw new Error('The chart did not refit in time; call get_fit_results.');
  const out = fitResults(ctx.getState(), snap) as Record<string, unknown>;
  return notes.length ? { ...out, date_notes: notes } : out;
}

async function setFit(ctx: PageContext, input: Record<string, unknown>) {
  const { snap } = await readyChart(ctx);
  const all = seriesDates(snap, ctx.getState());
  const patch: Partial<FitSettings> = {};
  const notes: string[] = [];
  if (input.polynomial_order !== undefined && input.polynomial_order !== null) {
    const o = Number(input.polynomial_order);
    if (![0, 1, 2, 3].includes(o)) throw new Error('polynomial_order is 0 (offset), 1 (linear), 2 (quadratic) or 3 (cubic).');
    patch.polyOrder = o as FitSettings['polyOrder'];
  }
  for (const [arg, key] of [['annual', 'annual'], ['semiannual', 'semiannual'], ['reject_outliers', 'rejectOutliers']] as const) {
    if (input[arg] === undefined || input[arg] === null) continue;
    if (typeof input[arg] !== 'boolean') throw new Error(`${arg} is true or false.`);
    patch[key] = input[arg] as boolean;
  }
  for (const [arg, key] of [['steps', 'steps'], ['segments', 'breaks']] as const) {
    if (input[arg] === undefined || input[arg] === null) continue;
    const checked = checkDates(input[arg], arg, all);
    patch[key] = checked.dates;
    notes.push(...checked.notes);
  }
  return applyFit(ctx, patch, notes);
}

/** The size of the step at ``date`` in each series, from fit results. */
function stepSizes(out: Record<string, unknown>, date: string) {
  return (out.series as Record<string, unknown>[]).map(s => {
    const step = (s.steps as { date: string; size: unknown }[] | undefined)?.find(x => x.date === date);
    const dropped = (s.steps_not_estimable as string[] | undefined)?.includes(date);
    return { series: s.series, layer: s.layer, unit: s.unit, size: step?.size ?? null, ...(dropped ? { note: 'not estimable here (no data on one side, or on a segment break)' } : {}) };
  });
}

async function addStep(ctx: PageContext, input: Record<string, unknown>) {
  const { snap } = await readyChart(ctx);
  const { dates: [date], notes } = checkDates([input.date], 'steps', seriesDates(snap, ctx.getState()));
  const steps = [...new Set([...ctx.getState().fitSettings.steps, date])].sort();
  if (steps.length > MAX_DATES) throw new Error(`The model has ${MAX_DATES} steps already; remove one first.`);
  const out = await applyFit(ctx, { steps }, notes) as Record<string, unknown>;
  return { ok: true, step: date, step_size: stepSizes(out, date), ...out };
}

async function removeStep(ctx: PageContext, input: Record<string, unknown>) {
  const date = String(input.date ?? '');
  const steps = ctx.getState().fitSettings.steps;
  if (!steps.includes(date)) throw new Error(`No step at ${JSON.stringify(date)}. Steps: ${steps.join(', ') || 'none'}.`);
  const out = await applyFit(ctx, { steps: steps.filter(d => d !== date) });
  return { ok: true, removed: date, ...out };
}

// ── series checks ────────────────────────────────────────────────────────────────────

async function checkSeries(ctx: PageContext, input: Record<string, unknown>) {
  const { snap } = await readyChart(ctx);
  const state = ctx.getState();
  const only = input.point !== undefined && input.point !== null ? findPoint(state, input.point) : null;
  const given = input.wavelength_m;
  if (given !== undefined && given !== null && !(isNum(given) && given >= 0.005 && given <= 1)) throw new Error('wavelength_m is 0.005-1 (metres).');
  const wave = isNum(given) ? { m: given, source: 'given' } : cubeWavelength(state.datasetInfo);
  const series: Record<string, unknown>[] = [];
  const skipped: string[] = [];
  for (const d of snap.datasets) {
    const tag = d._series;
    if (!tag || !['data', 'median', 'area_median'].includes(tag.role)) continue;
    if (only ? tag.kind !== 'point' || tag.id !== only.id : false) continue;
    const info = state.datasetInfo[tag.layer];
    const toMm = displayUnit(info?.unit, 'metric').rate?.factor;
    const shown = snap.units[tag.layer];
    if (!toMm || !shown) {
      skipped.push(`${tag.name} [${tag.layer}]: not a length (${info?.unit || 'no unit'})`);
      continue;
    }
    // The drawn values back to metres (they are drawn in the chosen units).
    const points = (d.data as { x: string; y: number }[])
      .filter(p => isNum(p.y) && ISO.test(String(p.x).slice(0, 10)))
      .map(p => ({ t: isoMs(String(p.x)), value: ((p.y / shown.factor) * toMm) / 1000 }));
    if (points.length < 3) {
      skipped.push(`${tag.name} [${tag.layer}]: fewer than 3 dates`);
      continue;
    }
    const from = snap.dateRange.start ?? '', to = snap.dateRange.end ?? '9999';
    const layerDates = (info?.x_values ?? []).map(x => String(x).slice(0, 10)).filter(x => x >= from && x <= to);
    const checks = seriesChecks(points, tag.kind === 'point' ? Math.max(0, layerDates.length - points.length) : 0);
    const flags = seriesFlags(points, checks, wave.m);
    const { jumps: _jumps, ...rest } = checks;
    series.push({ series: tag.name, kind: tag.kind, layer: tag.layer, n_dates: points.length, ...rest, ...flags });
  }
  if (only && !series.length) throw new Error(`${only.name} has no series in the chart${skipped.length ? `: ${skipped.join('; ')}` : ''}.`);
  const half = wave.m ? r3((wave.m * 1000) / 2) : null;
  return {
    wavelength: { m: wave.m, half_mm: half, source: wave.source },
    series,
    ...(skipped.length ? { skipped } : {}),
    thresholds: 'steps: a lasting change of at least 10 mm and 6 scatters between the medians of 5 dates on each side; '
      + 'outliers: a single date at least 10 mm and 5 scatters from the 3 dates on each side; '
      + `unwrapping: a step or outlier within 20% of 1-3 half wavelengths${half ? ` (${half} mm)` : ''}.`,
    note: 'These are flags to look at, not findings. To model a flagged step, suggest add_step at its step_date and ask the '
      + 'user before adding it. A step of about half a wavelength (or a multiple), especially on one date only or on one '
      + 'pass only, is more likely an unwrapping error than ground motion; say so. trend_vs_noise below about 2 means no clear trend.',
  };
}

// ── run ──────────────────────────────────────────────────────────────────────────────

const pointOut = (p: TimeSeriesPoint, s: AppState) => ({
  id: p.id, name: p.name, lon: Math.round(p.position[1] * 1e6) / 1e6, lat: Math.round(p.position[0] * 1e6) / 1e6,
  color: p.color, marker: p.marker ?? 'circle', line: p.line ?? 'solid', visible: p.visible,
  ...(s.selectedPointId === p.id ? { selected: true } : {}),
});

const areaOut = (a: ChartArea) => ({ id: a.id, name: a.name, color: a.color, visible: a.visible, ...areaStyle(a) });

function needName(v: unknown): string {
  const name = String(v ?? '').trim();
  if (!name || name.length > 60) throw new Error('Give a name of 1-60 characters.');
  return name;
}

/** Run chart tool ``name``; returns what the model is told. Throws with a message for the model. */
export async function runChartTool(name: string, input: Record<string, unknown>, ctx: PageContext): Promise<unknown> {
  // What an earlier tool dispatched shows after the next render: let it render first.
  await sleep(30);
  const state = ctx.getState();
  switch (name) {
    case 'get_chart_data': {
      const { snap } = await readyChart(ctx);
      return chartData(ctx.getState(), snap, input.include_model === true);
    }
    case 'get_fit_results': {
      const { snap } = await readyChart(ctx);
      return fitResults(ctx.getState(), snap);
    }
    case 'set_fit':
      return setFit(ctx, input);
    case 'add_step':
      return addStep(ctx, input);
    case 'remove_step':
      return removeStep(ctx, input);
    case 'set_residuals': {
      if (typeof input.on !== 'boolean') throw new Error('Give on: true or false.');
      // The residuals button shows with the model: turning residuals on turns the model on.
      if (input.on && !state.showTrends) ctx.dispatch({ type: 'TOGGLE_TRENDS' });
      if (state.showResiduals !== input.on) ctx.dispatch({ type: 'TOGGLE_RESIDUALS' });
      return { ok: true, residuals: input.on, model: input.on || state.showTrends };
    }
    case 'list_points':
      return { points: state.timeSeriesPoints.map(p => pointOut(p, state)), marker_size: state.markerSize };
    case 'rename_point': {
      const p = findPoint(state, input.point);
      const label = needName(input.name);
      // As the name field of the Points panel.
      ctx.dispatch({ type: 'UPDATE_TIME_SERIES_POINT', payload: { id: p.id, updates: { name: label } } });
      return { ok: true, id: p.id, old_name: p.name, name: label };
    }
    case 'remove_point': {
      const p = findPoint(state, input.point);
      ctx.dispatch({ type: 'REMOVE_TIME_SERIES_POINT', payload: p.id });
      return { ok: true, removed: p.name, id: p.id };
    }
    case 'set_point_style': {
      const p = findPoint(state, input.point);
      const updates: Partial<TimeSeriesPoint> = {};
      if (input.color !== undefined && input.color !== null) updates.color = hexColor(input.color);
      if (input.marker !== undefined && input.marker !== null) updates.marker = oneOf<MarkerShape>(input.marker, MARKERS, 'marker');
      if (input.line !== undefined && input.line !== null) updates.line = oneOf<LineStyle>(input.line, LINES, 'line');
      let size: number | undefined;
      if (input.size !== undefined && input.size !== null) {
        size = Number(input.size);
        if (!(Number.isInteger(size) && size >= 1 && size <= 12)) throw new Error('size is 1-12 px.');
      }
      if (!Object.keys(updates).length && size === undefined) throw new Error('Give color, marker, line or size.');
      // As the Style button's row for the point: each control dispatches its own update.
      for (const [k, v] of Object.entries(updates)) ctx.dispatch({ type: 'UPDATE_TIME_SERIES_POINT', payload: { id: p.id, updates: { [k]: v } } });
      if (size !== undefined) ctx.dispatch({ type: 'SET_MARKER_SIZE', payload: size });
      return {
        ok: true, point: pointOut({ ...p, ...updates }, state), ...(size !== undefined ? { marker_size: size } : {}),
        note: 'The colour is also the point\'s colour on the map.' + (size !== undefined ? ' The marker size applies to every point (Style › Marker size).' : ''),
      };
    }
    case 'list_areas':
      return { areas: state.chartAreas.map(areaOut), band: state.areaBand, band_label: AREA_BAND_LABELS[state.areaBand] };
    case 'rename_area': {
      const a = findArea(state, input.area);
      const label = needName(input.name);
      ctx.dispatch({ type: 'UPDATE_CHART_AREA', payload: { id: a.id, updates: { name: label } } });
      return { ok: true, id: a.id, old_name: a.name, name: label };
    }
    case 'set_area_style': {
      const a = findArea(state, input.area);
      const updates: Partial<ChartArea> = {};
      if (input.color !== undefined && input.color !== null) updates.color = hexColor(input.color);
      if (input.median_line !== undefined && input.median_line !== null) updates.line = oneOf<LineStyle>(input.median_line, LINES, 'median_line');
      if (input.width !== undefined && input.width !== null) {
        if (!(AREA_WIDTHS as readonly number[]).includes(Number(input.width))) throw new Error(`width is one of ${AREA_WIDTHS.join(', ')} px.`);
        updates.lineWidth = Number(input.width);
      }
      for (const [arg, key] of [['show_mean', 'showMean'], ['show_band', 'showBand']] as const) {
        if (input[arg] === undefined || input[arg] === null) continue;
        if (typeof input[arg] !== 'boolean') throw new Error(`${arg} is true or false.`);
        updates[key] = input[arg] as boolean;
      }
      if (input.band_opacity !== undefined && input.band_opacity !== null) {
        const o = Number(input.band_opacity);
        if (!(o >= 0 && o <= 0.8)) throw new Error('band_opacity is 0-0.8.');
        updates.bandOpacity = o;
      }
      if (!Object.keys(updates).length) throw new Error('Give color, median_line, width, show_mean, show_band or band_opacity.');
      // As the Style button's rows for the area.
      for (const [k, v] of Object.entries(updates)) ctx.dispatch({ type: 'UPDATE_CHART_AREA', payload: { id: a.id, updates: { [k]: v } } });
      return { ok: true, area: areaOut({ ...a, ...updates }), note: "The colour is also the area's colour on the map." };
    }
    case 'set_area_band': {
      const b = String(input.band ?? '');
      const band: AreaBand | null = b === 'std' ? 'std' : b === 'p10p90' || b === 'pct' ? 'pct' : null;
      if (!band) throw new Error('band is std (mean ± 1 std) or p10p90.');
      ctx.dispatch({ type: 'SET_AREA_BAND', payload: band });
      return { ok: true, band: b === 'pct' ? 'p10p90' : b, label: AREA_BAND_LABELS[band] };
    }
    case 'set_chart_layers': {
      if (!Array.isArray(input.layers)) throw new Error('Give layers as a list of layer names ([] follows the map layer).');
      const known = timeSeriesLayers(state.datasetInfo);
      const layers = (input.layers as unknown[]).map(l => {
        const n = String(l);
        if (known.includes(n)) return n;
        const close = closeMatches(n, known);
        throw new Error(`No layer with dates ${JSON.stringify(n)}${close.length ? ` (did you mean ${close.join(', ')}?)` : ''}. Layers with dates: ${known.join(', ')}.`);
      });
      if (layers.length > 6) throw new Error('At most 6 layers in one chart.');
      openChart(ctx);
      const win = await waitFor(() => ctx.getState().chartWindows[0], w => !!w, 2000);
      if (!win) throw new Error('The chart did not open.');
      // As the chart's layer chips (＋ layer…, ✕ and ↺ reset): an empty list follows the map's layer.
      ctx.dispatch({ type: 'SET_CHART_WINDOW_DS', payload: { id: win.id, dsNames: [...new Set(layers)] } });
      return { ok: true, layers: layers.length ? [...new Set(layers)] : 'the map layer', note: 'Each layer has its own y axis (y0 on the left, the others on the right).' };
    }
    case 'set_layer_display': {
      const { chart, snap } = await readyChart(ctx);
      const layer = String(input.layer ?? '');
      if (!snap.layers.includes(layer)) throw new Error(`${JSON.stringify(layer)} is not in the chart. Chart layers: ${snap.layers.join(', ')}.`);
      const patch: Record<string, number | string | null> = {};
      if (input.reset === true) Object.assign(patch, { offset: 0, ymin: null, ymax: null, color: null });
      for (const k of ['offset', 'ymin', 'ymax'] as const) {
        if (input[k] === undefined || input[k] === null) continue;
        if (!isNum(input[k])) throw new Error(`${k} is a number in the axis unit (${snap.units[layer]?.label || 'the layer unit'}).`);
        patch[k] = input[k] as number;
      }
      if (input.color !== undefined && input.color !== null) patch.color = hexColor(input.color);
      if (!Object.keys(patch).length) throw new Error('Give offset, ymin, ymax, color or reset.');
      const cur = snap.display[layer];
      const lo = 'ymin' in patch ? patch.ymin : cur?.ymin, hi = 'ymax' in patch ? patch.ymax : cur?.ymax;
      if (isNum(lo) && isNum(hi) && !(lo < hi)) throw new Error(`ymin (${lo}) must be below ymax (${hi}).`);
      chart.setLayerDisplay(layer, patch);
      const after = await waitFor(() => getChart()?.snapshot()?.display[layer], d => !!d && Object.entries(patch).every(([k, v]) => d[k as keyof typeof d] === v), 2000);
      return { ok: true, layer, unit: snap.units[layer]?.label ?? '', display: after ?? patch };
    }
    case 'set_date_range': {
      if (input.reset === true) {
        ctx.dispatch({ type: 'SET_DATE_RANGE_START', payload: null });
        ctx.dispatch({ type: 'SET_DATE_RANGE_END', payload: null });
        return { ok: true, start: null, end: null, note: 'All dates are shown.' };
      }
      const start = input.start ?? null, end = input.end ?? null;
      if (start === null && end === null) throw new Error('Give start, end (YYYY-MM-DD) or reset=true.');
      for (const d of [start, end]) {
        if (d !== null && (!ISO.test(String(d)) || day(isoMs(String(d))) !== d)) throw new Error(`${JSON.stringify(d)} is not a date (YYYY-MM-DD).`);
      }
      const from = (start ?? state.dateRangeStart) as string | null, to = (end ?? state.dateRangeEnd) as string | null;
      if (from && to && from > to) throw new Error(`start (${from}) must be before end (${to}).`);
      // As the From and To fields of Display options.
      if (start !== null) ctx.dispatch({ type: 'SET_DATE_RANGE_START', payload: start as string });
      if (end !== null) ctx.dispatch({ type: 'SET_DATE_RANGE_END', payload: end as string });
      return { ok: true, start: from, end: to, note: 'The chart and its model fit use only these dates.' };
    }
    case 'export_chart': {
      const format = oneOf(input.format, ['csv', 'png'] as const, 'format');
      const { chart } = await readyChart(ctx);
      const ok = format === 'csv' ? chart.exportCsv() : chart.exportPng();
      if (!ok) throw new Error(`The chart has nothing to export as ${format.toUpperCase()}.`);
      return { ok: true, format, note: `The ${format.toUpperCase()} is saved by the user's browser (as the chart's ${format === 'csv' ? 'Export CSV' : 'Save as PNG'} button does).` };
    }
    case 'check_series':
      return checkSeries(ctx, input);
    default:
      throw new Error(`No chart tool ${name}.`);
  }
}
