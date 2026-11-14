import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../types';
import AnimationExport from './AnimationExport';
import { saveFile } from '../../utils/saveFile';

let state: AppState;
vi.mock('../../context/AppContext', () => ({ useAppContext: () => ({ state }) }));
vi.mock('../../utils/saveFile', () => ({ saveFile: vi.fn(async () => true) }));
let supported: boolean;
let reply: Response;
beforeEach(() => {
  supported = true;
  state = { currentDataset: 'displacement', datasetInfo: { displacement: {
    x_values: ['2026-01-01', '2026-01-13', '2026-01-25'], uses_spatial_ref: true, algorithm: 'shift',
  } }, refEnabled: true, refMarkerPosition: [0.001, 3.001], refBufferEnabled: true, refBufferRadius: 20,
  refTimeIndex: { displacement: 0 }, dataMode: 'md', viewBounds: [0, 3, 1, 4],
  vmin: -1, vmax: 2, colormap: 'viridis', layerMasks: [{ id: 'q', dataset: 'quality', threshold: 0.8, mode: 'min' }],
  customMaskPath: null, wrapEnabled: false } as unknown as AppState;
  reply = new Response(new Blob(['GIF89a']), { status: 200, headers: { 'Content-Type': 'image/gif',
    'Content-Disposition': 'attachment; filename="displacement_20260101_20260125.gif"' } });
  vi.stubGlobal('fetch', vi.fn(async (url, init) => String(url).includes('/animation/plan')
    ? new Response(JSON.stringify({output_width:512,output_height:560}))
    : init?.method === 'POST' ? reply : new Response(JSON.stringify({ raster_animation: supported }))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); window.history.replaceState({}, '', '/'); });
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
  it.each(['uploaded', 'configured'])('rejects unsupported %s masks without sending an export', async (kind) => {
    if (kind === 'uploaded') state.customMaskPath = 'mask.tif';
    else { state.dataMode = 'cog'; state.datasetInfo!.displacement.mask_file_list = ['mask.tif']; }
    render(<AnimationExport />);
    await waitFor(() => expect(screen.getByText(/Uploaded\/configured GeoTIFF masks/)).toBeTruthy());
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
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
