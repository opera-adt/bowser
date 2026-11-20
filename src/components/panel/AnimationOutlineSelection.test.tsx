/** Overlay visibility must reach an open export panel through real subscriptions. */
import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../../context/AppContext';
import type { AppAction, RasterGroup } from '../../types';
import { setViewBounds } from '../../map/viewBounds';
import AnimationExport from './AnimationExport';

const layer: RasterGroup = {
  name: 'displacement', unit: 'meters', file_list: [], mask_file_list: [], mask_min_value: 0.1,
  nodata: null, uses_spatial_ref: false, algorithm: null,
  x_values: ['2026-01-01', '2026-01-13', '2026-01-25'], latlon_bounds: [0, 0, 5, 5], available_mask_vars: [],
};
let dispatch: (action: AppAction) => void;
function Controls() {
  const context = useAppContext();
  dispatch = context.dispatch;
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

it('observes adding and hiding vector layers without remounting', async () => {
  render(<AppProvider><Controls /><AnimationExport /></AppProvider>);
  const button = () => screen.getByRole('button', { name: 'Download raster GIF' });
  await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByLabelText('Include vector outlines in GIF'));
  expect((button() as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Outlines need 1–5 visible vector layers/)).toBeTruthy();
  expect(screen.queryByText(/Choose 2–90 saved epochs/)).toBeNull();
  act(() => dispatch({ type: 'ADD_OVERLAY', payload: {
    id: 'region', name: 'Region', type: 'vector', visible: true, opacity: 1,
    data: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {},
      geometry: { type: 'Point', coordinates: [3.5, 0.5] } }] },
  } }));
  await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
  act(() => dispatch({ type: 'UPDATE_OVERLAY', payload: { id: 'region', updates: { visible: false } } }));
  await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(true));
});
