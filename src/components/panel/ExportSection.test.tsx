import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../types';
import ExportSection, { EXPORT_TIMEOUT_MS } from './ExportSection';

let state: AppState;
vi.mock('../../context/AppContext', () => ({ useAppContext: () => ({ state }) }));

// The section asks /config whether the server can write GeoTIFFs, then the
// button requests /export/geotiff. Answer each separately.
let config: Record<string, unknown>;
let exportResponse: Partial<Response>;

function exportCalls() {
  return vi.mocked(fetch).mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/export/geotiff'));
}

beforeEach(() => {
  state = {
    currentDataset: 'displacement', currentTimeIndex: 1,
    datasetInfo: { displacement: { uses_spatial_ref: true, algorithm: 'shift', x_values: ['2026-01-01', '2026-01-13'] } },
    layerMasks: [], customMaskPath: null, overlays: [],
    refEnabled: true, refMarkerPosition: [34, -118],
    refBufferEnabled: false, refBufferRadius: 50,
  } as unknown as AppState;
  config = { title: 'Bowser', geotiff_export: true };
  exportResponse = { ok: true, blob: async () => new Blob() };
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(
    url === '/config' ? { ok: true, json: async () => config } : exportResponse,
  )));
  vi.stubGlobal('alert', vi.fn());
  URL.createObjectURL = vi.fn().mockReturnValue('blob:test');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  window.history.replaceState({}, '', '/');
});

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function exportParams() {
  fireEvent.click(screen.getByText('Data layer (GeoTIFF)'));
  await waitFor(() => expect(exportCalls()).toHaveLength(1));
  await waitFor(() => expect(screen.queryByText('Exporting…')).toBeNull());
  return new URL(exportCalls()[0], window.location.origin).searchParams;
}

function geotiffButton() {
  return screen.getByRole('button', { name: /GeoTIFF/ }) as HTMLButtonElement;
}

describe('reference-aware GeoTIFF download', () => {
  it('sends the active point, date index, masks, and catalog selection', async () => {
    state.layerMasks = [{ id: 'mask-1', dataset: 'quality', threshold: 0.8, mode: 'min' }];
    state.customMaskPath = '/tmp/custom-mask.tif';
    window.history.replaceState({}, '', '/?dataset=cube-b');
    render(<ExportSection />);
    const p = await exportParams();
    expect(p.get('ref_lat')).toBe('34');
    expect(p.get('ref_lon')).toBe('-118');
    expect(p.has('ref_buffer_m')).toBe(false);
    expect(p.get('time_idx')).toBe('1');
    expect(p.get('dataset')).toBe('cube-b');
    expect(JSON.parse(p.get('layer_masks')!)).toEqual([{ dataset: 'quality', threshold: 0.8, mode: 'min' }]);
    expect(p.get('custom_mask_path')).toBe('/tmp/custom-mask.tif');
  });

  it('sends the radius only when area referencing is enabled', async () => {
    state.refBufferEnabled = true;
    render(<ExportSection />);
    expect((await exportParams()).get('ref_buffer_m')).toBe('50');
  });

  it('sends the reference date chosen in "ref: <date>", as the map tiles do', async () => {
    Object.assign(state, { dataMode: 'md', refTimeIndex: { displacement: 0 } });
    render(<ExportSection />);
    expect((await exportParams()).get('ref_time_idx')).toBe('0');
  });

  it.each([
    ['no date is chosen', { dataMode: 'md', refTimeIndex: {} }],
    ['in COG mode, whose tiles have no reference date', { dataMode: 'cog', refTimeIndex: { displacement: 0 } }],
  ])('sends no reference date when %s', async (_why, over) => {
    Object.assign(state, over);
    render(<ExportSection />);
    expect((await exportParams()).has('ref_time_idx')).toBe(false);
  });

  it.each(['disabled', 'quality'])('exports stored values for %s referencing', async (kind) => {
    if (kind === 'disabled') state.refEnabled = false;
    else state.datasetInfo.displacement.uses_spatial_ref = false;
    render(<ExportSection />);
    const p = await exportParams();
    expect(p.has('ref_lat')).toBe(false);
    expect(p.has('ref_lon')).toBe(false);
  });

  it('uses a newly selected reference after rerendering', async () => {
    const { rerender } = render(<ExportSection />);
    state = { ...state, refMarkerPosition: [35, -117], refBufferEnabled: true, refBufferRadius: 100 };
    rerender(<ExportSection />);
    const p = await exportParams();
    expect(p.get('ref_lat')).toBe('35');
    expect(p.get('ref_lon')).toBe('-117');
    expect(p.get('ref_buffer_m')).toBe('100');
  });

  it('explains an invalid reference instead of downloading stored values', async () => {
    exportResponse = { ok: false, status: 422, json: async () => ({ detail: 'Reference contains no valid source pixels' }) };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ExportSection />);
    await exportParams();
    expect(alert).toHaveBeenCalledWith('GeoTIFF export failed: Reference contains no valid source pixels');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});

describe('GeoTIFF export availability', () => {
  it('offers GeoTIFF export when the server can write GeoTIFFs', async () => {
    render(<ExportSection />);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/config'));
    expect(geotiffButton().disabled).toBe(false);
    expect(screen.queryByText(/cannot export GeoTIFFs/)).toBeNull();
  });

  it('turns GeoTIFF export off on bowser-lite, and says why', async () => {
    config = { title: 'Bowser', geotiff_export: false };
    render(<ExportSection />);
    await waitFor(() => expect(geotiffButton().disabled).toBe(true));
    expect(screen.getByText(/cannot export GeoTIFFs/)).toBeTruthy();
  });

  it('keeps export on when /config has no flag (an older server)', async () => {
    config = { title: 'Bowser' };
    render(<ExportSection />);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/config'));
    expect(geotiffButton().disabled).toBe(false);
  });
});

describe('GeoTIFF export progress', () => {
  // An export the server never finishes: the request hangs until it is aborted,
  // like a real fetch.
  function hangingExport() {
    let signal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementation(((url: string, init?: RequestInit) => {
      if (url === '/config') return Promise.resolve({ ok: true, json: async () => config } as Response);
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    }) as typeof fetch);
    return () => signal;
  }

  it('shows elapsed time and bytes received while the file downloads', async () => {
    const chunk = new Uint8Array(512 * 1024);
    let finish: (() => void) | undefined;
    const reads = [
      Promise.resolve({ done: false, value: chunk }),
      new Promise<{ done: true; value: undefined }>(r => { finish = () => r({ done: true, value: undefined }); }),
    ];
    exportResponse = {
      ok: true,
      headers: new Headers({ 'Content-Length': String(2 * 1024 * 1024) }),
      body: { getReader: () => ({ read: () => reads.shift()!, cancel: async () => undefined }) } as unknown as ReadableStream<Uint8Array>,
    };
    render(<ExportSection />);
    fireEvent.click(screen.getByText('Data layer (GeoTIFF)'));
    expect(await screen.findByText('Exporting… 0 s · 512 KB of 2.0 MB (25%)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    finish!();
    await waitFor(() => expect(screen.queryByText(/Exporting… \d+ s/)).toBeNull());
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('Cancel stops the export and frees the button, without an error', async () => {
    const signal = hangingExport();
    render(<ExportSection />);
    fireEvent.click(screen.getByText('Data layer (GeoTIFF)'));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(geotiffButton().disabled).toBe(false));
    expect(signal()?.aborted).toBe(true);
    expect(screen.getByText('Data layer (GeoTIFF)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(alert).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('gives up after the timeout and says why', async () => {
    vi.useFakeTimers();
    const signal = hangingExport();
    render(<ExportSection />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByText('Data layer (GeoTIFF)'));
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(screen.getByText('Exporting… 4 s')).toBeTruthy();
    expect(signal()?.aborted).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(EXPORT_TIMEOUT_MS); });
    expect(signal()?.aborted).toBe(true);
    expect(screen.getByText(/didn't answer within 2 minutes/)).toBeTruthy();
    expect(geotiffButton().disabled).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });
});
