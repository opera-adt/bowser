/** Raster statistics select horizontal coordinates, retaining the imported geometry. */
import { describe, expect, it } from 'vitest';
import type { ChartArea } from '../types';
import { parseKml } from '../map/fileParsers';
import { polygonChoices, polygonRequestBody } from './polygonSeries';

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
});
