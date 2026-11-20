import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setViewBounds } from '../../map/viewBounds';
import type { AppState } from '../../types';
import AnimationExport from './AnimationExport';
import { saveFile } from '../../utils/saveFile';
import { registerAnimationContext } from '../../map/animationContext';

let state: AppState;
vi.mock('../../context/AppContext', async () =>
  (await import('../../test/appContextMock')).appContextMock(() => ({ state })));
vi.mock('../../utils/saveFile', () => ({ saveFile: vi.fn(async () => true) }));
let supported: boolean;
let reply: Response;
beforeEach(() => {
  setViewBounds([0, 3, 1, 4]);
  supported = true;
  state = { currentDataset: 'displacement', datasetInfo: { displacement: {
    x_values: ['2026-01-01', '2026-01-13', '2026-01-25'], uses_spatial_ref: true, algorithm: 'shift',
  } }, refEnabled: true, refMarkerPosition: [0.001, 3.001], refBufferEnabled: true, refBufferRadius: 20,
  refTimeIndex: { displacement: 0 }, dataMode: 'md',
  vmin: -1, vmax: 2, colormap: 'viridis', layerMasks: [{ id: 'q', dataset: 'quality', threshold: 0.8, mode: 'min' }],
  customMaskPath: null, wrapEnabled: false } as unknown as AppState;
  reply = new Response(new Blob(['GIF89a']), { status: 200, headers: { 'Content-Type': 'image/gif',
    'Content-Disposition': 'attachment; filename="displacement_20260101_20260125.gif"' } });
  vi.stubGlobal('fetch', vi.fn(async (url, init) => String(url).includes('/animation/plan')
    ? new Response(JSON.stringify({output_width:512,output_height:560}))
    : init?.method === 'POST' ? reply : new Response(JSON.stringify({ raster_animation: supported }))));
});
afterEach(() => { cleanup(); setViewBounds(null); vi.unstubAllGlobals(); vi.clearAllMocks(); window.history.replaceState({}, '', '/'); });
const button = () => screen.getByRole('button', { name: 'Download raster GIF' });

describe('raster GIF export controls', () => {
  it('sends fixed view limits, catalog, chosen epochs, masks and raw-reference options without moving the slider', async () => {
    window.history.replaceState({}, '', '/?dataset=example');
    const before = JSON.stringify(state);
    render(<AnimationExport />);
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('GIF first epoch'), { target: { value: '1' } });
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button());
    await waitFor(() => expect(saveFile).toHaveBeenCalled());
    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => init?.method === 'POST' && !String(url).includes('/plan'))!;
    expect(call[0]).toBe('/export/animation?dataset=example');
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({ variable: 'displacement', start_index: 1,
      end_index: 2, vmin: -1, vmax: 2, colormap: 'viridis', fps: 2, bounds: [3, 0, 4, 1],
      ref_lon: 3.001, ref_lat: 0.001, ref_buffer_m: 20, ref_time_idx: 0,
      layer_masks: [{ dataset: 'quality', mode: 'min', threshold: 0.8 }] });
    expect(vi.mocked(saveFile).mock.calls[0][1]).toBe('displacement_20260101_20260125.gif');
    expect(JSON.stringify(state)).toBe(before);
  });
  it('sends visible point locations only when the optional plot is selected', async () => {
    state.timeSeriesPoints = [{ id: 'point', name: 'Synthetic', position: [1, 3], color: '#2468aa', visible: true },
      { id: 'hidden', name: 'Hidden', position: [1, 3], color: '#2468aa', visible: false }];
    render(<AnimationExport />);
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByLabelText('Include point histories in GIF'));
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button());
    await waitFor(() => expect(saveFile).toHaveBeenCalled());
    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => init?.method === 'POST' && !String(url).includes('/plan'))!;
    expect(JSON.parse(String(call[1]?.body)).points).toEqual([{ id: 'point', name: 'Synthetic', lat: 1, lon: 3, color: '#2468aa' }]);
  });
  it('requires one to five visible points instead of silently truncating them', async () => {
    state.timeSeriesPoints = [];
    render(<AnimationExport />);
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByLabelText('Include point histories in GIF'));
    expect((button() as HTMLButtonElement).disabled).toBe(true);
  });
  it('exports only visible vector geometry, excluding feature properties and hidden layers', async () => {
    const geometry = { type: 'Point', coordinates: [3, 1] } as const;
    state.overlays = [{ id: 'visible', name: 'Example area', type: 'vector', visible: true, opacity: 1,
      data: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry, properties: { note: 'not exported' } }] } },
    { id: 'hidden', name: 'Hidden', type: 'vector', visible: false, opacity: 1,
      data: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry }] } }];
    render(<AnimationExport />);
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByLabelText('Include vector outlines in GIF'));
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button());
    await waitFor(() => expect(saveFile).toHaveBeenCalled());
    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => init?.method === 'POST' && !String(url).includes('/plan'))!;
    const body = JSON.parse(String(call[1]?.body));
    expect(body.outlines).toEqual([{ name: 'Example area', geometries: [geometry] }]);
    expect(String(call[1]?.body)).not.toContain('not exported');
  });
  it('retains validated outlines when a background snapshot is included', async () => {
    state.opacity = 0.6;
    state.overlays = [{ id: 'area', name: 'Area', type: 'vector', visible: true, opacity: 1,
      data: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {},
        geometry: { type: 'Point', coordinates: [3, 1] } }] } }];
    const release = registerAnimationContext(async () => ({ png: 'data:image/png;base64,fixture',
      bounds: [0, 0, 100, 100], attribution: 'Synthetic background' }));
    try {
      render(<AnimationExport />);
      await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByLabelText('Include vector outlines in GIF'));
      fireEvent.click(screen.getByLabelText('Include background and its opacity'));
      await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(button());
      await waitFor(() => expect(saveFile).toHaveBeenCalled());
      const call = vi.mocked(fetch).mock.calls.find(([url, init]) => init?.method === 'POST' && !String(url).includes('/plan'))!;
      expect(JSON.parse(String(call[1]?.body))).toMatchObject({ raster_opacity: 0.6,
        background: { attribution: 'Synthetic background' },
        outlines: [{ name: 'Area', geometries: [{ type: 'Point', coordinates: [3, 1] }] }] });
    } finally { release(); }
  });
  it('keeps lightweight export explicitly unsupported', async () => {
    supported = false;
    render(<AnimationExport />);
    await act(async () => {});
    expect(screen.queryByText(/needs the full server/)).toBeNull();
    expect(vi.mocked(fetch).mock.calls.every(([url]) => url === '/config')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Download raster GIF' })).toBeNull();
  });
  it('does not pretend rewrapped or complex data are scalar native exports', async () => {
    state.wrapEnabled = true;
    render(<AnimationExport />);
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText(/Rewrap off/)).toBeTruthy();
  });
  it.each(['uploaded', 'configured'])('forwards %s masks through preflight and export', async (kind) => {
    if (kind === 'uploaded') state.customMaskPath = 'mask.tif';
    else { state.dataMode = 'cog'; state.datasetInfo!.displacement.mask_file_list = ['mask.tif']; state.datasetInfo!.displacement.mask_min_value = 0; }
    render(<AnimationExport />);
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button());
    await waitFor(() => expect(saveFile).toHaveBeenCalled());
    const posts = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts.length).toBeGreaterThanOrEqual(2);
    for (const [, init] of posts) {
      const body = JSON.parse(String(init!.body));
      if (kind === 'uploaded') expect(body.custom_mask_path).toBe('mask.tif');
      else expect(body.mask_min_value).toBe(0);
    }
  });
  it('requires increasing finite color limits', async () => {
    state.vmax = state.vmin;
    render(<AnimationExport />);
    await act(async () => {});
    expect((button() as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows failed validation and never saves a failed response', async () => {
    reply = new Response(JSON.stringify({ detail: 'Source exceeds pixel budget' }), { status: 422 });
    render(<AnimationExport />);
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button());
    expect((await screen.findByRole('alert')).textContent).toContain('Source exceeds pixel budget');
    expect(saveFile).not.toHaveBeenCalled();
  });
});


it('keeps rendering disabled when the metadata preflight exceeds a budget', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url) => String(url).includes('/plan')
    ? new Response(JSON.stringify({detail:'Selected read window exceeds pixel budget'}), {status:422})
    : new Response(JSON.stringify({raster_animation:true}))));
  render(<AnimationExport />);
  expect((await screen.findByRole('alert')).textContent).toContain('pixel budget');
  expect((button() as HTMLButtonElement).disabled).toBe(true);
  expect(saveFile).not.toHaveBeenCalled();
});

it('shows elapsed rendering time and Cancel aborts the download', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (String(url).includes('/plan')) return new Response(JSON.stringify({output_width:512,output_height:560}));
    if (init?.method !== 'POST') return new Response(JSON.stringify({raster_animation:true}));
    return new Promise<Response>((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))));
  }));
  render(<AnimationExport />);
  await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button());
  expect(screen.getByText('Rendering… 0 s')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
  expect((await screen.findByRole('alert')).textContent).toContain('canceled');
  expect(saveFile).not.toHaveBeenCalled();
});

describe('vector outline limits', () => {
  const point = (lon: number) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: [lon, 1] } });
  const vector = (id: string, features: GeoJSON.Feature[]) => ({ id, name: id, type: 'vector' as const, visible: true, opacity: 1,
    data: { type: 'FeatureCollection' as const, features } });
  const posts = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST');
  const tick = () => fireEvent.click(screen.getByLabelText('Include vector outlines in GIF'));

  it('shows the reason from a validation list returned by the plan', async () => {
    state.overlays = [vector('Wells', [point(3)])];
    vi.stubGlobal('fetch', vi.fn(async (url) => String(url).includes('/plan')
      ? new Response(JSON.stringify({ detail: [{ loc: ['body', 'outlines', 0], msg: 'Value error, Invalid outline geometry', type: 'value_error' }] }), { status: 422 })
      : new Response(JSON.stringify({ raster_animation: true }))));
    render(<AnimationExport />);
    await waitFor(() => expect(screen.getByLabelText('Include vector outlines in GIF')).toBeTruthy());
    tick();
    expect((await screen.findByRole('alert')).textContent).toBe('Invalid outline geometry');
  });
  it('shows the reason from a validation list returned by the export', async () => {
    reply = new Response(JSON.stringify({ detail: [{ loc: ['body'], msg: 'Value error, Outlines exceed the 5000-vertex total budget', type: 'value_error' }] }), { status: 422 });
    render(<AnimationExport />);
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button());
    expect((await screen.findByRole('alert')).textContent).toBe('Outlines exceed the 5000-vertex total budget');
  });
  it('names a layer with more than 100 features and sends nothing', async () => {
    state.overlays = [vector('Small', [point(3)]), vector('Buildings', Array.from({ length: 120 }, (_, i) => point(3 + i / 1000)))];
    render(<AnimationExport />);
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
    const before = posts().length;
    tick();
    expect((await screen.findByRole('alert')).textContent).toBe('“Buildings” has 120 features; outlines take at most 100 per layer.');
    await act(async () => { await new Promise(r => setTimeout(r, 400)); });
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    expect(posts().length).toBe(before);
  });
  it('names the layers when their vertices together exceed 5,000', async () => {
    const line = (n: number): GeoJSON.Feature => ({ type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: Array.from({ length: n }, (_, i) => [3 + i / 1e5, 1]) } });
    state.overlays = [vector('Roads', [line(3000)]), vector('Rivers', [line(2500)])];
    render(<AnimationExport />);
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
    const before = posts().length;
    tick();
    expect((await screen.findByRole('alert')).textContent)
      .toBe('Outlines have 5,500 vertices (“Roads” 3,000, “Rivers” 2,500); at most 5,000 in total.');
    await act(async () => { await new Promise(r => setTimeout(r, 400)); });
    expect(posts().length).toBe(before);
  });
  it('serializes the outlines once, not again when another setting changes', async () => {
    state.overlays = [vector('Wells', [point(3)])];
    render(<AnimationExport />);
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
    tick();
    await waitFor(() => expect(posts().some(([, init]) => String(init?.body).includes('"outlines"'))).toBe(true));
    const stringify = vi.spyOn(JSON, 'stringify');
    fireEvent.change(screen.getByLabelText('GIF frames per second'), { target: { value: '3' } });
    await waitFor(() => expect(posts().some(([, init]) => String(init?.body).includes('"fps":3,'))).toBe(true));
    const sent = posts().find(([, init]) => String(init?.body).includes('"fps":3,'))!;
    expect(JSON.parse(String(sent[1]?.body)).outlines).toEqual([{ name: 'Wells', geometries: [{ type: 'Point', coordinates: [3, 1] }] }]);
    const withOutlines = (v: unknown) => Array.isArray(v) ? v.some(x => x && typeof x === 'object' && 'geometries' in x)
      : !!v && typeof v === 'object' && 'outlines' in v;
    expect(stringify.mock.calls.some(([v]) => withOutlines(v))).toBe(false);
    stringify.mockRestore();
  });
  it('names server-tiled vector layers as not included', async () => {
    state.overlays = [{ id: 'big', name: 'Buildings (large)', type: 'pmtiles', pmtilesKind: 'vector', visible: true, opacity: 1 }];
    render(<AnimationExport />);
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
    tick();
    expect(screen.getByText('Not included in outlines, drawn from server tiles: “Buildings (large)”.')).toBeTruthy();
    expect(screen.getByText(/add or show a smaller vector layer/)).toBeTruthy();
    expect((button() as HTMLButtonElement).disabled).toBe(true);
  });
  it('exports the small layer and still names the server-tiled one beside it', async () => {
    state.overlays = [vector('Wells', [point(3)]),
      { id: 'big', name: 'Buildings (large)', type: 'pmtiles', pmtilesKind: 'vector', visible: true, opacity: 1 }];
    render(<AnimationExport />);
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
    tick();
    expect(screen.getByText('Not included in outlines, drawn from server tiles: “Buildings (large)”.')).toBeTruthy();
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
    const sent = posts().filter(([, init]) => String(init?.body).includes('"outlines"')).pop()!;
    expect(JSON.parse(String(sent[1]?.body)).outlines.map((o: { name: string }) => o.name)).toEqual(['Wells']);
  });
  it('states the per-layer feature limit in the help line', async () => {
    render(<AnimationExport />);
    await waitFor(() => expect(screen.getByLabelText('Include vector outlines in GIF')).toBeTruthy());
    tick();
    expect(screen.getByText(/at most 100 features per layer and 5,000 vertices in total/)).toBeTruthy();
  });
});
