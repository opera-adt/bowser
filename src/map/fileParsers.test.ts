import { describe, expect, it } from 'vitest';
import { featureBounds, fileKind, parseCsv, parseGeoJson, parseGpx, parseKml } from './fileParsers';

describe('fileKind', () => {
  it.each([
    ['a.geojson', 'geojson'], ['a.JSON', 'geojson'], ['a.csv', 'csv'], ['a.tsv', 'tsv'], ['a.kml', 'kml'], ['a.gpx', 'gpx'],
    ['a.zip', 'shapefile-zip'], ['a.shp', 'shapefile-part'], ['a.dbf', 'shapefile-part'], ['a.tif', 'geotiff'], ['a.TIFF', 'geotiff'], ['a.xyz', 'unknown'],
  ])('%s is %s', (name, kind) => expect(fileKind(name)).toBe(kind));
});

describe('readers', () => {
  it('reads GeoJSON and refuses other JSON', () => {
    const fc = parseGeoJson('{"type":"Feature","geometry":{"type":"Point","coordinates":[-90,35]},"properties":{}}');
    expect(fc.features).toHaveLength(1);
    expect(() => parseGeoJson('{"hello":1}')).toThrow();
  });

  it('reads CSV coordinate columns', () => {
    const fc = parseCsv('name,lon,lat\nwell,-90.1,34.7\n');
    expect((fc.features[0].geometry as { coordinates: number[] }).coordinates).toEqual([-90.1, 34.7]);
  });

  it('reads KML placemarks and GPX tracks', () => {
    expect(parseKml('<kml><Placemark><name>p</name><Point><coordinates>-90,35,0</coordinates></Point></Placemark></kml>').features).toHaveLength(1);
    expect(parseGpx('<gpx><wpt lat="35" lon="-90"><name>w</name></wpt></gpx>').features).toHaveLength(1);
  });

  it('gives the bounds of the features', () => {
    const fc = parseCsv('lon,lat\n-90,35\n-91,36\n');
    expect(featureBounds(fc)).toEqual([-91, 35, -90, 36]);
  });
});


describe('explicit converter provenance', () => {
  it('keeps numeric zero IDs and the declared source field through actual parsing', () => {
    const feature = { type: 'Feature', id: 0, properties: { layer: 'ordinary', source_layer: 'regions' }, geometry: { type: 'Polygon', coordinates: [[[0,0],[1,0],[1,1],[0,0]]] } };
    const result = parseGeoJson(JSON.stringify({ type: 'FeatureCollection', bowser_source_layer_property: 'source_layer', features: [feature] }));
    expect(result.bowser_source_layer_property).toBe('source_layer');
    expect(result.features).toEqual([feature]);
    expect(parseGeoJson(JSON.stringify(feature)).bowser_source_layer_property).toBeUndefined();
  });
});
