/** A bounded display preview, never an input to area statistics or fitted rates. */
import type { PolygonTimeSeries } from './polygonSeries';
import type { AreaSeriesOptions } from './polygonSeries';
import { referencedValues } from './areaStats';
import { withOpacity } from '../map/seriesStyle';

export interface PixelPreviewOptions { curve_mode: 'sample' | 'all'; sample_count: number; support?: 'common' | 'per_date' }
export interface PixelCurve { row: number; col: number; x: number; y: number; values: (number | null)[] }
export interface PixelCurves {
  mode: 'sample' | 'all'; sample_seed: number | null;
  eligible_pixels: number; plotted_pixels: number; sampled: boolean; curves: PixelCurve[];
}
export interface PixelPreview extends PolygonTimeSeries { pixel_curves: PixelCurves }
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const integer = (v: unknown): v is number => finite(v) && Number.isInteger(v) && v >= 0;

/** Refuse unsupported, malformed or silently truncated responses; never invent curves. */
export function checkedPixelPreview(result: PolygonTimeSeries, options: PixelPreviewOptions): PixelPreview {
  const preview = (result as Partial<PixelPreview>).pixel_curves;
  if (!preview) throw new Error('This server does not provide pixel histories. Summaries remain available.');
  const bad = () => { throw new Error('The server returned inconsistent pixel histories; no preview is shown.'); };
  if ((options.support && result.support !== options.support) || !result.labels.length || result.statistics.length !== result.labels.length
      || (result.support !== 'common' && result.support !== 'per_date')
      || !integer(result.polygon_pixels) || preview.eligible_pixels > result.polygon_pixels
      || (result.support === 'common' && preview.eligible_pixels !== result.common_pixels)
      || preview.mode !== options.curve_mode || !integer(preview.eligible_pixels)
      || !integer(preview.plotted_pixels) || !Array.isArray(preview.curves)
      || preview.plotted_pixels !== preview.curves.length || preview.plotted_pixels > 500
      || preview.plotted_pixels * result.labels.length > 100_000
      || preview.sampled !== (preview.plotted_pixels < preview.eligible_pixels)
      || preview.plotted_pixels !== (options.curve_mode === 'all' ? preview.eligible_pixels : Math.min(options.sample_count, preview.eligible_pixels))
      || preview.sample_seed !== (options.curve_mode === 'sample' ? 42 : null)) bad();
  const pixels = new Set<string>();
  for (const c of preview.curves) {
    if (!integer(c.row) || !integer(c.col) || !finite(c.x) || !finite(c.y)
        || !Array.isArray(c.values) || c.values.length !== result.labels.length
        || c.values.some(v => v !== null && !finite(v))) bad();
    const id = `${c.row}:${c.col}`;
    if (pixels.has(id)) bad();
    pixels.add(id);
  }
  return result as PixelPreview;
}

/** Same spatial then temporal reference order as areaRows, retaining every null gap. */
export function pixelPreviewDatasets(o: AreaSeriesOptions & { result: PixelPreview }): Record<string, unknown>[] {
  if (o.refIndex === -1) return [];
  return o.result.pixel_curves.curves.flatMap(c => {
    const values = referencedValues(c.values, o.reference, o.refIndex ?? null);
    const data = values.map((v, i) => ({ x: o.toX(o.result.labels[i]), y: v === null ? null : v * o.factor })).filter(p => o.inRange(p.x));
    if (!data.some(p => p.y !== null)) return [];
    return [{ label: `${o.name} pixel [${c.row}, ${c.col}]`, _pixelCurve: true,
      _unit: o.unit, _note: `Native pixel [${c.row}, ${c.col}]; polygon support, not measurement uncertainty`,
      yAxisID: o.yAxisID, data, borderColor: withOpacity(o.color, 0.2), backgroundColor: 'transparent',
      borderWidth: 1, pointRadius: 0, pointHoverRadius: 3, tension: 0, spanGaps: false, fill: false, order: 2 }];
  });
}
