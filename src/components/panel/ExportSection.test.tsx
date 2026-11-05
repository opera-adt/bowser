import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../types';
import ExportSection from './ExportSection';

let state: AppState;
vi.mock('../../context/AppContext', () => ({ useAppContext: () => ({ state }) }));

beforeEach(() => {
  state = {
    currentDataset: 'displacement', currentTimeIndex: 1,
    datasetInfo: { displacement: { uses_spatial_ref: true, algorithm: 'shift', x_values: ['2026-01-01', '2026-01-13'] } },
    layerMasks: [], customMaskPath: null, overlays: [],
    refEnabled: true, refMarkerPosition: [34, -118],
    refBufferEnabled: false, refBufferRadius: 50,
  } as unknown as AppState;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob() }));
  vi.stubGlobal('alert', vi.fn());
  URL.createObjectURL = vi.fn().mockReturnValue('blob:test');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  window.history.replaceState({}, '', '/');
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function exportParams() {
  fireEvent.click(screen.getByText('Data layer (GeoTIFF)'));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByText('Exporting…')).toBeNull());
  return new URL(String(vi.mocked(fetch).mock.calls[0][0]), window.location.origin).searchParams;
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
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 422, json: async () => ({ detail: 'Reference contains no valid source pixels' }) } as Response);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ExportSection />);
    await exportParams();
    expect(alert).toHaveBeenCalledWith('GeoTIFF export failed: Reference contains no valid source pixels');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
