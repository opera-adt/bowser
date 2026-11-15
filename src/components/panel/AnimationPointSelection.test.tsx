/** Point visibility changes must reach an already-open export panel. */
import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../../context/AppContext';
import type { AppAction, AppState, RasterGroup } from '../../types';
import { setViewBounds } from '../../map/viewBounds';
import AnimationExport from './AnimationExport';

const layer: RasterGroup = {
  name: 'displacement', unit: 'meters', file_list: [], mask_file_list: [], mask_min_value: 0.1,
  nodata: null, uses_spatial_ref: false, algorithm: null,
  x_values: ['2026-01-01', '2026-01-13', '2026-01-25'], latlon_bounds: [0, 0, 5, 5], available_mask_vars: [],
};
let dispatch: (action: AppAction) => void;
let current: AppState;
function Controls() {
  const context = useAppContext();
  dispatch = context.dispatch; current = context.state;
  useEffect(() => {
    dispatch({ type: 'SET_DATASETS', payload: { displacement: layer } });
    dispatch({ type: 'SET_CURRENT_DATASET', payload: 'displacement' });
    dispatch({ type: 'SET_DATA_MODE', payload: 'md' });
  }, []);
  return null;
}
beforeEach(() => {
  setViewBounds([0, 3, 1, 4]);
  vi.stubGlobal('fetch', vi.fn(async (url) => String(url).includes('/animation/plan')
    ? new Response(JSON.stringify({ output_width: 512, output_height: 800 }))
    : new Response(JSON.stringify({ raster_animation: true }))));
});
afterEach(() => { cleanup(); setViewBounds(null); vi.unstubAllGlobals(); });

it('observes adding and hiding a point without remounting or unrelated state changes', async () => {
  render(<AppProvider><Controls /><AnimationExport /></AppProvider>);
  const button = () => screen.getByRole('button', { name: 'Download raster GIF' });
  await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByLabelText('Include point histories in GIF'));
  expect((button() as HTMLButtonElement).disabled).toBe(true);
  act(() => dispatch({ type: 'ADD_TIME_SERIES_POINT', payload: { position: [0.5, 3.5] } }));
  await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
  const point = current.timeSeriesPoints[0];
  expect(point.visible).toBe(true);
  act(() => dispatch({ type: 'UPDATE_TIME_SERIES_POINT', payload: { id: point.id, updates: { visible: false } } }));
  await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(true));
});
