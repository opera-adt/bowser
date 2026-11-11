import { afterEach, describe, expect, it, vi } from 'vitest';
import { convertingText, followData, jobUpdates, overlayFromJob, POLL_MS, type DataJob } from './addData';

afterEach(() => { vi.unstubAllGlobals(); });

const vectorJob = (over: Partial<DataJob> = {}): DataJob => ({
  id: 'g', name: 'wells.gpkg', kind: 'vector', format: 'geojson', status: 'converting', feature_count: 1,
  bounds: [-90.2, 34.7, -90.1, 34.8], ...over,
});

describe('a file added through the server', () => {
  it('says how long it has been converting, and to what', () => {
    expect(convertingText('cog')).toBe('Converting to COG…');
    expect(convertingText('cog', 42.4)).toBe('Converting to COG… 42 s');
    expect(convertingText('pmtiles', 65)).toBe('Converting to PMTiles… 1 min 5 s');
  });

  it('a small vector is fetched whole as GeoJSON, keeping its attributes', async () => {
    const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { well: 'A' }, geometry: { type: 'Point', coordinates: [-90.15, 34.75] } }] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(fc))));
    const o = overlayFromJob(vectorJob(), { id: 'v' });
    expect(o).toMatchObject({ type: 'vector', name: 'wells', conversion: { status: 'converting', format: 'geojson' } });
    const u = await jobUpdates(o, vectorJob({ status: 'ready', url: '/data/g.geojson' }));
    expect(u.data!.features).toEqual(fc.features);
    expect(u.bounds).toEqual([-90.15, 34.75, -90.15, 34.75]);
  });

  it('polls until ready, updating the row as it goes, and reports a failure', async () => {
    const replies = [vectorJob({ elapsed_s: 1.6 }), vectorJob({ status: 'failed', error: 'GDAL: no layers' })];
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return new Response(JSON.stringify(replies.shift())); }));
    const dispatch = vi.fn();
    const waits: number[] = [];
    const o = overlayFromJob(vectorJob({ elapsed_s: 0.1 }), { id: 'v' });
    const job = await followData(o, vectorJob({ elapsed_s: 0.1 }), dispatch, async ms => { waits.push(ms); });
    expect(job.status).toBe('failed');
    expect(calls).toEqual(['/data/g', '/data/g']);
    expect(waits).toEqual([POLL_MS, POLL_MS]);
    expect(dispatch.mock.calls.map(c => c[0].payload.updates.conversion)).toEqual([
      { status: 'converting', format: 'geojson', id: 'g', elapsedS: 0.1 },
      { status: 'converting', format: 'geojson', id: 'g', elapsedS: 1.6 },
      { status: 'failed', format: 'geojson', id: 'g', error: 'GDAL: no layers' },
    ]);
  });
});
