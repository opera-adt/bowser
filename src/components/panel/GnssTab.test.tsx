import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppAction, AppState } from '../../types';
import type { CustomGnssStation } from '../../map/gnss';
import GnssTab from './GnssTab';

let state: AppState;
const dispatch = vi.fn<(a: AppAction) => void>();
vi.mock('../../context/AppContext', () => ({ useAppContext: () => ({ state, dispatch }) }));
vi.mock('../../hooks/useApi', () => ({
  useApi: () => ({
    fetchMultiPointTimeSeries: vi.fn(async () => ({ datasets: [{ data: [{ x: '2026-01-01', y: 0 }, { x: '2026-01-13', y: -0.002 }] }] })),
    fetchPointTimeSeries: vi.fn(), fetchBufferTimeSeries: vi.fn(),
  }),
}));
vi.mock('react-chartjs-2', () => ({ Line: () => <canvas data-testid="gnss-compare" /> }));

const station = (id: string, over: Partial<CustomGnssStation> = {}): CustomGnssStation => ({
  id, name: id, custom: true, lon: -117.67, lat: 33.96, first: 2025.8, last: 2026.2,
  first_date: '2025-11-01', last_date: '2026-03-28', ve_mm_yr: 3, vn_mm_yr: -1.5, vu_mm_yr: -30, sigma_vu_mm_yr: 1.2,
  rows: 22, skipped: 1, units: 'mm', units_from: 'header', date_format: 'iso', components: ['east', 'north', 'up'],
  source: `${id}.csv`, frame: 'IGS20', warnings: [], ...over,
});

let loaded: CustomGnssStation[];
let allowOpen: boolean;
let postStatus: number;
const calls = () => vi.mocked(fetch).mock.calls.map(([url, init]) => ({ url: String(url), init: init as RequestInit | undefined }));
const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
/** A picked file (jsdom's File has no text()). */
const picked = (text: string, name: string) => Object.assign(new File([text], name), { text: async () => text });

beforeEach(() => {
  state = {
    currentDataset: 'displacement',
    datasetInfo: { displacement: { x_values: ['2026-01-01', '2026-01-13'], unit: 'meters', uses_spatial_ref: true,
      los_metadata: { los_enu_ground_to_sat: { east: -0.6, north: -0.1, up: 0.78 } } } },
    viewBounds: [33.9, -117.7, 34.0, -117.6],
    overlays: [], units: 'metric',
    refMarkerPosition: [33.96, -117.68], refEnabled: true, refBufferEnabled: false, refBufferRadius: 0, layerMasks: [],
  } as unknown as AppState;
  loaded = [];
  allowOpen = false;
  postStatus = 200;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/catalog') return ok({ datasets: [], allow_open: allowOpen });
    if (url === '/gnss/custom' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      if (postStatus !== 200) return ok({ detail: 'No columns found: give a header row' }, postStatus);
      const st = station(body.path ? 'PATH1' : 'DEMO');
      loaded = [...loaded.filter(s => s.id !== st.id), st];
      return ok({ file: body.name ?? 'PATH1.csv', rows: 22, skipped: 1, stations: [st] });
    }
    if (url === '/gnss/custom') return ok({ stations: loaded });
    if (url.startsWith('/gnss/custom/') && init?.method === 'DELETE') {
      const id = decodeURIComponent(url.split('/').pop()!);
      loaded = loaded.filter(s => s.id !== id);
      return ok({ removed: id });
    }
    if (url.startsWith('/gnss/custom/')) {
      return ok({ ...station('DEMO'), station: 'DEMO', station_page: null, dates: ['2026-01-01', '2026-01-13'],
        east_mm: [0, 1], north_mm: [0, 0], up_mm: [0, -2] });
    }
    return ok({ detail: 'unexpected' }, 404);
  }));
});

afterEach(() => { cleanup(); dispatch.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const overlaysAdded = () => dispatch.mock.calls.map(([a]) => a).filter(a => a.type === 'ADD_OVERLAY')
  .map(a => (a as { payload: { id: string; data: GeoJSON.FeatureCollection } }).payload);

describe('GNSS tab › Open-source GNSS stations', () => {
  it('names its source, UNR, with a link', () => {
    render(<GnssTab />);
    expect(screen.getByText('Open-source GNSS stations')).toBeTruthy();
    expect(screen.getByText(/Source: UNR/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Nevada Geodetic Laboratory' }).getAttribute('href')).toBe('https://geodesy.unr.edu/');
  });
});

describe('GNSS tab › Load local GNSS file', () => {
  it('loads picked files: posts their text and the units, reports rows and skipped rows, lists and maps the stations', async () => {
    render(<GnssTab />);
    fireEvent.change(screen.getByLabelText('Units of the files'), { target: { value: 'mm' } });
    const file = picked('date,east,north,up\n', 'custom_station.csv');
    fireEvent.change(screen.getByLabelText('GNSS files'), { target: { files: [file] } });
    expect(await screen.findByText(/custom_station\.csv: DEMO, 22 rows \(1 skipped\) in mm, 2025-11-01 – 2026-03-28/)).toBeTruthy();
    const post = calls().find(c => c.url === '/gnss/custom' && c.init?.method === 'POST')!;
    expect(JSON.parse(String(post.init!.body))).toEqual({ text: 'date,east,north,up\n', name: 'custom_station.csv', units: 'mm' });
    const list = screen.getByRole('listbox', { name: 'Local GNSS stations' });
    expect(within(list).getByRole('option', { name: /DEMO/ })).toBeTruthy();
    const layer = overlaysAdded().find(o => o.id === 'gnss_custom')!;
    expect(layer.data.features.map(f => f.properties!.id)).toEqual(['DEMO']);
    // The first loaded station is selected and compared with InSAR (its record from /gnss/custom).
    await waitFor(() => expect(calls().some(c => c.url === '/gnss/custom/DEMO')).toBe(true));
    expect(await screen.findByText('Station DEMO')).toBeTruthy();
    expect(screen.getByText(/linear fit/)).toBeTruthy();
    expect(screen.queryByText('UNR station page')).toBeNull();
  });

  it('shows the server\'s message when a file has nothing usable', async () => {
    postStatus = 400;
    render(<GnssTab />);
    const file = picked('a,b\n', 'bad.csv');
    fireEvent.change(screen.getByLabelText('GNSS files'), { target: { files: [file] } });
    expect((await screen.findByRole('alert')).textContent).toBe('bad.csv: No columns found: give a header row');
    expect(screen.queryByRole('listbox', { name: 'Local GNSS stations' })).toBeNull();
    // The file format and example files are one click away.
    expect(screen.getByRole('link', { name: 'File format and examples' }).getAttribute('href')).toMatch(/docs\/gnss\.md#the-file-format$/);
  });

  it('lists stations loaded before (by the Assistant or MCP) when the tab opens, and maps them', async () => {
    loaded = [station('MCP1')];
    render(<GnssTab />);
    expect(await screen.findByRole('option', { name: /MCP1/ })).toBeTruthy();
    expect(overlaysAdded().some(o => o.id === 'gnss_custom')).toBe(true);
  });

  it('offers a server path only where the server lets the page open files', async () => {
    render(<GnssTab />);
    await waitFor(() => expect(calls().some(c => c.url === '/catalog')).toBe(true));
    expect(screen.queryByLabelText('GNSS file path on the server')).toBeNull();
    cleanup();
    allowOpen = true;
    render(<GnssTab />);
    const input = await screen.findByLabelText('GNSS file path on the server');
    fireEvent.change(input, { target: { value: '/data/gnss/site.csv' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    expect(await screen.findByRole('option', { name: /PATH1/ })).toBeTruthy();
    const post = calls().find(c => c.url === '/gnss/custom' && c.init?.method === 'POST')!;
    expect(JSON.parse(String(post.init!.body))).toEqual({ path: '/data/gnss/site.csv', units: 'auto' });
  });

  it('removes a station from the server, the list and the map', async () => {
    loaded = [station('AAAA'), station('BBBB')];
    state = { ...state, overlays: [{ id: 'gnss_custom' }] } as unknown as AppState;
    render(<GnssTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove AAAA' }));
    await waitFor(() => expect(screen.queryByRole('option', { name: /AAAA/ })).toBeNull());
    expect(calls().some(c => c.url === '/gnss/custom/AAAA' && c.init?.method === 'DELETE')).toBe(true);
    const last = overlaysAdded().slice(-1)[0];
    expect(last.data.features.map(f => f.properties!.id)).toEqual(['BBBB']);
  });
});
