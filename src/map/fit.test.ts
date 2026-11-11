import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, decimalYear, fitModel } from "./fit";

const DAY = 86_400_000;
const T0 = Date.UTC(2017, 0, 1);

/** Deterministic pseudo-noise (no Math.random so tests are stable). */
const noise = (i: number, amp: number) => amp * Math.sin(i * 12.9898) * Math.cos(i * 78.233);

function series(f: (t: number) => number, n = 300, stepDays = 12, amp = 0.0005) {
  return Array.from({ length: n }, (_, i) => {
    const t = T0 + i * stepDays * DAY;
    return { t, value: f(t) + noise(i, amp) };
  });
}

const yearsFromMid = (t: number, pts: { t: number }[]) => (t - (pts[0].t + pts[pts.length - 1].t) / 2) / (365.25 * DAY);

describe("fitModel", () => {
  it("recovers a linear rate", () => {
    const pts = series((t) => 0.004 + -0.012 * ((t - T0) / (365.25 * DAY)));
    const fit = fitModel(pts, DEFAULT_MODEL)!;
    expect(fit.rate).toBeCloseTo(-0.012, 4);
    expect(fit.meanRate).toBeCloseTo(-0.012, 4);
    expect(fit.rateStd).toBeGreaterThan(0);
    expect(fit.rateStd).toBeLessThan(0.0002);
    expect(fit.names).toEqual(["offset", "rate"]);
  });

  it("recovers rate, annual and semi-annual terms and a step", () => {
    const stepT = Date.UTC(2020, 5, 15);
    const truth = (t: number) => {
      const y = decimalYear(t);
      return (
        0.01 * ((t - T0) / (365.25 * DAY)) +
        0.006 * Math.cos(2 * Math.PI * (y - 200 / 365.25)) + // annual peak near DOY 201
        0.002 * Math.sin(4 * Math.PI * y) +
        (t >= stepT ? -0.015 : 0)
      );
    };
    const pts = series(truth);
    const fit = fitModel(pts, { polyOrder: 1, annual: true, semiannual: true, steps: [stepT], rejectOutliers: false })!;
    expect(fit.rate).toBeCloseTo(0.01, 3);
    expect(fit.annual!.amplitude).toBeCloseTo(0.006, 3);
    expect(Math.abs(fit.annual!.peakDoy - 201)).toBeLessThanOrEqual(3);
    expect(fit.semiannual!.amplitude).toBeCloseTo(0.002, 3);
    expect(fit.steps[0].size).toBeCloseTo(-0.015, 3);
    expect(fit.steps[0].std).toBeGreaterThan(0);
    expect(fit.rms).toBeLessThan(0.0006);
    expect(fit.predict(stepT + DAY) - fit.predict(stepT - DAY)).toBeLessThan(-0.012);
  });

  it("estimates acceleration with order 2 (rate at mid-epoch)", () => {
    const pts = series((t) => 0.003 * ((t - T0) / (365.25 * DAY)) ** 2, 300, 12, 0.0002);
    const fit = fitModel(pts, { ...DEFAULT_MODEL, polyOrder: 2 })!;
    const mid = (pts[0].t + pts[pts.length - 1].t) / 2;
    expect(fit.coefficients[2]).toBeCloseTo(0.003, 4);
    expect(fit.rate).toBeCloseTo(2 * 0.003 * ((mid - T0) / (365.25 * DAY)), 4);
    expect(yearsFromMid(mid, pts)).toBe(0);
  });

  it("rejects outliers when asked", () => {
    const pts = series((t) => 0.01 * ((t - T0) / (365.25 * DAY)));
    pts[50].value += 0.08;
    pts[120].value -= 0.06;
    const plain = fitModel(pts, DEFAULT_MODEL)!;
    const robust = fitModel(pts, { ...DEFAULT_MODEL, rejectOutliers: true })!;
    expect(robust.nOutliers).toBeGreaterThanOrEqual(2);
    expect(robust.used[50]).toBe(false);
    expect(Math.abs(robust.rate - 0.01)).toBeLessThan(Math.abs(plain.rate - 0.01) + 1e-9);
    expect(robust.rms).toBeLessThan(plain.rms);
  });

  it("drops steps without data on both sides and handles tiny inputs", () => {
    const pts = series(() => 0, 50);
    const fit = fitModel(pts, { ...DEFAULT_MODEL, steps: [Date.UTC(2010, 0, 1), Date.UTC(2030, 0, 1)] })!;
    expect(fit.steps).toHaveLength(0);
    expect(fit.droppedSteps).toHaveLength(2);
    expect(fitModel(pts.slice(0, 1), DEFAULT_MODEL)).toBeNull();
    expect(fitModel(pts.slice(0, 3), { ...DEFAULT_MODEL, polyOrder: 3, annual: true })).toBeNull();
  });

  it("gives the annual peak's day a formal error that matches its scatter over noise draws", () => {
    // 60 noisy draws of one annual cycle peaking near DOY 120: the spread of the fitted peak day
    // is what peakDoyStd says (the formal error assumes the noise the residuals show).
    let seed = 7;
    const gauss = () => {
      const u = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      return Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
    };
    const peaks: number[] = [];
    const stds: number[] = [];
    for (let k = 0; k < 60; k++) {
      const pts = Array.from({ length: 90 }, (_, i) => {
        const t = T0 + i * 24 * DAY;
        return { t, value: 0.004 * Math.cos(2 * Math.PI * (decimalYear(t) - 119 / 365.25)) + 0.002 * gauss() };
      });
      const a = fitModel(pts, { ...DEFAULT_MODEL, polyOrder: 0, annual: true })!.annual!;
      peaks.push(a.peakDoy);
      stds.push(a.peakDoyStd);
    }
    const mean = peaks.reduce((x, y) => x + y, 0) / peaks.length;
    const spread = Math.sqrt(peaks.reduce((x, y) => x + (y - mean) ** 2, 0) / (peaks.length - 1));
    const formal = stds.reduce((x, y) => x + y, 0) / stds.length;
    expect(mean).toBeGreaterThan(110);
    expect(mean).toBeLessThan(130);
    expect(formal).toBeGreaterThan(0.6 * spread);
    expect(formal).toBeLessThan(1.6 * spread);
  });

  it("decimalYear is calendar based", () => {
    expect(decimalYear(Date.UTC(2020, 0, 1))).toBe(2020);
    expect(decimalYear(Date.UTC(2021, 6, 2, 12))).toBeCloseTo(2021.5, 3);
  });
});

describe("segmented polynomial (breaks)", () => {
  const DAY = 86_400_000;
  const t0 = Date.UTC(2017, 0, 1);
  const tb = Date.UTC(2020, 0, 1);
  const YEAR = 365.25 * DAY;
  // +10 mm/yr until 2020, then -20 mm/yr with a 5 mm jump; 12-day sampling to 2024.
  const points = Array.from({ length: 220 }, (_, i) => {
    const t = t0 + i * 12 * DAY;
    const v = t < tb ? 0.01 * ((t - t0) / YEAR) : 0.01 * ((tb - t0) / YEAR) + 0.005 - 0.02 * ((t - tb) / YEAR);
    return { t, value: v };
  });

  it("recovers a rate per segment", () => {
    const f = fitModel(points, { ...DEFAULT_MODEL, breaks: [tb] })!;
    expect(f.segments).toHaveLength(2);
    expect(f.segments[0].rate).toBeCloseTo(0.01, 6);
    expect(f.segments[1].rate).toBeCloseTo(-0.02, 6);
    expect(f.segments[0].n + f.segments[1].n).toBe(points.length);
    expect(f.names[0]).toBe("segment 1 offset");
    expect(f.rms).toBeLessThan(1e-9);
    // Without the break a single line misfits.
    expect(fitModel(points, DEFAULT_MODEL)!.rms).toBeGreaterThan(0.005);
  });

  it("keeps the single-segment model unchanged and drops unusable breaks and steps on breaks", () => {
    const single = fitModel(points, DEFAULT_MODEL)!;
    expect(single.segments).toHaveLength(1);
    expect(single.names).toEqual(["offset", "rate"]);
    const f = fitModel(points, { ...DEFAULT_MODEL, breaks: [t0 + 5 * DAY, tb], steps: [tb] })!;
    expect(f.droppedBreaks).toEqual([t0 + 5 * DAY]);
    expect(f.droppedSteps).toEqual([tb]);
    expect(f.segments).toHaveLength(2);
  });
});
