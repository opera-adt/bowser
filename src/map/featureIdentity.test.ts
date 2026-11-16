import { describe, expect, it } from 'vitest';
import { parseGeoJson } from './fileParsers';
import { polygonChoices, pointChoices } from '../utils/polygonSeries';
import { chartedFeatureColors } from './overlays';
import { featureSources, featureSourceKey } from './featureIdentity';
import type { Overlay } from '../types';

const polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
const feature = (id: unknown, name: string, layer = 'regions') => ({
  type: 'Feature', id, properties: { name, source_layer: layer, count: 0, empty: null }, geometry: polygon,
});
const collection = (features: unknown[]) => ({ type: 'FeatureCollection',
  bowser_source_layer_property: 'source_layer', features });
const overlay = (input: unknown): Overlay => ({
  id: 'inventory', name: 'Regions', type: 'vector', visible: true, opacity: 1,
  data: parseGeoJson(JSON.stringify(input)),
});

describe('imported feature identity', () => {
  it('retains source IDs, layer-field provenance, original attributes and geometry', () => {
    const input = collection([feature(0, 'First'), feature('0', 'Second')]);
    expect(parseGeoJson(JSON.stringify(input))).toEqual(input);
  });

  it('keeps a uniquely identified polygon selection stable when file order changes', () => {
    const first = feature(0, 'First'); const second = feature('0', 'Second');
    const before = polygonChoices([overlay(collection([first, second]))]);
    const after = polygonChoices([overlay(collection([second, first]))]);
    expect(before[0].key).toBe(after[1].key);
    expect(before[1].key).toBe(after[0].key);
    expect(before[0].key).not.toBe(before[1].key);
  });
  it('retains IDs on individual features and arrays, including zero and empty strings', () => {
    for (const id of [0, '', '0', 7, 'region:a']) {
      const f = feature(id, 'Feature');
      expect(parseGeoJson(JSON.stringify(f)).features[0].id).toBe(id);
      expect(parseGeoJson(JSON.stringify([f])).features[0].id).toBe(id);
    }
  });

  it('namespaces repeated IDs only using explicitly declared source-layer metadata', () => {
    const a = feature(1, 'First', 'zones'); const b = feature(1, 'Second', 'stations');
    const choices = polygonChoices([overlay(collection([a, b]))]);
    expect(choices.map(c => c.source.sourceLayer)).toEqual(['zones', 'stations']);
    expect(choices.every(c => c.source.featureKey !== undefined)).toBe(true);
    expect(new Set(choices.map(c => c.key)).size).toBe(2);
    const withoutDeclaration = { type: 'FeatureCollection', features: [a, b] };
    expect(polygonChoices([overlay(withoutDeclaration)]).map(c => c.key)).toEqual(['inventory:0', 'inventory:1']);
  });

  it('does not merge duplicate IDs in one source layer or invent IDs for missing ones', () => {
    const missing = { type: 'Feature', properties: {}, geometry: polygon };
    const o = overlay(collection([feature(1, 'First'), feature(1, 'Second'), missing]));
    expect(polygonChoices([o]).map(c => c.key)).toEqual(['inventory:0', 'inventory:1', 'inventory:2']);
    expect(polygonChoices([o]).every(c => c.source.featureKey === undefined)).toBe(true);
  });

  it('ignores unsupported ID types rather than turning them into colliding strings', () => {
    for (const id of [null, true, [], { id: 1 }]) {
      expect(parseGeoJson(JSON.stringify(feature(id, 'Feature'))).features[0]).not.toHaveProperty('id');
    }
    expect(featureSources('inventory', 'Regions', { type: 'FeatureCollection', features: [feature(Infinity, 'Feature')] })[0].featureKey).toBeUndefined();
  });

  it('uses unambiguous typed tuples even for delimiters in layer names and IDs', () => {
    const input = collection([feature('b:c', 'One', 'a'), feature('c', 'Two', 'a:b')]);
    const choices = polygonChoices([overlay(input)]);
    expect(new Set(choices.map(c => c.key)).size).toBe(2);
  });

  it('uses the same source identity for point selections', () => {
    const f = { ...feature(0, 'Station'), geometry: { type: 'Point', coordinates: [3, 4] } };
    const point = pointChoices(overlay(collection([f])))[0];
    expect(point.source.featureId).toBe(0);
    expect(point.key).toBe(featureSourceKey(point.source));
    expect(point.position).toEqual([4, 3]);
  });

  it('keeps chart colors attached to the ID after reordering, never to a replacement at the old index', () => {
    const a = feature('A', 'First'); const b = feature('B', 'Second');
    const initial = overlay(collection([a, b]));
    const source = polygonChoices([initial])[0].source;
    const charted = [{ source, color: '#123456' }];
    expect([...chartedFeatureColors(overlay(collection([b, a])), charted)]).toEqual([[1, '#123456']]);
    expect([...chartedFeatureColors(overlay(collection([b])), charted)]).toEqual([]);
    expect([...chartedFeatureColors(overlay(collection([a, a])), charted)]).toEqual([]);
  });

  it('retains legacy index identity and handles absent source-layer attributes', () => {
    expect(featureSourceKey({ overlayId: 'inventory', index: 2 })).toBe('inventory:2');
    const input = collection([{ type: 'Feature', id: 'A', geometry: polygon, properties: {} }]);
    expect(polygonChoices([overlay(input)])[0].source).not.toHaveProperty('sourceLayer');
  });
  it('preserves multipart polygons, holes and attributes without changing their analysis geometry', () => {
    const outer = [[0, 0], [4, 0], [4, 4], [0, 0]];
    const hole = [[1, 1], [2, 1], [2, 2], [1, 1]];
    const geometry = { type: 'MultiPolygon', coordinates: [[outer, hole], [[[5, 5], [6, 5], [6, 6], [5, 5]]]] };
    const input = collection([{ ...feature('area', 'Area'), geometry }]);
    const choices = polygonChoices([overlay(input)]);
    expect(choices[0].geometry).toEqual(geometry);
    expect(choices[0].source.featureId).toBe('area');
  });

});
