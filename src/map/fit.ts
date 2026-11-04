/**
 * Least-squares time-series model for displacement:
 *
 *   d(t) = sum_k c_k x^k                      polynomial, order 0..3, x = years from the mid-epoch
 *                                             (with breaks: one polynomial per segment, x from the
 *                                             segment's mid-epoch; segments may jump at a break)
 *        + a1 sin(2πy) + b1 cos(2πy)          annual (y = decimal year, so phase is calendar time)
 *        + a2 sin(4πy) + b2 cos(4πy)          semi-annual
 *        + sum_j s_j H(t - T_j)               steps (offsets) at user dates T_j
 *
 * Solved with column-scaled normal equations (p <= ~12, so this is well conditioned),
 * optional iterative 3-sigma (MAD) outlier rejection, and formal 1-sigma errors from
 * sigma^2 (AᵀA)⁻¹. Times are epoch ms (UTC), values metres.
 */

export interface FitModel {
  /** Polynomial order: 0 offset, 1 linear, 2 quadratic, 3 cubic. */
  polyOrder: 0 | 1 | 2 | 3;
  annual: boolean;
  semiannual: boolean;
  /** Step dates, epoch ms. */
  steps: number[];
  /** Segment breaks, epoch ms: the polynomial is fitted separately on each side. */
  breaks?: number[];
  /** Iteratively drop points with |residual| > 3 x robust sigma (max 5 passes). */
  rejectOutliers: boolean;
}

export const DEFAULT_MODEL: FitModel = { polyOrder: 1, annual: false, semiannual: false, steps: [], breaks: [], rejectOutliers: false };

/** One polynomial segment of a fit (the whole record when there are no breaks). */
export interface Segment {
  t0: number;
  t1: number;
  /** Polynomial derivative at the segment's mid-epoch, m/yr. */
  rate: number;
  rateStd: number;
  /** Mean rate of the polynomial over the segment, m/yr. */
  meanRate: number;
  n: number;
}

export interface FitResult {
  model: FitModel;
  names: string[];
  coefficients: number[];
  stdErrors: number[];
  /** Evaluate the fitted model at time t (epoch ms). */
  predict: (t: number) => number;
  /** Polynomial-part derivative at the mid-epoch, m/yr (the velocity for order 1). */
  rate: number;
  rateStd: number;
  /** Mean rate of the polynomial part over the data span, m/yr. */
  meanRate: number;
  annual?: Harmonic;
  semiannual?: Harmonic;
  steps: { t: number; size: number; std: number }[];
  /** Steps that could not be estimated (no data on one side, or on a break). */
  droppedSteps: number[];
  /** Polynomial segments, first to last (one without breaks). */
  segments: Segment[];
  /** Breaks dropped because a segment would have too few epochs. */
  droppedBreaks: number[];
  rms: number;
  nUsed: number;
  nOutliers: number;
  /** Per input point: true if used in the final fit. */
  used: boolean[];
  tMid: number;
}

export interface Harmonic {
  amplitude: number;
  amplitudeStd: number;
  /** Day of year of the (first) maximum. */
  peakDoy: number;
}

const YEAR_MS = 365.25 * 86_400_000;
const TWO_PI = 2 * Math.PI;

/** Decimal year of an epoch-ms time (UTC). */
export function decimalYear(t: number): number {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  const end = Date.UTC(y + 1, 0, 1);
  return y + (t - start) / (end - start);
}

interface SegmentSpan {
  t0: number;
  t1: number;
  mid: number;
}

const POLY_NAMES = ["offset", "rate", "acceleration/2", "jerk/6"];

/** Index of the segment holding time t (segments are contiguous, the last one open-ended). */
function segmentOf(t: number, spans: SegmentSpan[]): number {
  for (let s = spans.length - 1; s > 0; s--) if (t >= spans[s].t0) return s;
  return 0;
}

function columns(model: FitModel, steps: number[], spans: SegmentSpan[]): { names: string[]; row: (t: number) => number[] } {
  const names: string[] = [];
  const multi = spans.length > 1;
  for (let s = 0; s < spans.length; s++) {
    for (let k = 0; k <= model.polyOrder; k++) names.push(multi ? `segment ${s + 1} ${POLY_NAMES[k]}` : POLY_NAMES[k]);
  }
  if (model.annual) names.push("annual sin", "annual cos");
  if (model.semiannual) names.push("semiannual sin", "semiannual cos");
  for (const s of steps) names.push(`step ${new Date(s).toISOString().slice(0, 10)}`);
  const row = (t: number) => {
    const r: number[] = [];
    const seg = segmentOf(t, spans);
    for (let s = 0; s < spans.length; s++) {
      const x = (t - spans[s].mid) / YEAR_MS;
      for (let k = 0; k <= model.polyOrder; k++) r.push(s === seg ? x ** k : 0);
    }
    if (model.annual || model.semiannual) {
      const y = decimalYear(t);
      if (model.annual) r.push(Math.sin(TWO_PI * y), Math.cos(TWO_PI * y));
      if (model.semiannual) r.push(Math.sin(2 * TWO_PI * y), Math.cos(2 * TWO_PI * y));
    }
    for (const s of steps) r.push(t >= s ? 1 : 0);
    return r;
  };
  return { names, row };
}

/** Solve min |A c - y| via column-scaled normal equations; returns c and (AᵀA)⁻¹. */
function solve(A: number[][], y: number[]): { c: number[]; inv: number[][] } | null {
  const n = A.length;
  const p = A[0]?.length ?? 0;
  if (n < p || p === 0) return null;
  const scale = new Array(p).fill(0);
  for (const r of A) for (let j = 0; j < p; j++) scale[j] += r[j] * r[j];
  for (let j = 0; j < p; j++) {
    if (scale[j] === 0) return null;
    scale[j] = 1 / Math.sqrt(scale[j]);
  }
  const N = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const r = A[i];
    for (let j = 0; j < p; j++) {
      const aj = r[j] * scale[j];
      b[j] += aj * y[i];
      for (let k = j; k < p; k++) N[j][k] += aj * r[k] * scale[k];
    }
  }
  for (let j = 0; j < p; j++) for (let k = 0; k < j; k++) N[j][k] = N[k][j];
  // Cholesky N = L Lᵀ
  const L = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let j = 0; j < p; j++) {
    let d = N[j][j];
    for (let k = 0; k < j; k++) d -= L[j][k] ** 2;
    if (d <= 1e-12) return null; // collinear columns
    L[j][j] = Math.sqrt(d);
    for (let i = j + 1; i < p; i++) {
      let v = N[i][j];
      for (let k = 0; k < j; k++) v -= L[i][k] * L[j][k];
      L[i][j] = v / L[j][j];
    }
  }
  // Inverse of N via L⁻¹
  const Li = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < p; i++) {
    Li[i][i] = 1 / L[i][i];
    for (let j = 0; j < i; j++) {
      let v = 0;
      for (let k = j; k < i; k++) v -= L[i][k] * Li[k][j];
      Li[i][j] = v / L[i][i];
    }
  }
  const Ninv = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) => {
      let v = 0;
      for (let k = Math.max(i, j); k < p; k++) v += Li[k][i] * Li[k][j];
      return v;
    }),
  );
  const cs = Ninv.map((row) => row.reduce((acc, v, k) => acc + v * b[k], 0));
  return {
    c: cs.map((v, j) => v * scale[j]),
    inv: Ninv.map((row, i) => row.map((v, j) => v * scale[i] * scale[j])),
  };
}

function harmonic(s: number, c: number, varS: number, varC: number, cov: number, period: number): Harmonic {
  const amplitude = Math.hypot(s, c);
  const amplitudeStd = amplitude > 0 ? Math.sqrt(Math.max(0, (s * s * varS + c * c * varC + 2 * s * c * cov) / (amplitude * amplitude))) : 0;
  // s sin(ωy) + c cos(ωy) = A cos(ωy - φ), φ = atan2(s, c); maximum at y = φ / ω (mod period).
  let frac = Math.atan2(s, c) / TWO_PI; // in cycles
  frac = ((frac % 1) + 1) % 1;
  return { amplitude, amplitudeStd, peakDoy: Math.round(frac * period * 365.25) + 1 };
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function fitModel(points: { t: number; value: number }[], model: FitModel): FitResult | null {
  if (points.length < 2) return null;
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const tMid = (t0 + t1) / 2;
  // Breaks: keep those leaving enough epochs on each side for the segment polynomial.
  const minPerSegment = Math.max(2, model.polyOrder + 1);
  const breaks: number[] = [];
  const droppedBreaks: number[] = [];
  for (const b of [...new Set(model.breaks ?? [])].sort((a, c) => a - c)) {
    const start = breaks.length ? breaks[breaks.length - 1] : -Infinity;
    const before = points.filter((p) => p.t >= start && p.t < b).length;
    const after = points.filter((p) => p.t >= b).length;
    if (before >= minPerSegment && after >= minPerSegment) breaks.push(b);
    else droppedBreaks.push(b);
  }
  const bounds = [t0, ...breaks];
  const spans: SegmentSpan[] = bounds.map((b, s) => {
    const end = s + 1 < bounds.length ? bounds[s + 1] : Infinity;
    const inside = points.filter((p) => p.t >= (s === 0 ? -Infinity : b) && p.t < end);
    const a = inside[0]?.t ?? b;
    const z = inside[inside.length - 1]?.t ?? b;
    return { t0: s === 0 ? t0 : b, t1: Math.min(end, t1), mid: (a + z) / 2 };
  });
  if (spans.length === 1) spans[0].mid = tMid;
  const sorted = [...new Set(model.steps)].sort((a, b) => a - b);
  // A step needs data on both sides, otherwise it is collinear with the offset; a step on a
  // break is collinear with the next segment's offset.
  const DAY = 86_400_000;
  const steps = sorted.filter(
    (s) => points.some((p) => p.t < s) && points.some((p) => p.t >= s) && !breaks.some((b) => Math.abs(b - s) < DAY),
  );
  const droppedSteps = sorted.filter((s) => !steps.includes(s));
  const { names, row } = columns(model, steps, spans);
  const allRows = points.map((p) => row(p.t));
  let used = points.map(() => true);
  let result: { c: number[]; inv: number[][] } | null = null;
  let rms = 0;
  for (let pass = 0; pass < (model.rejectOutliers ? 6 : 1); pass++) {
    const idx = used.flatMap((u, i) => (u ? [i] : []));
    result = solve(idx.map((i) => allRows[i]), idx.map((i) => points[i].value));
    if (!result) return null;
    const c = result.c;
    const resid = points.map((p, i) => p.value - allRows[i].reduce((acc, v, j) => acc + v * c[j], 0));
    const usedResid = idx.map((i) => resid[i]);
    rms = Math.sqrt(usedResid.reduce((a, r) => a + r * r, 0) / usedResid.length);
    if (!model.rejectOutliers) break;
    const med = median(usedResid);
    const sigma = 1.4826 * median(usedResid.map((r) => Math.abs(r - med)));
    if (!(sigma > 0)) break;
    const next = resid.map((r) => Math.abs(r - med) <= 3 * sigma);
    if (next.every((v, i) => v === used[i])) break;
    if (next.filter(Boolean).length < names.length + 2) break;
    used = next;
  }
  if (!result) return null;
  const nUsed = used.filter(Boolean).length;
  const dof = Math.max(1, nUsed - names.length);
  const usedIdx = used.flatMap((u, i) => (u ? [i] : []));
  const rss = usedIdx.reduce((a, i) => {
    const r = points[i].value - allRows[i].reduce((acc, v, j) => acc + v * result!.c[j], 0);
    return a + r * r;
  }, 0);
  const sigma2 = rss / dof;
  const c = result.c;
  const se = result.inv.map((r, j) => Math.sqrt(Math.max(0, sigma2 * r[j])));
  const cov = (i: number, j: number) => sigma2 * result!.inv[i][j];

  const perSeg = model.polyOrder + 1;
  let col = perSeg * spans.length;
  let annual: Harmonic | undefined;
  let semiannual: Harmonic | undefined;
  if (model.annual) {
    annual = harmonic(c[col], c[col + 1], cov(col, col), cov(col + 1, col + 1), cov(col, col + 1), 1);
    col += 2;
  }
  if (model.semiannual) {
    semiannual = harmonic(c[col], c[col + 1], cov(col, col), cov(col + 1, col + 1), cov(col, col + 1), 0.5);
    col += 2;
  }
  const stepResults = steps.map((t, j) => ({ t, size: c[col + j], std: se[col + j] }));

  /** Polynomial part of segment s at time t. */
  const poly = (t: number, s = segmentOf(t, spans)) => {
    const x = (t - spans[s].mid) / YEAR_MS;
    let v = 0;
    for (let k = 0; k <= model.polyOrder; k++) v += c[s * perSeg + k] * x ** k;
    return v;
  };
  const spanYears = (t1 - t0) / YEAR_MS;
  const segments: Segment[] = spans.map((sp, s) => {
    const end = Math.min(sp.t1, t1);
    const years = (end - sp.t0) / YEAR_MS;
    return {
      t0: sp.t0,
      t1: end,
      rate: model.polyOrder >= 1 ? c[s * perSeg + 1] : 0,
      rateStd: model.polyOrder >= 1 ? se[s * perSeg + 1] : 0,
      meanRate: years > 0 ? (poly(end, s) - poly(sp.t0, s)) / years : 0,
      n: points.filter((p) => segmentOf(p.t, spans) === s).length,
    };
  });
  return {
    model,
    names,
    coefficients: c,
    stdErrors: se,
    predict: (t: number) => row(t).reduce((acc, v, j) => acc + v * c[j], 0),
    rate: segments[0].rate,
    rateStd: segments[0].rateStd,
    meanRate: spans.length > 1 ? segments.reduce((a, g) => a + g.meanRate * (g.t1 - g.t0), 0) / Math.max(1, t1 - t0) : spanYears > 0 ? (poly(t1) - poly(t0)) / spanYears : 0,
    annual,
    semiannual,
    steps: stepResults,
    droppedSteps,
    segments,
    droppedBreaks,
    rms,
    nUsed,
    nOutliers: points.length - nUsed,
    used,
    tMid,
  };
}
