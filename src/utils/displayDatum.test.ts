import { describe, expect, it } from 'vitest';
import { bufferObservations, pointObservations, polygonObservations } from './displayDatum';
import type { MultiPointTimeSeriesData } from '../types';
import { areaChartDatasets, type PolygonTimeSeries } from './polygonSeries';
import { areaRows, medianTrend } from './areaStats';
import { DEFAULT_FIT, fitSeries } from '../map/fitSettings';
import { displayUnit } from './units';

const date = '2026-01-01';
const labels = ['2026-01-13', '2026-02-13', '2026-03-13'];
const data = labels.map((x, i) => ({ x, y: i + 2 }));
const declaration = { date, value: 0, independent_observation: false };
const series = (points = data) => ({
  label: 'Point', pointId: 'p', borderColor: '#123456', backgroundColor: '#123456', data: points.map(p => ({ ...p })),
});
const payload = () => ({ labels: [date, ...labels], display_datum: declaration,
  datasets: [series([{ x: date, y: 0 }, ...data])] });
const statistic = (value: number | null, count = 5) => ({ count, mean: value, median: value,
  spatial_std: value === null ? null : 0, minimum: value, maximum: value,
  percentiles: { '10': value, '90': value } });
const polygon = () => ({ labels: [date, ...labels], display_datum: declaration,
  support: 'common' as const, units: 'meters', statistics: [statistic(0), ...data.map(p => statistic(p.y))],
  quality_valid_per_date: [5, 5, 5, 5], reference_valid_per_date: [true, true, true, true],
  curves: [{ name: 'median', values: [0, 2, 3, 4] }], reference: { offsets: [0, 1, 1, 1] },
});

describe('explicit non-observation datums', () => {
  it('separates immutably and idempotently, preserving the observation-only fit', () => {
    const original = payload();
    const copy = structuredClone(original);
    const out = pointObservations(original);
    expect(out.labels).toEqual(labels);
    expect(out.datasets[0].data).toEqual(data);
    expect(out.datasets[0].displayDatum).toEqual({ x: date, y: 0 });
    expect(original).toEqual(copy);
    expect(pointObservations(out)).toBe(out);
    expect(fitSeries(out.datasets[0].data, DEFAULT_FIT)?.rate).toBe(fitSeries(data, DEFAULT_FIT)?.rate);
    expect(fitSeries(original.datasets[0].data, DEFAULT_FIT)?.rate).not.toBe(fitSeries(data, DEFAULT_FIT)?.rate);
  });

  it('preserves genuine zero measurements, including a reference-date zero without a declaration', () => {
    const ordinary = { labels: [date, ...labels], datasets: [series([{ x: date, y: 0 }, ...data])] };
    expect(pointObservations(ordinary)).toBe(ordinary);
    const input = payload();
    input.datasets[0].data[1].y = 0;
    expect(pointObservations(input).datasets[0].data[0]).toEqual({ x: labels[0], y: 0 });
  });

  it('leaves an explicitly independent sample unchanged', () => {
    const input = { ...payload(), display_datum: { ...declaration, independent_observation: true } };
    expect(pointObservations(input)).toBe(input);
  });

  it('does not manufacture annotations for incomplete or empty histories', () => {
    const input = payload();
    input.datasets = [series(data.slice(1)), series([]), series([{ x: date, y: 0 }, ...data.slice(1)])];
    expect(pointObservations(input).datasets.every(d => !d.displayDatum)).toBe(true);
    expect(pointObservations(input).datasets[1].data).toEqual([]);
  });

  it.each([
    { ...declaration, date: '2026-02-30' },
    { ...declaration, value: 1 },
    { ...declaration, date: 'not-a-date' },
  ])('rejects malformed non-observation declarations (%j)', display_datum => {
    expect(() => pointObservations({ ...payload(), display_datum } as MultiPointTimeSeriesData)).toThrow();
  });

  it('rejects duplicate, misplaced and nonzero annotated samples', () => {
    const duplicate = payload(); duplicate.labels.push(date);
    expect(() => pointObservations(duplicate)).toThrow();
    expect(() => pointObservations({ ...payload(), labels: [date, '2025-12-31'] })).toThrow();
    const bad = payload(); bad.datasets[0].data[0].y = 1;
    expect(() => pointObservations(bad)).toThrow();
  });

  it('separates radius median and sample observations without creating support', () => {
    const input = { labels: [date, ...labels], display_datum: declaration,
      median: [{ x: date, y: 0 }, ...data], samples: [[{ x: date, y: 0 }, ...data], [], data.slice(1)] };
    const out = bufferObservations(input);
    expect(out.labels).toEqual(labels);
    expect(out.median).toEqual(data);
    expect(out.samples).toEqual([data, [], data.slice(1)]);
    expect(out.displayDatum).toEqual({ x: date, y: 0 });
    expect(input.median).toHaveLength(4);
    expect(bufferObservations(out)).toBe(out);
  });

  it('aligns polygon statistics and all parallel support/reference arrays', () => {
    const input = polygon(); const copy = structuredClone(input);
    const out = polygonObservations(input) as ReturnType<typeof polygon> & PolygonTimeSeries;
    expect(out.labels).toEqual(labels);
    expect(out.statistics.map(s => s.median)).toEqual([2, 3, 4]);
    expect(out.quality_valid_per_date).toEqual([5, 5, 5]);
    expect(out.reference_valid_per_date).toEqual([true, true, true]);
    expect(out.curves[0].values).toEqual([2, 3, 4]);
    expect(out.reference.offsets).toEqual([1, 1, 1]);
    expect(out.displayDatum).toEqual({ x: date, y: 0 });
    expect(input).toEqual(copy);
    expect(polygonObservations(out)).toBe(out);
    const rows = areaRows(out, null);
    expect(medianTrend(rows, x => x, displayUnit('meters', 'metric'))).toBeCloseTo(fitSeries(data, DEFAULT_FIT)!.rate * 1000);
  });

  it('removes the empty polygon datum row without inventing common support', () => {
    const input = { ...polygon(), support: 'per_date' as const };
    input.statistics[0] = statistic(null, 0);
    const out = polygonObservations(input);
    expect(out.labels).toEqual(labels);
    expect(out.displayDatum).toBeUndefined();
  });

  it('renders a separate polygon datum only without an additional reference or range exclusion', () => {
    const result = polygonObservations(polygon());
    const options = { result, name: 'Area', color: '#123456', factor: 1, unit: 'm', yAxisID: 'y0',
      reference: null, toX: (x: string) => x, inRange: () => true };
    const drawn = areaChartDatasets(options);
    expect(drawn.find(d => d._datum)?.data).toEqual([{ x: date, y: 0 }]);
    expect(drawn.find(d => d.label === 'Area median')?.data).toEqual(data);
    expect(areaChartDatasets({ ...options, refIndex: 1 }).some(d => d._datum)).toBe(false);
    expect(areaChartDatasets({ ...options, reference: [0, 0, 0] }).some(d => d._datum)).toBe(false);
    expect(areaChartDatasets({ ...options, inRange: x => x !== date }).some(d => d._datum)).toBe(false);
  });

  it('rejects inconsistent polygon array lengths and nonzero datum statistics', () => {
    const input = polygon(); input.reference.offsets.pop();
    expect(() => polygonObservations(input)).toThrow();
    const invalid = polygon(); invalid.statistics[0].median = 1;
    expect(() => polygonObservations(invalid)).toThrow();
  });
});
