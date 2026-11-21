import { describe, expect, it } from 'vitest';
import { checkedPixelPreview, pixelPreviewDatasets, type PixelPreview } from './polygonPixelPreview';

const labels = ['2026-01-01', '2026-01-13', '2026-01-25'];
export function preview(): PixelPreview {
  return { labels, units: 'meters', support: 'per_date', polygon_pixels: 2, common_pixels: 1,
    statistics: [0, 7, 14].map(v => ({ count: 2, mean: v, median: v, spatial_std: 1,
      minimum: v - 1, maximum: v + 1, percentiles: { '10': v - 1, '90': v + 1 } })),
    pixel_curves: { mode: 'sample', sample_seed: 42, eligible_pixels: 2, plotted_pixels: 2, sampled: false,
      curves: [
        { row: 0, col: 0, x: 3, y: 4, values: [0, 6, 12] },
        { row: 0, col: 1, x: 4, y: 4, values: [0, null, 16] },
      ] },
  };
}
const base = () => ({ result: preview(), name: 'Region', color: '#123456', factor: 1,
  unit: 'm', yAxisID: 'y0', reference: null, toX: (x: string) => x, inRange: () => true });
const values = (datasets: Record<string, unknown>[]) => datasets.map(d => (d.data as { y: number | null }[]).map(p => p.y));

describe('polygon pixel display', () => {
  it('validates the bounded response without editing its values or summary statistics', () => {
    const input = preview(); const copy = structuredClone(input);
    expect(checkedPixelPreview(input, { curve_mode: 'sample', sample_count: 50 })).toBe(input);
    expect(values(pixelPreviewDatasets(base()))).toEqual([[0, 6, 12], [0, null, 16]]);
    expect(input).toEqual(copy);
  });
  it('subtracts the spatial reference once, retaining zero and missing dates', () => {
    expect(values(pixelPreviewDatasets({ ...base(), reference: [0, 1, 2] }))).toEqual([[0, 5, 10], [0, null, 14]]);
  });
  it('subtracts the temporal baseline after the spatial reference and converts display units once', () => {
    const o = { ...base(), reference: [0, 1, 2], refIndex: 1, factor: 1000 };
    expect(values(pixelPreviewDatasets(o))).toEqual([[-5000, 0, 5000]]);
    expect(o.result.pixel_curves.curves[0].values).toEqual([0, 6, 12]);
  });
  it('does not invent support when reference values are missing', () => {
    expect(values(pixelPreviewDatasets({ ...base(), reference: [0, NaN, 2] }))).toEqual([[0, null, 10], [0, null, 14]]);
    expect(pixelPreviewDatasets({ ...base(), refIndex: -1 })).toEqual([]);
    expect(pixelPreviewDatasets({ ...base(), reference: [NaN, NaN, NaN] })).toEqual([]);
  });
  it('keeps gaps and applies the date range only to display, not the source histories', () => {
    const out = pixelPreviewDatasets({ ...base(), inRange: x => x >= labels[1] });
    expect(values(out)).toEqual([[6, 12], [null, 16]]);
    expect(out.every(d => d.spanGaps === false && d._pixelCurve === true)).toBe(true);
  });
  it('rejects absent capabilities, wrong labels/counts, truncation, duplicate pixels and malformed values', () => {
    const options = { curve_mode: 'sample' as const, sample_count: 50 };
    expect(() => checkedPixelPreview({ ...preview(), pixel_curves: undefined } as unknown as PixelPreview, options)).toThrow(/does not provide/);
    for (const mutate of [
      (p: PixelPreview) => { p.pixel_curves.plotted_pixels = 1; },
      (p: PixelPreview) => { p.pixel_curves.curves[0].values.pop(); },
      (p: PixelPreview) => { p.pixel_curves.curves[1].col = 0; },
      (p: PixelPreview) => { p.pixel_curves.curves[0].values[1] = Infinity; },
      (p: PixelPreview) => { p.pixel_curves.sample_seed = 1; },
    ]) { const p = preview(); mutate(p); expect(() => checkedPixelPreview(p, options)).toThrow(/inconsistent/); }
  });
});


it('requires preview support to match an explicitly selected summary support', () => {
  expect(checkedPixelPreview(preview(), { curve_mode: 'sample', sample_count: 50, support: 'per_date' }).support).toBe('per_date');
  expect(() => checkedPixelPreview(preview(), { curve_mode: 'sample', sample_count: 50, support: 'common' })).toThrow();
});
