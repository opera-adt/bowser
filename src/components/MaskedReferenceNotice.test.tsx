import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppAction, AppState } from '../types';

let state: AppState;
const dispatch = vi.fn<(a: AppAction) => void>();
vi.mock('../context/AppContext', async () =>
  (await import('../test/appContextMock')).appContextMock(() => ({ state, dispatch })));

import MaskedReferenceNotice from './MaskedReferenceNotice';

const DATES = ['2026-01-01', '2026-01-13'];
let referenceDates: number;            // dates left at the reference point under the masks
let asked: { url: string; body?: any }[];

beforeEach(() => {
  referenceDates = 0;
  asked = [];
  dispatch.mockReset();
  state = {
    currentDataset: 'displacement', refEnabled: true, refBufferEnabled: false, refBufferRadius: 0,
    refMarkerPosition: [34.755, -90.114],
    layerMasks: [{ id: 'm', dataset: 'recommended_mask', threshold: 0.5, mode: 'min' }],
    datasetInfo: { displacement: { uses_spatial_ref: true, x_values: DATES }, recommended_mask: { x_values: DATES } },
  } as unknown as AppState;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    asked.push({ url: String(url), body });
    if (String(url).startsWith('/multi_point')) {
      return new Response(JSON.stringify({ labels: DATES, datasets: [{ label: 'reference', data: DATES.slice(0, referenceDates).map(x => ({ x, y: 0 })) }] }));
    }
    if (String(url).startsWith('/reference_candidates')) {
      return new Response(JSON.stringify({ candidates: [{ rank: 1, lon: -90.12, lat: 34.77, radius_m: 100 }] }));
    }
    return new Response('{}');
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('an empty chart while masks are on', () => {
  it('says the reference point is masked when it is, and moves it to a stable place', async () => {
    render(<MaskedReferenceNotice datasets={['displacement']} />);
    expect(await screen.findByText(/The reference point is masked on every date/)).toBeTruthy();
    // It asked for the reference's own series, under the masks and referenced to nothing.
    const probe = asked.find(a => a.url.startsWith('/multi_point'))!.body;
    expect(probe.points).toEqual([expect.objectContaining({ lat: 34.755, lon: -90.114 })]);
    expect(probe.ref_lat).toBeUndefined();
    expect(probe.layer_masks).toEqual([{ dataset: 'recommended_mask', threshold: 0.5, mode: 'min' }]);

    fireEvent.click(screen.getByRole('button', { name: 'Move the reference point' }));
    await waitFor(() => expect(dispatch.mock.calls.map(([a]) => a.type)).toContain('SET_REF_MARKER_POSITION'));
    const moved = dispatch.mock.calls.map(([a]) => a).find(a => a.type === 'SET_REF_MARKER_POSITION') as { payload: [number, number] };
    expect(moved.payload).toEqual([34.77, -90.12]);
    expect(asked.some(a => a.url.startsWith('/reference_candidates'))).toBe(true);
  });

  it('blames the masks at the points when the reference point has data', async () => {
    referenceDates = 2;
    render(<MaskedReferenceNotice datasets={['displacement']} />);
    await waitFor(() => expect(asked.some(a => a.url.startsWith('/multi_point'))).toBe(true));
    expect(screen.getByText('Masking hides every date at the selected points.')).toBeTruthy();
    expect(screen.queryByText(/reference point is masked/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove the masks' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'REMOVE_LAYER_MASK', payload: 'm' });
  });

  it('does not ask when the series are not referenced', async () => {
    state = { ...state, refEnabled: false };
    render(<MaskedReferenceNotice datasets={['displacement']} />);
    expect(screen.getByText('Masking hides every date at the selected points.')).toBeTruthy();
    expect(asked).toEqual([]);
  });
});
