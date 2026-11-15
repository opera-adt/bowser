/**
 * Rewrap sets its own colour map (cyclic) and colour range (±π, or half the period). Turning
 * it off brings back what was there before, unless the user changed it in the meantime.
 */
import { useEffect } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../../context/AppContext';
import type { AppAction, AppState, RasterGroup } from '../../types';
import MainTab from './MainTab';

vi.mock('../Histogram', () => ({ default: () => null }));

let state: AppState;
let dispatch: (a: AppAction) => void;
function Seed() {
  ({ state, dispatch } = useAppContext());
  useEffect(() => {
    const layer = {
      name: 'displacement', description: '', unit: 'meters', file_list: [], mask_file_list: [], mask_min_value: 0,
      nodata: null, uses_spatial_ref: false, algorithm: null, x_values: ['2026-01-01', '2026-01-13'],
      latlon_bounds: [0, 0, 1, 1], available_mask_vars: [],
    } as unknown as RasterGroup;
    dispatch({ type: 'SET_DATASETS', payload: { displacement: layer } });
    dispatch({ type: 'SET_CURRENT_DATASET', payload: 'displacement' });
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  return <MainTab />;
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const set = (...actions: AppAction[]) => act(() => actions.forEach(a => dispatch(a)));

describe('turning Rewrap off', () => {
  it('brings back the colour range and colour map from before', () => {
    render(<AppProvider><Seed /></AppProvider>);
    set({ type: 'SET_COLORMAP', payload: 'rdbu_r' }, { type: 'SET_VMIN', payload: -0.02 }, { type: 'SET_VMAX', payload: 0.03 });

    set({ type: 'TOGGLE_WRAP' });
    expect(state.wrapEnabled).toBe(true);
    expect(state.vmax).toBeGreaterThan(0.03);          // the wrap's own range
    expect(state.vmin).toBe(-state.vmax);
    expect(state.colormap).not.toBe('rdbu_r');

    set({ type: 'TOGGLE_WRAP' });
    expect([state.vmin, state.vmax]).toEqual([-0.02, 0.03]);
    expect(state.colormap).toBe('rdbu_r');
  });

  it('keeps a range chosen while it was on', () => {
    render(<AppProvider><Seed /></AppProvider>);
    set({ type: 'SET_VMIN', payload: -0.02 }, { type: 'SET_VMAX', payload: 0.03 });
    set({ type: 'TOGGLE_WRAP' });
    set({ type: 'SET_VMIN', payload: -1 }, { type: 'SET_VMAX', payload: 1 });
    set({ type: 'TOGGLE_WRAP' });
    expect([state.vmin, state.vmax]).toEqual([-1, 1]);
  });
});
