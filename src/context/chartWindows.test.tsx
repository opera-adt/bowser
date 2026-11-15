import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppProvider, useAppContext } from './AppContext';
import type { AppAction, AppState } from '../types';
import { mapClickActions } from '../map/interactions';

let state: AppState;
let dispatch: (a: AppAction) => void;
function Probe() { ({ state, dispatch } = useAppContext()); return null; }

afterEach(cleanup);

describe('closing chart windows', () => {
  it('closing the last window closes the chart, so the footer button and the next point reopen it', () => {
    render(<AppProvider><Probe /></AppProvider>);
    act(() => dispatch({ type: 'TOGGLE_CHART' }));
    expect(state.showChart).toBe(true);
    expect(state.chartWindows).toHaveLength(1);

    act(() => dispatch({ type: 'REMOVE_CHART_WINDOW', payload: state.chartWindows[0].id }));
    expect(state.chartWindows).toHaveLength(0);
    expect(state.showChart).toBe(false);

    // A click on the map adds a point and opens the chart again, with a window.
    const click = mapClickActions(state, [34.75, -90.11], { toolActive: false, profileActive: false });
    expect(click.kind).toBe('actions');
    act(() => { if (click.kind === 'actions') click.actions.forEach(dispatch); });
    expect(state.showChart).toBe(true);
    expect(state.chartWindows).toHaveLength(1);
  });

  it('closing one of two windows leaves the chart open', () => {
    render(<AppProvider><Probe /></AppProvider>);
    act(() => dispatch({ type: 'TOGGLE_CHART' }));
    act(() => dispatch({ type: 'ADD_CHART_WINDOW', payload: { id: 'second', dsNames: [] } }));
    act(() => dispatch({ type: 'REMOVE_CHART_WINDOW', payload: 'second' }));
    expect(state.chartWindows).toHaveLength(1);
    expect(state.showChart).toBe(true);
  });
});
