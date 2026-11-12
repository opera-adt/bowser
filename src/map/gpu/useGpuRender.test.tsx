import { useEffect } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as maplibregl from 'maplibre-gl';
import { AppProvider, useAppContext } from '../../context/AppContext';
import type { RasterGroup } from '../../types';
import { resetGpuCapsCache } from './capability';
import { statsText, useGpuRender, type GpuRenderStatus } from './useGpuRender';

// The GPU runtime (zarrita, colormap tables, the custom layer), as the hook loads it.
const rt = vi.hoisted(() => {
  const layers: {
    id: string; setParams: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>;
    opts: { onFailure: (r: string) => void; watchSlowFrames: boolean };
  }[] = [];
  return {
    loaded: 0,
    layers,
    open: vi.fn(async (_url: string, _variable: string, _datasetId: string | null) => ({ levels: [] })),
    hasColormap: (name: string) => name !== 'nocmap',
  };
});
vi.mock('./runtime', () => {
  rt.loaded++;
  return {
    GpuCube: { open: rt.open },
    GpuCubeLayer: class {
      readonly id = 'gpu-data';
      setParams = vi.fn();
      close = vi.fn();
      stats = () => ({ textureBytes: 3 * 1048576, peakTextureBytes: 4 * 1048576, budgetBytes: 384 * 1048576,
        f16: 3, f32: 1, evicted: 2, dropped: 0, maxHalfError: 1e-5, drawMs: null });
      constructor(_cube: unknown, public opts: { onFailure: (r: string) => void; watchSlowFrames: boolean }) {
        rt.layers.push(this as never);
      }
    },
    hasColormap: rt.hasColormap,
  };
});

const layer = (over: Partial<RasterGroup> = {}): RasterGroup => ({
  name: 'displacement', file_list: [], mask_file_list: [], mask_min_value: 0, nodata: null,
  uses_spatial_ref: false, algorithm: 'shift', latlon_bounds: [0, 0, 1, 1], available_mask_vars: [],
  x_values: ['2020-01-01', '2020-01-13', '2020-01-25'], reference_date: '2020-01-01', ...over,
} as RasterGroup);

function fakeMap() {
  const ids = new Set<string>();
  return {
    addLayer: vi.fn((l: { id: string }) => { ids.add(l.id); }),
    removeLayer: vi.fn((id: string) => { ids.delete(id); }),
    getLayer: vi.fn((id: string) => (ids.has(id) ? { id } : undefined)),
  };
}

let status: GpuRenderStatus;
let dispatch: ReturnType<typeof useAppContext>['dispatch'];
function Probe({ map, blocked = null, mode = 'md' }: { map: ReturnType<typeof fakeMap>; blocked?: string | null; mode?: string }) {
  const ctx = useAppContext();
  dispatch = ctx.dispatch;
  useEffect(() => {
    ctx.dispatch({ type: 'SET_DATASETS', payload: { displacement: layer(), velocity: layer({ name: 'velocity', x_values: [] }) } });
    ctx.dispatch({ type: 'SET_CURRENT_DATASET', payload: 'displacement' });
    ctx.dispatch({ type: 'SET_DATA_MODE', payload: mode });
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  status = useGpuRender(map as unknown as maplibregl.Map, true, () => undefined, blocked);
  return null;
}

function start(url: string, props: { blocked?: string | null; mode?: string } = {}) {
  window.history.replaceState({}, '', url);
  const map = fakeMap();
  const view = render(<AppProvider><Probe map={map} {...props} /></AppProvider>);
  return { map, view };
}

// jsdom has no WebGL: getContext answers null, as a browser without WebGL2.
vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
const info = vi.spyOn(console, 'info').mockImplementation(() => {});
const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
beforeEach(() => {
  rt.layers.length = 0;
  rt.open.mockClear();
  info.mockClear();
  warn.mockClear();
  sessionStorage.clear();
  resetGpuCapsCache();
});
afterEach(() => { cleanup(); window.history.replaceState({}, '', '/'); });

describe('useGpuRender', () => {
  it('keeps server tiles by default and never loads the GPU runtime', async () => {
    const { map } = start('/');
    await act(async () => {});
    expect(status).toMatchObject({ active: false, renderer: 'tiles', showLabel: false });
    expect(rt.loaded).toBe(0);
    expect(map.addLayer).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();   // nothing in the console either
  });

  it('auto without a capable GPU (no WebGL2 here) keeps tiles without loading the runtime', async () => {
    start('/?render=auto');
    await act(async () => {});
    expect(status.renderer).toBe('tiles');
    expect(status.reason).toBe('auto: no WebGL2');
    expect(status.showLabel).toBe(true);
    expect(rt.loaded).toBe(0);
    expect(info).toHaveBeenCalledWith('[bowser] data layer: tiles — auto: no WebGL2');
  });

  it('?render=gpu draws with the GPU layer, reading /zarr/ with the tile parameters', async () => {
    const { map } = start('/?render=gpu');
    await waitFor(() => expect(rt.layers).toHaveLength(1));
    expect(status).toMatchObject({ active: true, renderer: 'gpu', reason: 'render=gpu (forced)' });
    expect(rt.open).toHaveBeenCalledWith(`${window.location.origin}/zarr/`, 'displacement', null);
    expect(map.addLayer).toHaveBeenCalledTimes(1);
    const gl = rt.layers[0];
    expect(gl.opts.watchSlowFrames).toBe(false);   // forced GPU keeps going on a slow GPU
    await waitFor(() => expect(gl.setParams).toHaveBeenCalled());
    expect(gl.setParams.mock.lastCall![0]).toMatchObject({ variable: 'displacement', timeIdx: 0, mask: null });
    expect(info).toHaveBeenCalledWith('[bowser] data layer: GPU — render=gpu (forced)');

    // A colormap change is a parameter change, not a new layer.
    act(() => { dispatch({ type: 'SET_COLORMAP', payload: 'viridis' }); });
    await waitFor(() => expect(gl.setParams.mock.lastCall![0]).toMatchObject({ colormap: 'viridis' }));
    expect(map.addLayer).toHaveBeenCalledTimes(1);
  });

  it('opens a catalog entry by its ?dataset= id', async () => {
    start('/?render=gpu&dataset=frame-1');
    await waitFor(() => expect(rt.open).toHaveBeenCalled());
    expect(rt.open).toHaveBeenCalledWith(`${window.location.origin}/zarr/`, 'displacement', 'frame-1');
  });

  it('draws tiles for a view the GPU path cannot draw, then the GPU again', async () => {
    const { map } = start('/?render=gpu');
    await waitFor(() => expect(rt.layers).toHaveLength(1));
    const gl = rt.layers[0];
    await waitFor(() => expect(gl.setParams).toHaveBeenCalled());
    // Rewrap (as any view params.ts refuses): tiles; the GPU layer stays, drawing nothing.
    act(() => { dispatch({ type: 'TOGGLE_WRAP' }); });
    expect(status).toMatchObject({ active: false, renderer: 'tiles' });
    expect(status.reason).toMatch(/rewrap.*not on the GPU path yet/);
    await waitFor(() => expect(gl.setParams.mock.lastCall![0]).toBeNull());
    expect(map.removeLayer).not.toHaveBeenCalled();
    act(() => { dispatch({ type: 'TOGGLE_WRAP' }); });
    expect(status.active).toBe(true);
    await waitFor(() => expect(gl.setParams.mock.lastCall![0]).toMatchObject({ variable: 'displacement' }));
    expect(map.addLayer).toHaveBeenCalledTimes(1);
  });

  it('a colormap without a table, or 3D terrain, draws tiles while it lasts', async () => {
    start('/?render=gpu');
    await waitFor(() => expect(rt.layers).toHaveLength(1));
    const gl = rt.layers[0];
    act(() => { dispatch({ type: 'SET_COLORMAP', payload: 'nocmap' }); });
    expect(status).toMatchObject({ active: false, reason: 'colormap nocmap not on the GPU path yet' });
    await waitFor(() => expect(gl.setParams.mock.lastCall![0]).toBeNull());
    act(() => { dispatch({ type: 'SET_COLORMAP', payload: 'rdbu' }); });
    expect(status.active).toBe(true);
    cleanup();

    start('/?render=gpu', { blocked: '3D terrain' });
    await act(async () => {});
    expect(status).toMatchObject({ active: false, reason: '3D terrain not on the GPU path yet' });
  });

  it('falls back to tiles without a reload when the GPU layer fails', async () => {
    const { map } = start('/?render=gpu');
    await waitFor(() => expect(rt.layers).toHaveLength(1));
    act(() => { rt.layers[0].opts.onFailure('WebGL context lost'); });
    expect(status).toMatchObject({ active: false, renderer: 'tiles', reason: 'fell back to tiles: WebGL context lost' });
    expect(map.removeLayer).toHaveBeenCalledWith('gpu-data');
    expect(rt.layers[0].close).toHaveBeenCalled();   // its decoder workers stop
    expect(warn).toHaveBeenCalledWith('[bowser] data layer: tiles — fell back to tiles: WebGL context lost');
  });

  it("shows the GPU layer's texture memory with the label", async () => {
    start('/?render=gpu');
    await waitFor(() => expect(status.stats).not.toBeNull());
    expect(status.stats).toMatchObject({ f16: 3, f32: 1, budgetBytes: 384 * 1048576 });
    expect(statsText(status.stats!)).toBe('3.0/384 MB · 3 f16, 1 f32 · 2 evicted');
    expect(statsText({ ...status.stats!, evicted: 0, drawMs: 120 })).toBe('3.0/384 MB · 3 f16, 1 f32 · drawn in 120 ms');
  });

  it('falls back to tiles when the cube cannot be opened at /zarr/', async () => {
    rt.open.mockRejectedValueOnce(new Error('the server does not serve this cube at /zarr/'));
    const { map } = start('/?render=gpu');
    await waitFor(() => expect(status.reason).toBe('fell back to tiles: the server does not serve this cube at /zarr/'));
    expect(status.active).toBe(false);
    expect(map.addLayer).not.toHaveBeenCalled();
  });

  it('never starts in COG mode', async () => {
    const { map } = start('/?render=gpu', { mode: 'cog' });
    await act(async () => {});
    expect(status).toMatchObject({ active: false, reason: 'COG mode (not a zarr cube)' });
    expect(rt.open).not.toHaveBeenCalled();
    expect(map.addLayer).not.toHaveBeenCalled();
  });
});
