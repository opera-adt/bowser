import { useEffect } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../../context/AppContext';
import type { RasterGroup } from '../../types';
const layer = (name: string, reference: boolean): RasterGroup => ({ name,
  uses_spatial_ref: reference, algorithm: null, file_list: [], mask_file_list: [],
  mask_min_value: 0.5, nodata: null, x_values: [], latlon_bounds: [0, 0, 1, 1],
  available_mask_vars: [],
});
import MainTab from './MainTab';

vi.mock('../Histogram', () => ({ default: () => null }));
function Seed() {
  const { state, dispatch } = useAppContext();
  useEffect(() => {
    dispatch({ type: 'SET_DATASETS', payload: { factor: layer('factor', false) } });
    dispatch({ type: 'SET_CURRENT_DATASET', payload: 'factor' });
    dispatch({ type: 'ADD_LAYER_MASK', payload: { id: 'm', dataset: 'factor', mode: 'min', threshold: 0 } });
  }, [dispatch]);
  return <><MainTab /><output data-testid="state">{JSON.stringify(state.layerMasks)}</output></>;
}
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ min: -10, max: 5, p2: -8, p98: 3 }), { status: 200 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('absolute mask UI', () => {
  it('selects an absolute comparison, sets a nonnegative limit, and allows signed controls again', async () => {
    const { container } = render(<AppProvider><Seed /></AppProvider>);
    fireEvent.click(screen.getByText('Masking · 1 on'));
    const comparison = screen.getByLabelText('Mask comparison');
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    fireEvent.change(comparison, { target: { value: 'abs_max' } });
    const threshold = container.querySelector('.layer-mask-row input[type=number]')!;
    expect(threshold.getAttribute('min')).toBe('0');
    fireEvent.change(threshold, { target: { value: '5' } });
    expect(JSON.parse(screen.getByTestId('state').textContent!)[0]).toMatchObject({ mode: 'abs_max', threshold: 5 });
    fireEvent.change(threshold, { target: { value: '-2' } });
    expect(JSON.parse(screen.getByTestId('state').textContent!)[0].threshold).toBe(5);
    fireEvent.change(comparison, { target: { value: 'abs_min' } });
    expect(JSON.parse(screen.getByTestId('state').textContent!)[0].mode).toBe('abs_min');
    fireEvent.change(comparison, { target: { value: 'max' } });
    expect(threshold.getAttribute('min')).toBeNull();
    fireEvent.change(threshold, { target: { value: '-2' } });
    expect(JSON.parse(screen.getByTestId('state').textContent!)[0]).toMatchObject({ mode: 'max', threshold: -2 });
  });
});
