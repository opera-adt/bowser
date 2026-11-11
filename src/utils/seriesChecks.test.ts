/**
 * The series checks, on the real series ported from the OPERA DISP Portal with its expected
 * results (tests/data/series_checks_cases.json), and the flags for outliers and unwrapping errors.
 */
import { describe, expect, it } from 'vitest';
import fixture from '../../tests/data/series_checks_cases.json';
import { cubeWavelength, seriesChecks, seriesFlags, SENTINEL1_WAVELENGTH, unwrapMatch } from './seriesChecks';

type Case = { dates: string[]; mm: number[]; masked: number; expected: ReturnType<typeof seriesChecks> };
const cases = fixture.cases as unknown as Record<string, Case>;
const pts = (dates: string[], mm: number[]) => dates.map((d, i) => ({ t: Date.parse(`${d}T00:00:00Z`), value: mm[i] / 1000 }));
const run = (c: Case) => seriesChecks(pts(c.dates, c.mm), c.masked);

describe('seriesChecks', () => {
  it.each(Object.keys(cases))('measures %s as the Portal does', name => {
    expect(run(cases[name])).toEqual(cases[name].expected);
  });

  it('dates the Ridgecrest step between the acquisitions around it, and says when a jump spans a gap', () => {
    const [quake] = run(cases.ridgecrest_asc).jumps;
    expect([quake.before, quake.after]).toEqual(['2019-07-04', '2019-07-10']);
    expect(quake.size_mm).toBeLessThan(-100);
    expect(run(cases.okmok_asc).jumps.some(j => j.across_gap)).toBe(true);
    expect(run(cases.three_sisters_asc).jumps).toEqual([]);
  });

  it('copes with a very short series', () => {
    expect(seriesChecks([{ t: 0, value: 0 }])).toMatchObject({ gaps: [], jumps: [], trend_vs_noise: null });
  });
});

describe('seriesFlags', () => {
  // 60 dates 12 days apart, ±1 mm noise: a 28 mm jump (half of C band) at date 30, a 15 mm spike at 45.
  const dates = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2020, 0, 1) + i * 12 * 86_400_000).toISOString().slice(0, 10));
  const noise = (i: number) => Math.sin(i * 12.9898) * Math.cos(i * 78.233);
  const mm = dates.map((_, i) => noise(i) + (i >= 30 ? 27.7 : 0) + (i === 45 ? 15 : 0));
  const series = pts(dates, mm);
  const flags = seriesFlags(series, seriesChecks(series), SENTINEL1_WAVELENGTH);

  it('gives each step the date a model step goes at, and flags a half-wavelength jump as possible unwrapping', () => {
    expect(flags.steps).toHaveLength(1);
    expect(flags.steps[0]).toMatchObject({ before: dates[29], after: dates[30], step_date: dates[30] });
    expect(flags.steps[0].possible_unwrapping).toEqual({ cycles: 1, half_wavelength_mm: 27.7 });
  });

  it('flags a one-date spike as an outlier, not the edges of the step', () => {
    expect(flags.outliers.map(o => o.date)).toEqual([dates[45]]);
    expect(flags.outliers[0].offset_mm).toBeCloseTo(15, 0);
    expect(flags.outliers[0].possible_unwrapping).toBeNull();
  });

  it('a jump unlike k half wavelengths, or no wavelength, is not called unwrapping', () => {
    expect(unwrapMatch(40, SENTINEL1_WAVELENGTH)).toBeNull();
    expect(unwrapMatch(-55, SENTINEL1_WAVELENGTH)).toEqual({ cycles: 2, half_wavelength_mm: 27.7 });
    expect(unwrapMatch(28, null)).toBeNull();
    const big = seriesFlags(series, seriesChecks(series), 0.2384);  // L band: half is 119 mm
    expect(big.steps[0].possible_unwrapping).toBeNull();
  });
});

describe('cubeWavelength', () => {
  it("takes the cube's own, else the sensor its layers name, else none", () => {
    expect(cubeWavelength({ a: { radar_wavelength_m: 0.0555 } })).toEqual({ m: 0.0555, source: 'cube metadata' });
    expect(cubeWavelength({ displacement: { description: 'OPERA DISP-S1 displacement' } }).m).toBe(SENTINEL1_WAVELENGTH);
    expect(cubeWavelength({ displacement: { description: 'NISAR GUNW' } }).m).toBeCloseTo(0.2384, 4);
    expect(cubeWavelength({ displacement: { description: 'LOS displacement' } }).m).toBeNull();
  });
});
