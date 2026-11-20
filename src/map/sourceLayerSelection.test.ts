import { describe, expect, it, vi, afterEach } from 'vitest';
import { selectSourceLayers, sourceLayerChoices } from './sourceLayerSelection';
import { jobUpdates, overlayFromJob, type DataJob } from './addData';
import type { OverlayFeatures } from '../types';
const collection: OverlayFeatures = { type: 'FeatureCollection', bowser_source_layer_property: 'source_layer_2', features: [
  { type: 'Feature', id: 0, properties: { source_layer_2: 'regions', layer: 'original', value: 0 }, geometry: { type: 'Polygon', coordinates: [[[0,0],[2,0],[2,2],[0,2],[0,0]],[[.5,.5],[.5,1],[1,1],[1,.5],[.5,.5]]] } },
  { type: 'Feature', id: 0, properties: { source_layer_2: 'stations', missing: null }, geometry: { type: 'Point', coordinates: [20,30] } },
] };
afterEach(() => vi.unstubAllGlobals());
describe('declared vector source-layer choice', () => {
  it('preserves IDs, properties, holes and coordinates without changing the source', () => {
    const copy = structuredClone(collection);
    expect(sourceLayerChoices(collection)).toEqual([{ name: 'regions', count: 1 }, { name: 'stations', count: 1 }]);
    const selected = selectSourceLayers(collection, ['regions']);
    expect(selected.features).toEqual([collection.features[0]]);
    expect(collection).toEqual(copy);
    expect(selectSourceLayers(collection, ['stations', 'regions']).features).toEqual(collection.features);
  });
  it('does not guess source provenance from ordinary fields or incomplete annotations', () => {
    expect(sourceLayerChoices({ ...collection, bowser_source_layer_property: undefined })).toEqual([]);
    expect(sourceLayerChoices({ ...collection, features: [...collection.features, { properties: {} }] })).toEqual([]);
    expect(() => selectSourceLayers(collection, [])).toThrow();
    expect(() => selectSourceLayers(collection, ['absent'])).toThrow();
  });
  it('keeps converted multi-layer files out of maps and analysis until selected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(collection))));
    const job: DataJob = { id: 'g', name: 'Inventory.gpkg', kind: 'vector', format: 'geojson', status: 'ready', url: '/data/g.geojson' };
    const updates = await jobUpdates(overlayFromJob(job, { id: 'v' }), job);
    expect(updates.data?.features).toEqual([]);
    expect(updates.pendingSourceLayers).toEqual(collection);
    expect(updates.bounds).toEqual([0,0,20,30]);
  });
});
