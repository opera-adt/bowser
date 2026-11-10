import { useEffect } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../../context/AppContext';
import type { RasterGroup } from '../../types';
import MainTab from './MainTab';

vi.mock('../Histogram', () => ({ default: () => null }));
afterEach(cleanup);

function Seed() {
  const { dispatch } = useAppContext();
  useEffect(() => {
    const layer = (name: string, description: string, unit: string): RasterGroup => ({
      name, description, unit, description_source: 'bowser',
      file_list: [], mask_file_list: [], mask_min_value: 0, nodata: null,
      uses_spatial_ref: false, algorithm: null, x_values: [0],
      latlon_bounds: [0, 0, 1, 1], available_mask_vars: [],
    });
    dispatch({ type: 'SET_DATASETS', payload: {
      quality: layer('quality', 'Quality guidance.', 'unitless'),
      velocity: layer('velocity', 'Rate guidance.', 'm/year'),
    } });
    dispatch({ type: 'SET_CURRENT_DATASET', payload: 'quality' });
    dispatch({ type: 'SET_SPLIT_DATASET', payload: 'velocity' });
    dispatch({ type: 'TOGGLE_SPLIT_SCREEN' });
  }, [dispatch]);
  return <MainTab />;
}

describe('MainTab layer information', () => {
  it('shows information for the main and right-hand layers', () => {
    render(<AppProvider><Seed /></AppProvider>);
    expect(screen.getAllByRole('note', { name: 'Layer information' })).toHaveLength(2);
    expect(screen.getByText('Quality guidance.')).toBeTruthy();
    expect(screen.getByText('Rate guidance.')).toBeTruthy();
    expect(screen.getByText('Source units: unitless')).toBeTruthy();
    expect(screen.getByText('Source units: m/year')).toBeTruthy();
  });

  it('changes the main explanation when the user chooses another layer', () => {
    render(<AppProvider><Seed /></AppProvider>);
    fireEvent.change(screen.getByRole('combobox', { name: 'Layer' }), { target: { value: 'velocity' } });
    expect(screen.queryByText('Quality guidance.')).toBeNull();
    expect(screen.getAllByText('Rate guidance.')).toHaveLength(2);
  });
});
