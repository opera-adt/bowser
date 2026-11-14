/** Raster statistics select horizontal coordinates, retaining the imported geometry. */
import { describe, expect, it } from 'vitest';
import type { ChartArea } from '../types';
import { parseKml } from '../map/fileParsers';
import { areaChartDatasets, polygonChoices, polygonRequestBody, type PolygonTimeSeries } from './polygonSeries';

const outer = [[0, 0, 10], [2, 0, 20], [2, 2, 30], [0, 0, 10]];
const hole = [[0.5, 0.5, 1], [1, 0.5, 2], [1, 1, 3], [0.5, 0.5, 1]];
const xy = (ring: number[][]) => ring.map(position => position.slice(0, 2));

describe('native polygon request coordinates', () => {
  it.each(['Polygon', 'MultiPolygon'] as const)('uses XY for %s without dropping holes or changing the source', type => {
    const coordinates = type === 'Polygon' ? [outer, hole] : [[outer, hole], [outer]];
    const geometry: ChartArea['geometry'] = { type, coordinates };
    const before = JSON.stringify(geometry);
    expect(polygonRequestBody('displacement', geometry).geometry).toEqual({ type,
      coordinates: type === 'Polygon' ? [xy(outer), xy(hole)] : [[xy(outer), xy(hole)], [xy(outer)]] });
    expect(JSON.stringify(geometry)).toBe(before);
  });

  it('accepts the altitude-bearing geometry produced by the real KML importer', () => {
    const data = parseKml('<kml><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0,0 1,0,0 1,1,0 0,0,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>');
    const choice = polygonChoices([{ id: 'kml', name: 'region', type: 'vector', visible: true, opacity: 1, data }])[0];
    expect(polygonRequestBody('displacement', choice.geometry).geometry.coordinates)
      .toEqual([[[0, 0], [1, 0], [1, 1], [0, 0]]]);
    expect(data.features[0].geometry).toMatchObject({ coordinates: [[[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 0, 0]]] });
  });

  it('asks for the same pixels at every date without masks, and for those of each date with masks', () => {
    const geometry: ChartArea['geometry'] = { type: 'Polygon', coordinates: [xy(outer)] };
    expect(polygonRequestBody('displacement', geometry).support).toBe('common');
    const masked = polygonRequestBody('displacement', geometry, [{ id: 'q', dataset: 'recommended_mask', threshold: 0.5, mode: 'min' }]);
    expect(masked.support).toBe('per_date');
    expect(masked.layer_masks).toEqual([{ dataset: 'recommended_mask', threshold: 0.5, mode: 'min' }]);
  });
});

describe('dates on which every pixel of an area is masked', () => {
  const stat = (median: number | null, count = median === null ? 0 : 5) => ({
    count, mean: median, median, spatial_std: median === null ? null : 0.001,
    minimum: median, maximum: median, percentiles: { 10: median, 90: median },
  });
  /** Ten days apart, from 2026-01-01. */
  const day = (i: number) => new Date(Date.UTC(2026, 0, 1 + 10 * i)).toISOString().slice(0, 10);
  const result = (medians: Array<number | null>): PolygonTimeSeries => ({
    labels: medians.map((_, i) => day(i)), units: 'm', support: 'per_date',
    statistics: medians.map(m => stat(m)),
  });
  const series = (medians: Array<number | null>) => areaChartDatasets({
    result: result(medians), name: 'Dam', color: '#1f77b4', factor: 1, unit: 'm', yAxisID: 'y0', reference: null,
    toX: (x: string) => x, inRange: () => true,
  });

  it('are hollow dashed markers on the line between their neighbours; the rest of the series is drawn', () => {
    const sets = series([0, null, 0.04, null, null, 0.1, null]);
    const median = sets.find(d => d.label === 'Dam median')!;
    expect((median.data as Array<{ y: number }>).map(p => p.y)).toEqual([0, 0.04, 0.1]);
    const masked = sets.find(d => d.label === 'Dam fully masked')!;
    // Unfilled, with a dashed outline in the area's line colour.
    expect(masked).toMatchObject({ showLine: false, backgroundColor: 'transparent', pointBackgroundColor: 'transparent',
      pointBorderColor: '#1f77b4', borderDash: [2.5, 2], _masked: true, _legend: 'Dam fully masked' });
    const points = masked.data as Array<{ x: string; y: number }>;
    expect(points.map(p => p.x)).toEqual([day(1), day(3), day(4), day(6)]);
    expect(points[0].y).toBeCloseTo(0.02, 10);            // halfway between 0 and 0.04
    expect(points[1].y).toBeCloseTo(0.06, 10);            // a third of the way from 0.04 to 0.1
    expect(points[2].y).toBeCloseTo(0.08, 10);
    expect(points[3].y).toBeCloseTo(0.1, 10);             // after the last valid date: its value
  });

  it('add nothing when every date has pixels, or when none has', () => {
    expect(series([0, 0.01, 0.02]).map(d => d.label)).toEqual(['Dam +1 std', 'Dam −1 std', 'Dam median', 'Dam mean']);
    expect(series([null, null]).some(d => d.label === 'Dam fully masked')).toBe(false);
  });
});
