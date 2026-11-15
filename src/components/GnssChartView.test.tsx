import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppAction, AppState } from '../types';
import GnssChartWindow, { GNSS_VIEW_KEY } from './GnssChartWindow';

let state: AppState;
const dispatch = vi.fn<(a: AppAction) => void>();
vi.mock('../context/AppContext', async () =>
  (await import('../test/appContextMock')).appContextMock(() => ({ state, dispatch })));
vi.mock('react-chartjs-2', () => ({
  Line: ({ data }: { data: { datasets: { label: string }[] } }) => <div data-testid="gnss-panel">{data.datasets[0].label}</div>,
}));

const station = { id: 'MKEA', lon: -155.46, lat: 19.8, first: 1996.8, last: 2026.8, ve_mm_yr: 10, vn_mm_yr: 0, vu_mm_yr: -20, sigma_vu_mm_yr: 0.4 };
const los = { los_enu_ground_to_sat: { east: -0.6, north: 0, up: 0.8 } };
const panels = () => screen.getAllByTestId('gnss-panel').map(p => p.textContent);

beforeEach(() => {
  localStorage.clear();
  state = {
    gnssChartStation: station, currentDataset: 'displacement', units: 'metric', fitSettings: { steps: [], breaks: [] },
    datasetInfo: { displacement: { x_values: ['2026-01-01', '2026-01-13'], los_metadata: los } }, overlays: [], identify: null,
  } as unknown as AppState;
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ station: 'MKEA', frame: 'IGS20', station_page: null, dates: ['2026-01-01', '2026-01-13'],
      east_mm: [0, 1], north_mm: [0, 0], up_mm: [0, -2] }),
  })));
});

afterEach(() => { cleanup(); dispatch.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('the GNSS chart: 3D or line of sight', () => {
  it('opens on east, north and up, and LOS shows the motion along the line of sight alone', async () => {
    render(<GnssChartWindow />);
    await waitFor(() => expect(screen.getAllByTestId('gnss-panel')).toHaveLength(3));
    expect(panels().map(p => p!.split(' ')[0])).toEqual(['East', 'North', 'Up']);
    expect(screen.getByRole('button', { name: '3D' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'LOS' }));
    // 10 mm/yr east and -20 up on (-0.6, 0, 0.8): -6 - 16 = -22 towards the satellite.
    expect(panels()).toEqual(['LOS (MIDAS -22.0 mm/yr)']);
    expect(screen.getByRole('button', { name: 'LOS' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/LOS is towards the satellite of this cube/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '3D' }));
    expect(panels()).toHaveLength(3);
  });

  it('keeps the choice for the next station', async () => {
    const first = render(<GnssChartWindow />);
    await waitFor(() => expect(screen.getAllByTestId('gnss-panel')).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: 'LOS' }));
    expect(localStorage.getItem(GNSS_VIEW_KEY)).toBe('los');
    first.unmount();
    render(<GnssChartWindow />);
    await waitFor(() => expect(panels()).toEqual(['LOS (MIDAS -22.0 mm/yr)']));
    fireEvent.click(screen.getByRole('button', { name: '3D' }));
    expect(localStorage.getItem(GNSS_VIEW_KEY)).toBeNull();
  });

  it('a cube without a look vector has no switch and shows east, north and up, whatever was chosen', async () => {
    localStorage.setItem(GNSS_VIEW_KEY, 'los');
    state = { ...state, datasetInfo: { displacement: { x_values: ['2026-01-01', '2026-01-13'] } } } as unknown as AppState;
    render(<GnssChartWindow />);
    await waitFor(() => expect(screen.getAllByTestId('gnss-panel')).toHaveLength(3));
    expect(screen.queryByRole('button', { name: 'LOS' })).toBeNull();
  });
});
