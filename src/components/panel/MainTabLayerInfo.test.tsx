import { useEffect } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../../context/AppContext';
import type { RasterGroup } from '../../types';
import MainTab from './MainTab';
import { LAYER_INFO_KEY } from '../../utils/layerInfoPref';

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

  it('the (i) button hides and shows both notes and remembers the choice', () => {
    const { unmount } = render(<AppProvider><Seed /></AppProvider>);
    const button = screen.getByRole('button', { name: 'Layer description' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('title')).toBe('Hide layer description');
    fireEvent.click(button);
    expect(screen.queryAllByRole('note', { name: 'Layer information' })).toHaveLength(0);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('title')).toBe('Show layer description');
    expect(localStorage.getItem(LAYER_INFO_KEY)).toBe('hidden');
    unmount();

    // A later visit starts hidden; showing again clears the saved choice.
    render(<AppProvider><Seed /></AppProvider>);
    expect(screen.queryAllByRole('note', { name: 'Layer information' })).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Layer description' }));
    expect(screen.getAllByRole('note', { name: 'Layer information' })).toHaveLength(2);
    expect(localStorage.getItem(LAYER_INFO_KEY)).toBeNull();
  });

  it('still toggles when storage refuses the preference', () => {
    // Other settings keep working; only this preference is refused.
    const real = localStorage;
    const refuse = <A extends unknown[], R>(fn: (key: string, ...rest: A) => R) => (key: string, ...rest: A): R => {
      if (key === LAYER_INFO_KEY) throw new Error('storage denied');
      return fn.call(real, key, ...rest);
    };
    const guarded = Object.assign(Object.create(real), {
      getItem: refuse(real.getItem), setItem: refuse(real.setItem), removeItem: refuse(real.removeItem),
    });
    Object.defineProperty(globalThis, 'localStorage', { value: guarded, configurable: true, writable: true });
    Object.defineProperty(window, 'localStorage', { value: guarded, configurable: true, writable: true });
    render(<AppProvider><Seed /></AppProvider>);
    expect(screen.getAllByRole('note', { name: 'Layer information' })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Layer description' }));
    expect(screen.queryAllByRole('note', { name: 'Layer information' })).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Layer description' }));
    expect(screen.getAllByRole('note', { name: 'Layer information' })).toHaveLength(2);
  });
});
