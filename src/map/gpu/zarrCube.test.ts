/** Opening a pyramid whose derived levels carry no spatial attributes of their own. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZarrSource } from './zarrCube';

const ROOT = 'http://bowser.test/zarr/';
const array = (shape: number[], dtype = 'float32', names = ['y', 'x']) => ({
  zarr_format: 3, node_type: 'array', shape, data_type: dtype,
  chunk_grid: { name: 'regular', configuration: { chunk_shape: shape } },
  chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
  fill_value: 0, codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
  dimension_names: names, attributes: {},
});
const coords = (values: number[]) => new Uint8Array(new Float64Array(values).buffer);

/** A two-level cube as the S3 one is laid out: level 1 only "derived from 0, scale 2". */
const FILES: Record<string, unknown> = {
  'zarr.json': {
    zarr_format: 3, node_type: 'group',
    attributes: {
      'proj:code': 'EPSG:32638',
      multiscales: { layout: [{ asset: '0' }, { asset: '1', derived_from: '0', transform: { scale: [2, 2] } }] },
    },
  },
  '0/zarr.json': {
    zarr_format: 3, node_type: 'group',
    attributes: { 'spatial:transform': [10, 0, 302660, 0, -10, 4057760], 'spatial:shape': [4, 4] },
  },
  '0/velocity/zarr.json': array([4, 4]),
  '1/zarr.json': { zarr_format: 3, node_type: 'group', attributes: {} },
  '1/velocity/zarr.json': array([2, 2]),
  '1/x/zarr.json': array([2], 'float64', ['x']),
  '1/y/zarr.json': array([2], 'float64', ['y']),
  // Level 1 pixel centres: 20 m pixels from the same corner.
  '1/x/c/0': coords([302670, 302690]),
  '1/y/c/0': coords([4057750, 4057730]),
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('ZarrSource.open', () => {
  it("takes a level's grid from its x/y centres when it has no spatial:transform", async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const key = url.split('?')[0].slice(ROOT.length);
      const body = FILES[key];
      if (body === undefined) return new Response('', { status: 404 });
      return body instanceof Uint8Array ? new Response(body) : new Response(JSON.stringify(body));
    }));
    const { levels, epsg } = await new ZarrSource().open({ url: ROOT, datasetId: null }, 'velocity');
    expect(epsg).toBe(32638);
    expect(levels.map(l => l.prefix)).toEqual(['0/', '1/']);
    expect(levels[0].transform).toEqual([10, 0, 302660, 0, -10, 4057760]);
    // The derived level: 20 m pixels, the same top-left corner as level 0.
    expect(levels[1].transform).toEqual([20, 0, 302660, 0, -20, 4057760]);
    expect(levels[1].shape).toEqual([2, 2]);
  });
});
