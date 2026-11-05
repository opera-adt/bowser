/** Raster tile URL hook: when it asks the backend for a tilejson, and what it returns. */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState: Record<string, unknown> = {};
vi.mock('../context/AppContext', () => ({ useAppContext: () => ({ state: mockState, dispatch: vi.fn() }) }));

import { useRasterTileUrl } from './useRasterTileUrl';

const info = {
  name: 'displacement', file_list: [], mask_file_list: [], mask_min_value: 0, nodata: null,
  uses_spatial_ref: true, algorithm: 'shift', latlon_bounds: [0, 0, 0, 0],
  x_values: ['2026-01-01', '2026-01-13'], available_mask_vars: [],
};

let urls: string[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  urls = [];
  Object.assign(mockState, {
    currentDataset: 'displacement', datasetInfo: { displacement: info, velocity: { ...info, name: 'velocity', algorithm: null } },
    dataMode: 'md', colormap: 'rdbu_r', vmin: -0.01, vmax: 0.01, currentTimeIndex: 1, refValues: {},
    refMarkerPosition: [0, 0], refEnabled: false, layerMasks: [], customMaskPath: null, wrapEnabled: false,
    wrapWavelength: null, wrapPeriod: 0.0277, complexMode: 'phase',
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify({ tiles: [`http://h/md/tiles/{z}/{x}/{y}.png?n=${urls.length}`] }));
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
}

describe('useRasterTileUrl', () => {
  it('fetches the tilejson once after the debounce and returns its tile template', async () => {
    const { result } = renderHook(() => useRasterTileUrl());
    expect(result.current).toBeNull();
    await settle();
    expect(urls).toEqual(['/md/WebMercatorQuad/tilejson.json?variable=displacement&time_idx=1&rescale=-0.01%2C0.01&colormap_name=rdbu_r&tilesize=256&algorithm=shift']);
    expect(result.current).toBe('http://h/md/tiles/{z}/{x}/{y}.png?n=1');
  });

  it('uses the split-screen overrides', async () => {
    renderHook(() => useRasterTileUrl({ dataset: 'velocity', colormap: 'viridis', vmin: 0, vmax: 1, timeIndex: 0 }));
    await settle();
    expect(urls[0]).toBe('/md/WebMercatorQuad/tilejson.json?variable=velocity&time_idx=0&rescale=0%2C1&colormap_name=viridis&tilesize=256');
  });

  it('asks for nothing without a dataset or with an unknown data mode', async () => {
    mockState.currentDataset = null;
    renderHook(() => useRasterTileUrl());
    await settle();
    mockState.currentDataset = 'displacement';
    mockState.dataMode = 'unknown';
    renderHook(() => useRasterTileUrl());
    await settle();
    expect(urls).toEqual([]);
  });
});
