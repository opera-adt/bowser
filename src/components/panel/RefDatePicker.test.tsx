import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../../context/AppContext';
import type { AppState, RasterGroup } from '../../types';
import MainTab from './MainTab';
import ProjectTab from './ProjectTab';

vi.mock('../Histogram', () => ({ default: () => null }));
const saved: Blob[] = [];
vi.mock('../../utils/saveFile', () => ({ saveFile: async (blob: Blob) => { saved.push(blob); } }));
// The panel asks the server for reference values; keep those requests pending.
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))); });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  saved.length = 0;
});

const layer = (over: Partial<RasterGroup>): RasterGroup => ({
  name: 'displacement', file_list: [], mask_file_list: [], mask_min_value: 0, nodata: null,
  uses_spatial_ref: true, algorithm: 'shift', latlon_bounds: [0, 0, 1, 1], available_mask_vars: [],
  x_values: ['2016-07-14_2016-08-07', '2016-07-14_2016-08-19', '2016-07-14_2016-08-31'],
  reference_date: '2016-07-14', ...over,
});

let latest: AppState;
function Seed({ dataMode = 'md', children }: { dataMode?: string; children: React.ReactNode }) {
  const { state, dispatch } = useAppContext();
  latest = state;
  useEffect(() => {
    dispatch({ type: 'SET_DATASETS', payload: {
      displacement: layer({}),
      coherence: layer({ name: 'coherence', uses_spatial_ref: false, algorithm: null }),
      timeseries: layer({ name: 'timeseries', x_values: ['2026-01-01', '2026-01-13'], reference_date: null }),
    } });
    dispatch({ type: 'SET_CURRENT_DATASET', payload: 'displacement' });
    dispatch({ type: 'SET_DATA_MODE', payload: dataMode });
  }, [dispatch, dataMode]);
  return <>{children}</>;
}

const refButton = (name: RegExp) => screen.getByRole('button', { name });

describe('reference date under the time step slider', () => {
  it('shows the stored reference and references the layer to another date', () => {
    render(<AppProvider><Seed><MainTab /></Seed></AppProvider>);
    fireEvent.click(refButton(/^ref 2016-07-14$/));
    expect(screen.getByText('Reference to another date…')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Reference to date' }), { target: { value: '1' } });
    expect(latest.refTimeIndex).toEqual({ displacement: 1 });
    // A pair is relative to its secondary date.
    const shown = refButton(/^ref 2016-08-19$/);
    expect(shown.className).toContain(' on');
    expect(screen.queryByText('Reference to another date…')).toBeNull();

    act(() => { fireEvent.change(screen.getByRole('slider', { name: 'Time step' }), { target: { value: '2' } }); });
    fireEvent.click(shown);
    fireEvent.click(screen.getByRole('button', { name: 'Use current date' }));
    expect(latest.refTimeIndex).toEqual({ displacement: 2 });

    fireEvent.click(refButton(/^ref 2016-08-31$/));
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(latest.refTimeIndex).toEqual({});
    expect(refButton(/^ref 2016-07-14$/).className).not.toContain(' on');
  });

  it('keeps the choice per layer', () => {
    render(<AppProvider><Seed><MainTab /></Seed></AppProvider>);
    fireEvent.click(refButton(/^ref 2016-07-14$/));
    fireEvent.change(screen.getByRole('combobox', { name: 'Reference to date' }), { target: { value: '2' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Layer' }), { target: { value: 'timeseries' } });
    // No stored reference date: still offered, as stored.
    fireEvent.click(refButton(/^ref date$/));
    fireEvent.click(screen.getByRole('button', { name: 'Use current date' }));
    expect(latest.refTimeIndex).toEqual({ displacement: 2, timeseries: 0 });
    fireEvent.change(screen.getByRole('combobox', { name: 'Layer' }), { target: { value: 'displacement' } });
    expect(refButton(/^ref 2016-08-31$/)).toBeTruthy();
  });

  it('only shows the date for other layers and in COG mode', () => {
    const { unmount } = render(<AppProvider><Seed><MainTab /></Seed></AppProvider>);
    fireEvent.change(screen.getByRole('combobox', { name: 'Layer' }), { target: { value: 'coherence' } });
    expect(screen.getByText('ref 2016-07-14').tagName).toBe('SPAN');
    unmount();
    render(<AppProvider><Seed dataMode="cog"><MainTab /></Seed></AppProvider>);
    expect(screen.getByText('ref 2016-07-14').tagName).toBe('SPAN');
  });

  it('is saved and loaded with the project', async () => {
    render(<AppProvider><Seed><ProjectTab /></Seed></AppProvider>);
    act(() => {
      fireEvent.click(screen.getByText('Save'));
    });
    await waitFor(() => expect(saved).toHaveLength(1));
    const text = await new Promise<string>(resolve => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsText(saved[0]);
    });
    expect(JSON.parse(text).refTimeIndex).toEqual({});

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const load = (refTimeIndex: unknown) => {
      const json = JSON.stringify({ bowser_project: 1, opacity: 0.5, refTimeIndex });
      // jsdom's File has no text().
      const file = Object.assign(new File([json], 'p.json', { type: 'application/json' }), { text: async () => json });
      fireEvent.change(input, { target: { files: [file] } });
    };
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    load({ displacement: 1 });
    await waitFor(() => expect(latest.refTimeIndex).toEqual({ displacement: 1 }));
    load({ displacement: -1 });
    await waitFor(() => expect(alert).toHaveBeenCalledWith(expect.stringContaining('refTimeIndex')));
    expect(latest.refTimeIndex).toEqual({ displacement: 1 });
    alert.mockRestore();
  });
});
