import { describe, expect, it } from 'vitest';
import { buildTileRequest } from '../../utils/tileParams';
import type { RasterGroup } from '../../types';
import { colormapIndex, displayedValue, gpuParamsFromTileQuery } from './params';
import { colormapTexture, hasColormap } from './colormap';
import { COLORMAP_OPTIONS } from '../../utils/colormaps';

const dsInfo = { x_values: ['2020-01-01', '2020-01-13', '2020-01-25'], algorithm: 'shift', uses_spatial_ref: true } as unknown as RasterGroup;
const base = {
  complexMode: 'phase', wrapEnabled: false, wrapWavelength: null, wrapPeriod: 6.28,
  refEnabled: true, refValues: { displacement: [0.01, 0.02, 0.05] }, refTimeIndex: {},
  dataMode: 'md', customMaskPath: null, layerMasks: [],
} as never;

function query(stateOver: Record<string, unknown> = {}, timeIndex = 2) {
  return buildTileRequest({
    dataset: 'displacement', dsInfo, timeIndex, vmin: -0.1, vmax: 0.1, colormap: 'rdbu',
    state: { ...(base as object), ...stateOver } as never, datasetId: null,
  }).params;
}

describe('GPU params from the tile query', () => {
  it('reads the same shift, range, date and colormap the tiles use', () => {
    const r = gpuParamsFromTileQuery(query(), 'md');
    expect(r.ok && r.params).toEqual({
      variable: 'displacement', timeIdx: 2, refTimeIdx: null, shift: 0.05, vmin: -0.1, vmax: 0.1,
      colormap: 'rdbu', mask: null,
    });
  });

  it('carries the reference date: shift is ref(t) - ref(t_ref)', () => {
    const r = gpuParamsFromTileQuery(query({ refTimeIndex: { displacement: 1 } }), 'md');
    expect(r.ok && r.params.refTimeIdx).toBe(1);
    expect(r.ok && r.params.shift).toBeCloseTo(0.03, 12);
  });

  it('takes one threshold mask, and leaves the rest to tiles', () => {
    const one = gpuParamsFromTileQuery(query({ layerMasks: [{ dataset: 'temporal_coherence', threshold: 0.7, mode: 'min' }] }), 'md');
    expect(one.ok && one.params.mask).toEqual({ dataset: 'temporal_coherence', threshold: 0.7, mode: 'min' });
    const two = gpuParamsFromTileQuery(query({ layerMasks: [
      { dataset: 'a', threshold: 1, mode: 'min' }, { dataset: 'b', threshold: 1, mode: 'max' }] }), 'md');
    expect(two.ok).toBe(false);
    expect(gpuParamsFromTileQuery(query({ wrapEnabled: true }), 'md').ok).toBe(false);
    expect(gpuParamsFromTileQuery(query({ customMaskPath: '/x.tif' }), 'md').ok).toBe(false);
    expect(gpuParamsFromTileQuery(query(), 'cog').ok).toBe(false);
    expect(gpuParamsFromTileQuery({ ...query(), rescale: '0.1,0.1' }, 'md')).toMatchObject({ ok: false, wait: true });
    expect(gpuParamsFromTileQuery({ ...query(), algorithm: 'phase' }, 'md').ok).toBe(false);
  });
});

describe('per-pixel maths (mirrors the shader)', () => {
  it('subtracts the reference date, masks, then shifts', () => {
    expect(displayedValue(0.05, 0.02, 0.01)).toBeCloseTo(0.02, 6);
    expect(displayedValue(NaN, 0.02, 0)).toBeNaN();
    expect(displayedValue(0.05, NaN, 0)).toBeNaN();
    const keep = { value: 0.8, threshold: 0.7, mode: 'min' as const };
    expect(displayedValue(0.05, null, 0, keep)).toBeCloseTo(0.05, 6);
    expect(displayedValue(0.05, null, 0, { ...keep, value: 0.6 })).toBeNaN();
    expect(displayedValue(0.05, null, 0, { ...keep, value: NaN })).toBeNaN();
    expect(displayedValue(0.05, null, 0, { ...keep, value: 0.6, mode: 'max' })).toBeCloseTo(0.05, 6);
  });

  it('maps to colormap indices as rio-tiler (clip, linear, truncate)', () => {
    expect(colormapIndex(-1, -0.1, 0.1)).toBe(0);
    expect(colormapIndex(1, -0.1, 0.1)).toBe(255);
    expect(colormapIndex(0, -0.1, 0.1)).toBe(127);
    expect(colormapIndex(NaN, -0.1, 0.1)).toBeNull();
  });
});

describe('colormap textures', () => {
  it("cover every colormap of the picker, and each one's _r form", () => {
    for (const { value } of COLORMAP_OPTIONS) {
      expect(hasColormap(value), value).toBe(true);
      expect(hasColormap(`${value}_r`), `${value}_r`).toBe(true);
    }
  });

  it('are 256 RGBA entries, with the _r form', () => {
    const rdbu = colormapTexture('RdBu')!;
    expect(rdbu.length).toBe(1024);
    expect(hasColormap('rdbu_r')).toBe(true);
    expect(colormapTexture('nope')).toBeNull();
    // matplotlib RdBu starts dark red and ends dark blue; every entry is opaque.
    expect(rdbu[0]).toBeGreaterThan(rdbu[2]);
    expect(rdbu[1020 + 2]).toBeGreaterThan(rdbu[1020]);
    for (let i = 3; i < 1024; i += 4) expect(rdbu[i]).toBe(255);
  });
});


it('requires server-proven mask coordinates for GPU drawing', () => {
  const q = query({ layerMasks: [{ dataset: 'quality', threshold: .5, mode: 'min' }] });
  expect(gpuParamsFromTileQuery(q, 'md', { displacement: dsInfo }).ok).toBe(false);
  expect(gpuParamsFromTileQuery(q, 'md', { displacement: {
    ...dsInfo, mask_compatibility: { quality: 'Dynamic mask coordinates differ' },
  } }).ok).toBe(false);
  expect(gpuParamsFromTileQuery(q, 'md', { displacement: {
    ...dsInfo, mask_compatibility: { quality: null },
  } }).ok).toBe(true);
});


it.each(['min', 'max'] as const)('rejects infinite mask values like the server (%s)', mode => {
  expect(displayedValue(1, null, 0, {value: Infinity, threshold: .5, mode})).toBeNaN();
  expect(displayedValue(1, null, 0, {value: -Infinity, threshold: .5, mode})).toBeNaN();
});
