/** A layer opens on its 2–98 % colour range, not 0–1, unless a range is kept for it. */
import { useEffect } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import type { AppState, RasterGroup } from '../types';

vi.mock('react-chartjs-2', () => ({ Bar: () => null }));

import Histogram from './Histogram';

const HIST = {
  bins: [-0.05, 0, 0.05, 0.1], counts: [1, 5, 2], min: -0.043487, max: 0.060882,
  p2: -0.017913818, p98: 0.033294677, p16: -0.0055, p84: 0.0195, p23: -0.0172, p977: 0.0326,
};
const layer = (name: string, algorithm: string | null = null) => ({
  name, unit: 'meters', file_list: [], mask_file_list: [], mask_min_value: 0, nodata: null,
  uses_spatial_ref: false, algorithm, x_values: ['2020-01-01', '2020-02-01'], latlon_bounds: [-1, -1, 1, 1], available_mask_vars: [],
}) as unknown as RasterGroup;

let stateRef: AppState;
function Seed({ name, algorithm = null }: { name: string; algorithm?: string | null }) {
  const { state, dispatch } = useAppContext();
  stateRef = state;
  useEffect(() => {
    dispatch({ type: 'SET_DATASETS', payload: { [name]: layer(name, algorithm) } });
    dispatch({ type: 'SET_CURRENT_DATASET', payload: name });
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  return state.currentDataset ? <Histogram /> : null;
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(HIST))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('the default colour range', () => {
  it('is the layer\'s 2–98 % once its histogram arrives', async () => {
    render(<AppProvider><Seed name="displacement" /></AppProvider>);
    expect([stateRef.vmin, stateRef.vmax]).toEqual([0, 1]);
    await waitFor(() => expect([stateRef.vmin, stateRef.vmax]).toEqual([-0.0179, 0.0333]));
    // the same range the "2–98%" button sets
    fireEvent.click(screen.getByText('Full'));
    fireEvent.click(screen.getByText('2–98%'));
    expect([stateRef.vmin, stateRef.vmax]).toEqual([-0.0179, 0.0333]);
  });

  it('leaves a range kept for the layer (chosen earlier, or from a project)', async () => {
    localStorage.setItem('velocity2-vmin', '-0.01');
    localStorage.setItem('velocity2-vmax', '0.01');
    render(<AppProvider><Seed name="velocity2" /></AppProvider>);
    await screen.findByText('2–98%');
    expect([stateRef.vmin, stateRef.vmax]).toEqual([0, 1]);  // MainTab, not mounted here, restores the kept range
  });

  it('leaves phase layers on their own range', async () => {
    render(<AppProvider><Seed name="phase1" algorithm="phase" /></AppProvider>);
    await screen.findByText('2–98%');
    expect([stateRef.vmin, stateRef.vmax]).toEqual([0, 1]);
  });
});
