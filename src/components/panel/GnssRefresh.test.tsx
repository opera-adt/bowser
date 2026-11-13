import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, MultiPointTimeSeriesData } from '../../types';
import GnssTab from './GnssTab';

let state: AppState;
const mocks = vi.hoisted(() => ({ points: vi.fn(), point: vi.fn(), buffer: vi.fn(), dispatch: vi.fn(), chart: null as { datasets: Array<{ label: string; data: Array<{ x: number; y: number }> }> } | null }));
vi.mock('../../context/AppContext', () => ({ useAppContext: () => ({ state, dispatch: mocks.dispatch }) }));
vi.mock('../../hooks/useApi', () => ({ useApi: () => ({ fetchMultiPointTimeSeries: mocks.points, fetchPointTimeSeries: mocks.point, fetchBufferTimeSeries: mocks.buffer }) }));
vi.mock('react-chartjs-2', () => ({ Line: ({ data }: { data: NonNullable<typeof mocks.chart> }) => { mocks.chart = data; return <canvas data-testid="comparison" />; } }));
const station = { id: 'TEST', custom: true, name: 'TEST', lon: 3, lat: 0.001, first: 2026, last: 2026.1, ve_mm_yr: 1, vn_mm_yr: 1, vu_mm_yr: 0, sigma_vu_mm_yr: 0.1, first_date: '2026-01-01', last_date: '2026-01-25', rows: 3, skipped: 0, units: 'mm', units_from: 'header', date_format: 'iso', components: ['east', 'north', 'up'], source: 'synthetic.csv', frame: 'local', warnings: [] };
const result = (y: number) => ({ datasets: [{ data: [{ x: '2026-01-01', y: 0 }, { x: '2026-01-25', y }] }] }) as MultiPointTimeSeriesData;
const insar = () => mocks.chart?.datasets.find(d => d.label.startsWith('InSAR'))?.data.map(p => p.y);
beforeEach(() => {
  state = { currentDataset: 'displacement', datasetInfo: { displacement: { uses_spatial_ref: true, unit: 'meters', x_values: ['2026-01-01', '2026-01-25'], los_metadata: { los_enu_ground_to_sat: { east: 0, north: 0, up: 1 } } }, other: { uses_spatial_ref: true, unit: 'meters', x_values: ['2026-01-01', '2026-01-25'] } }, viewBounds: [0, 2, 1, 4], overlays: [], units: 'metric', refEnabled: true, refMarkerPosition: [0, 3], refBufferEnabled: false, refBufferRadius: 15, layerMasks: [] } as unknown as AppState;
  mocks.points.mockReset().mockResolvedValue(result(0.002)); mocks.chart = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url === '/gnss/custom' ? { stations: [station] } : url === '/catalog' ? { allow_open: false } : { ...station, station: station.id, dates: ['2026-01-01', '2026-01-25'], east_mm: [0, 1], north_mm: [0, 1], up_mm: [0, 2] } })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function select() {
  const view = render(<GnssTab />);
  fireEvent.click(await screen.findByRole('option', { name: /TEST/ }));
  await waitFor(() => expect(insar()).toEqual([0, 2]));
  return view;
}
describe('GNSS comparison refresh', () => {
  it('refreshes masks, layer and reference radius without reloading GNSS observations', async () => {
    const view = await select();
    const count = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/gnss/custom/TEST').length;
    const before = count();
    mocks.points.mockResolvedValue(result(0.004));
    state = { ...state, layerMasks: [{ id: 'quality', dataset: 'temporal_coherence', mode: 'min', threshold: 0.8 }] };
    view.rerender(<GnssTab />);
    await waitFor(() => expect(insar()).toEqual([0, 4]));
    expect(mocks.points.mock.calls[mocks.points.mock.calls.length - 1]?.[5]).toEqual(state.layerMasks);
    state = { ...state, currentDataset: 'other', refBufferEnabled: true, refBufferRadius: 50 };
    view.rerender(<GnssTab />);
    await waitFor(() => expect(mocks.points.mock.calls[mocks.points.mock.calls.length - 1]?.[1]).toBe('other'));
    expect(mocks.points.mock.calls[mocks.points.mock.calls.length - 1]?.[6]).toBe(50);
    state = { ...state, refMarkerPosition: [0.002, 3.002] };
    view.rerender(<GnssTab />);
    await waitFor(() => expect(mocks.points.mock.calls[mocks.points.mock.calls.length - 1]?.[2]).toBe(3.002));
    expect(mocks.points.mock.calls[mocks.points.mock.calls.length - 1]?.[3]).toBe(0.002);
    expect(count()).toBe(before);
  });
  it('clears the earlier InSAR curve while a replacement is pending and ignores late replies', async () => {
    const view = await select();
    let finish!: (r: MultiPointTimeSeriesData) => void;
    mocks.points.mockReturnValueOnce(new Promise(r => { finish = r; }));
    state = { ...state, layerMasks: [{ id: 'q', dataset: 'quality', mode: 'min', threshold: 0.5 }] };
    view.rerender(<GnssTab />);
    await waitFor(() => expect(screen.queryByTestId('comparison')).toBeNull());
    mocks.points.mockResolvedValue(result(0.006));
    state = { ...state, layerMasks: [] }; view.rerender(<GnssTab />);
    await waitFor(() => expect(insar()).toEqual([0, 6]));
    await act(async () => finish(result(0.099)));
    expect(insar()).toEqual([0, 6]);
  });
  it('does not leave an old curve on screen when comparison retrieval fails', async () => {
    const view = await select(); mocks.points.mockResolvedValue(undefined);
    state = { ...state, refEnabled: false }; view.rerender(<GnssTab />);
    await waitFor(() => expect(screen.queryByTestId('comparison')).toBeNull());
    expect(await screen.findByText(/InSAR comparison unavailable/)).toBeTruthy();
  });
});
