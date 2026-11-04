import { describe, expect, it } from 'vitest';
import { DEFAULT_FIT, describeFit, fitSeries, modelCurve, modelLabel, rSquared } from './fitSettings';

const days = (n: number, every = 12) =>
  Array.from({ length: n }, (_, i) => new Date(Date.UTC(2020, 0, 1) + i * every * 86_400_000).toISOString().slice(0, 10));

// 10 mm/yr in metres, with a 20 mm drop on 2021-01-01.
const STEP = '2021-01-01';
const data = days(150).map(x => ({ x, y: 0.01 * ((Date.parse(x) - Date.UTC(2020, 0, 1)) / (365.25 * 86_400_000)) - (x >= STEP ? 0.02 : 0) }));

describe('model settings', () => {
  it('labels the chosen terms as the portal does', () => {
    expect(modelLabel(DEFAULT_FIT)).toBe('linear');
    expect(modelLabel({ ...DEFAULT_FIT, polyOrder: 2, annual: true, steps: [STEP], breaks: ['2022-01-01'], rejectOutliers: true }))
      .toBe('quadratic + annual + 2 segments + 1 step(s) + 3σ outliers');
  });

  it('recovers the rate and the step, in mm', () => {
    const fit = fitSeries(data, { ...DEFAULT_FIT, steps: [STEP] })!;
    expect(fit.rate * 1000).toBeCloseTo(10, 3);
    expect(fit.steps[0].size * 1000).toBeCloseTo(-20, 3);
    expect(rSquared(data, fit)).toBeCloseTo(1, 6);
    expect(describeFit(fit, 1000)).toMatch(/^rate \+10\.0 ± 0\.0 mm\/yr · step 2021-01-01 -20\.0 ± 0\.0 mm · RMS 0\.0 mm$/);
  });

  it('draws a gap at the step instead of a slope', () => {
    const fit = fitSeries(data, { ...DEFAULT_FIT, steps: [STEP] })!;
    const curve = modelCurve(fit);
    const gap = curve.findIndex(p => p.y === null);
    expect(gap).toBeGreaterThan(0);
    expect(curve[gap - 1].x < STEP && curve[gap + 1].x >= STEP).toBe(true);
  });

  it('says when the model cannot be estimated, and keeps units it cannot convert', () => {
    expect(fitSeries(data.slice(0, 2), DEFAULT_FIT)).toBeNull();
    expect(describeFit(null, 1000)).toMatch(/not estimable/);
    const fit = fitSeries(data, DEFAULT_FIT)!;
    expect(describeFit(fit, null, 'rad')).toContain('rad/yr');
  });
});
