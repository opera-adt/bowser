import { useEffect } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import type { AppAction, AppState, RasterGroup } from '../types';
import DateBadge from './DateBadge';

const layer = { name: 'displacement', x_values: ['2026-01-01', '2026-01-13', '2026-01-25'], latlon_bounds: [0, 0, 1, 1] } as unknown as RasterGroup;
let state: AppState;
let dispatch: (a: AppAction) => void;
function Page() {
  ({ state, dispatch } = useAppContext());
  useEffect(() => {
    dispatch({ type: 'SET_DATASETS', payload: { displacement: layer } });
    dispatch({ type: 'SET_CURRENT_DATASET', payload: 'displacement' });
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  return <DateBadge />;
}

afterEach(cleanup);

describe('the date badge on the map', () => {
  it('its ✕ hides it; the date in the panel cycles full, date only, off', () => {
    render(<AppProvider><Page /></AppProvider>);
    while (state.dateBadge !== 'full') act(() => dispatch({ type: 'TOGGLE_DATE_BADGE' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide the date' }));
    expect(state.dateBadge).toBe('off');
    expect(screen.queryByRole('group', { name: 'Map date' })).toBeNull();

    act(() => dispatch({ type: 'TOGGLE_DATE_BADGE' }));
    expect(state.dateBadge).toBe('full');
    act(() => dispatch({ type: 'TOGGLE_DATE_BADGE' }));
    expect(state.dateBadge).toBe('date');
    act(() => dispatch({ type: 'TOGGLE_DATE_BADGE' }));
    expect(state.dateBadge).toBe('off');
  });

  it('steps the date', () => {
    render(<AppProvider><Page /></AppProvider>);
    while (state.dateBadge !== 'full') act(() => dispatch({ type: 'TOGGLE_DATE_BADGE' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next date' }));
    expect(state.currentTimeIndex).toBe(1);
  });
});
