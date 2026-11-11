import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppAction, AppState } from '../types';
import GnssChartWindow from './GnssChartWindow';
import MapLegend from './MapLegend';

let state: AppState;
const dispatch = vi.fn<(a: AppAction) => void>();
vi.mock('../context/AppContext', () => ({ useAppContext: () => ({ state, dispatch }) }));
vi.mock('react-chartjs-2', () => ({
  Line: ({ data }: { data: { datasets: { label: string }[] } }) => <div data-testid="gnss-panel">{data.datasets[0].label}</div>,
}));

const station = {
  id: 'DEMO', custom: true, lon: -117.67, lat: 33.96, first: 2025.8, last: 2026.2,
  ve_mm_yr: 3, vn_mm_yr: -1.5, vu_mm_yr: -30, sigma_vu_mm_yr: 1.2,
};

beforeEach(() => {
  state = {
    gnssChartStation: station, currentDataset: 'displacement', datasetInfo: {}, units: 'metric',
    fitSettings: { steps: [], breaks: [] }, overlays: [], identify: null,
  } as unknown as AppState;
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ station: 'DEMO', frame: 'IGS20', station_page: null, dates: ['2026-01-01', '2026-01-13'],
      east_mm: [0, 1], north_mm: [0, 0], up_mm: [0, -2] }),
  })));
});

afterEach(() => { cleanup(); dispatch.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('a GNSS station from a file', () => {
  it('opens its chart from /gnss/custom, with linear-fit rates and no UNR link', async () => {
    render(<GnssChartWindow />);
    await waitFor(() => expect(screen.getAllByTestId('gnss-panel')).toHaveLength(3));
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/gnss/custom/DEMO');
    expect(screen.getAllByTestId('gnss-panel').map(p => p.textContent)).toEqual([
      'East (linear fit +3.0 mm/yr)', 'North (linear fit -1.5 mm/yr)', 'Up (linear fit -30.0 mm/yr)',
    ]);
    expect(screen.getByText(/Positions from your file, mm from its first date \(IGS20\)/)).toBeTruthy();
    expect(screen.queryByText('UNR page')).toBeNull();
  });

  it('has its own legend entry', () => {
    state = { ...state, overlays: [
      { id: 'gnss_custom', name: 'GNSS stations (your files)', visible: true, color: '#f59e0b', marker: 'square' },
      { id: 'gnss_stations', name: 'GNSS stations (UNR)', visible: true, color: '#e11d48' },
    ] } as unknown as AppState;
    render(<MapLegend />);
    expect(screen.getByText('GNSS station (your file)')).toBeTruthy();
    expect(screen.getByText('GNSS station')).toBeTruthy();
    expect(screen.getByText('■')).toBeTruthy();
  });
});
