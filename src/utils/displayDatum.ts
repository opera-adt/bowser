/** Separate explicitly declared plotting datums from measured observations.
 * Ordinary zero measurements and responses without this annotation are unchanged.
 * Never infer a datum from a zero value, layer name or reference-date attribute.
 */
import type { MultiPointTimeSeriesData } from '../types';
import type { PolygonTimeSeries } from './polygonSeries';

export interface DisplayDatum { x: string; y: 0 }
type XY = { x: string; y: number };
export interface BufferObservations {
  labels: string[];
  median: XY[];
  samples: XY[][];
  displayDatum?: DisplayDatum;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function declaration(body: { labels: string[] }): { date: string; index: number } | null {
  const raw = record((body as unknown as Record<string, unknown>).display_datum);
  if (!raw || raw.independent_observation !== false) return null;
  const date = raw.date;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date
      || raw.value !== 0) throw new Error('Invalid non-observation display datum');
  const index = body.labels.indexOf(date);
  if (index < 0) return null; // Already separated (idempotent).
  if (body.labels.lastIndexOf(date) !== index
      || body.labels.some((label, i) => i !== index && !(Date.parse(label) > Date.parse(date)))) {
    throw new Error('Display datum must uniquely precede all observations');
  }
  return { date, index };
}

function points(data: XY[], date: string, labels: string[]): { data: XY[]; displayDatum?: DisplayDatum } {
  const marked = data.filter(p => p.x === date);
  if (marked.length > 1 || marked.some(p => p.y !== 0)) throw new Error('Invalid display datum point');
  const observations = data.filter(p => p.x !== date);
  const complete = marked.length === 1 && labels.length > 0 && observations.length === labels.length
    && observations.every((p, i) => p.x === labels[i] && Number.isFinite(p.y));
  return { data: observations, ...(complete ? { displayDatum: { x: date, y: 0 as const } } : {}) };
}

export function pointObservations(body: MultiPointTimeSeriesData): MultiPointTimeSeriesData {
  const datum = declaration(body);
  if (!datum) return body;
  const labels = body.labels.filter((_, i) => i !== datum.index);
  return { ...body, labels, datasets: body.datasets.map(ds => ({ ...ds, ...points(ds.data, datum.date, labels) })) };
}

export function bufferObservations<T extends BufferObservations>(body: T): T & BufferObservations {
  const datum = declaration(body);
  if (!datum) return body;
  const labels = body.labels.filter((_, i) => i !== datum.index);
  const median = points(body.median, datum.date, labels);
  return { ...body, labels, median: median.data, displayDatum: median.displayDatum,
    samples: body.samples.map(sample => points(sample, datum.date, labels).data) };
}

export function polygonObservations(body: PolygonTimeSeries): PolygonTimeSeries {
  const datum = declaration(body);
  if (!datum) return body;
  const remove = <T>(values: T[]): T[] => {
    if (values.length !== body.labels.length) throw new Error('Unaligned display datum statistics');
    return values.filter((_, i) => i !== datum.index);
  };
  const statistics = remove(body.statistics);
  const row = body.statistics[datum.index];
  const numbers = [row.mean, row.median, row.spatial_std, row.minimum, row.maximum, ...Object.values(row.percentiles)];
  if (numbers.some(v => v !== null && v !== 0)) throw new Error('Invalid display datum statistic');
  const raw = body as unknown as Record<string, unknown>;
  const extra: Record<string, unknown> = {};
  for (const key of ['quality_valid_per_date', 'reference_valid_per_date']) {
    if (Array.isArray(raw[key])) extra[key] = remove(raw[key]);
  }
  if (Array.isArray(raw.curves)) extra.curves = raw.curves.map((curve: Record<string, unknown>) => ({
    ...curve, ...(Array.isArray(curve.values) ? { values: remove(curve.values) } : {}),
  }));
  const reference = record(raw.reference);
  if (Array.isArray(reference?.offsets)) extra.reference = { ...reference, offsets: remove(reference.offsets) };
  const complete = body.support === 'common' && row.count > 0 && statistics.length > 0
    && numbers.every(v => v === 0)
    && statistics.every(s => s.count === row.count && s.median !== null && Number.isFinite(s.median))
    && (!Array.isArray(raw.reference_valid_per_date) || raw.reference_valid_per_date.every(v => v === true));
  return { ...body, ...extra, labels: remove(body.labels), statistics,
    ...(complete ? { displayDatum: { x: datum.date, y: 0 } } : {}) };
}

/** A datum is a labeled annotation, never a line segment or a statistical sample. */
export function datumMarker(datum: DisplayDatum, color: string): Record<string, unknown> {
  return { _datum: true, _note: 'Defined reference datum; not an independent observation',
    data: [{ ...datum }], showLine: false, fill: false, pointStyle: 'rectRot',
    pointRadius: 5, pointHoverRadius: 7, pointBackgroundColor: 'transparent',
    pointBorderColor: color, borderColor: color, backgroundColor: 'transparent' };
}
