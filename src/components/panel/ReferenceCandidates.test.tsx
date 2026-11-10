import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppAction, AppState, RefCandidate } from '../../types';
import ReferenceCandidates from './ReferenceCandidates';

let state: AppState;
const dispatch = vi.fn<(a: AppAction) => void>();
vi.mock('../../context/AppContext', () => ({ useAppContext: () => ({ state, dispatch }) }));

const candidate = (rank: number, over: Partial<RefCandidate> = {}): RefCandidate => ({
  rank, lon: -90.12 + rank * 0.01, lat: 34.78, radius_m: 100,
  temporal_coherence_median: 0.98, phase_similarity_median: 0.95, viable_fraction: 1,
  displacement_scatter_m: 0.0017, velocity: 0, score: 0.7, reason: `reason ${rank}`, ...over,
});

let candidatesBody: unknown;
let release: () => void;

function urls() {
  return vi.mocked(fetch).mock.calls.map(c => String(c[0]));
}

beforeEach(() => {
  state = {
    currentDataset: 'displacement',
    datasetInfo: { displacement: { uses_spatial_ref: true, algorithm: 'shift', x_values: ['2026-01-01', '2026-01-13'] } },
    refMarkerPosition: [34.78, -90.2],
    refBufferEnabled: false, refBufferRadius: 500, refCandidates: [],
  } as unknown as AppState;
  candidatesBody = { candidates: [candidate(1), candidate(2)], recommended: candidate(1) };
  let gate: Promise<void> = Promise.resolve();
  release = () => {};
  gate = new Promise(r => { release = r; });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/reference_candidates')) {
      await gate;
      return { ok: true, json: async () => candidatesBody };
    }
    if (url.startsWith('/buffer_timeseries')) {
      return { ok: true, json: async () => ({ labels: ['2026-01-01', '2026-01-13'], median: [{ x: '2026-01-01', y: 0 }, { x: '2026-01-13', y: 2 }] }) };
    }
    return { ok: true, json: async () => [5, 6] };   // /point
  }));
  window.history.replaceState({}, '', '/?dataset=arkabutla');
});

afterEach(() => { cleanup(); dispatch.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Find a stable reference', () => {
  it('asks the server with a spinner, then stores the candidates', async () => {
    render(<ReferenceCandidates />);
    fireEvent.click(screen.getByRole('button', { name: /Find a stable reference/ }));
    expect(await screen.findByText('Finding a stable reference…')).toBeTruthy();
    expect(document.querySelector('.fa-spinner')).not.toBeNull();
    const url = new URL(urls()[0], window.location.origin);
    expect(url.pathname).toBe('/reference_candidates');
    expect(url.searchParams.get('radius_m')).toBe('100');
    expect(url.searchParams.get('n')).toBe('5');
    expect(url.searchParams.get('dataset')).toBe('arkabutla');
    release();
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith(
      { type: 'SET_REF_CANDIDATES', payload: [candidate(1), candidate(2)] }));
    expect(screen.getByRole('button', { name: /Find a stable reference/ })).toBeTruthy();
  });

  it('searches with the reference buffer radius when it is on', async () => {
    state.refBufferEnabled = true;
    state.refBufferRadius = 250;
    render(<ReferenceCandidates />);
    fireEvent.click(screen.getByRole('button', { name: /Find a stable reference/ }));
    release();
    await waitFor(() => expect(urls()).toHaveLength(1));
    expect(new URL(urls()[0], window.location.origin).searchParams.get('radius_m')).toBe('250');
  });

  it('says why when the server fails', async () => {
    vi.mocked(fetch).mockImplementation(async () => ({ ok: false, status: 404, json: async () => ({ detail: 'Variable phase_similarity not found' }) }) as Response);
    render(<ReferenceCandidates />);
    fireEvent.click(screen.getByRole('button', { name: /Find a stable reference/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('Variable phase_similarity not found');
  });
});

describe('the candidate list', () => {
  it('lists rank, coherence and similarity medians, stability and distance; the first is recommended', () => {
    state.refCandidates = [candidate(1), candidate(2, { displacement_scatter_m: 0.0031, temporal_coherence_median: 0.81 })];
    render(<ReferenceCandidates />);
    const items = within(screen.getByRole('list', { name: 'Reference candidates' })).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('1');
    expect(items[0].textContent).toContain('Recommended');
    expect(items[0].textContent).toContain('coh 0.98');
    expect(items[0].textContent).toContain('sim 0.95');
    expect(items[0].textContent).toContain('scatter 1.7 mm');
    expect(items[0].textContent).toMatch(/8\.2 km away/);
    expect(items[1].textContent).toContain('Candidate 2');
    expect(items[1].textContent).toContain('coh 0.81');
    expect(items[1].textContent).toContain('scatter 3.1 mm');
  });

  it('marks the candidate the reference already sits on', () => {
    state.refCandidates = [candidate(1)];
    state.refMarkerPosition = [candidate(1).lat, candidate(1).lon];
    render(<ReferenceCandidates />);
    const row = screen.getByRole('button', { name: /Recommended/ });
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(row.textContent).toContain('reference');
  });

  it('clicking a candidate moves the reference there and samples around it with its radius', async () => {
    state.refCandidates = [candidate(1), candidate(2)];
    render(<ReferenceCandidates />);
    fireEvent.click(screen.getByRole('button', { name: /Candidate 2/ }));
    const c = candidate(2);
    expect(dispatch.mock.calls.map(a => a[0]).slice(0, 3)).toEqual([
      { type: 'SET_REF_MARKER_POSITION', payload: [c.lat, c.lon] },
      { type: 'SET_REF_BUFFER_ENABLED', payload: true },
      { type: 'SET_REF_BUFFER_RADIUS', payload: 100 },
    ]);
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith(
      { type: 'SET_REF_VALUES', payload: { dataset: 'displacement', values: [0, 2] } }));
    const call = vi.mocked(fetch).mock.calls.find(a => String(a[0]).startsWith('/buffer_timeseries'))!;
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body).toMatchObject({ lon: c.lon, lat: c.lat, buffer_m: 100, dataset_name: 'displacement' });
  });

  it('a single-pixel candidate (radius 0) moves the reference without a buffer', async () => {
    state.refCandidates = [candidate(1, { radius_m: 0 })];
    render(<ReferenceCandidates />);
    fireEvent.click(screen.getByRole('button', { name: /Recommended/ }));
    expect(dispatch.mock.calls.map(a => a[0].type)).not.toContain('SET_REF_BUFFER_ENABLED');
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith(
      { type: 'SET_REF_VALUES', payload: { dataset: 'displacement', values: [5, 6] } }));
    expect(urls().some(u => u.startsWith('/point'))).toBe(true);
  });

  it('"Use recommended" chooses the first candidate', () => {
    state.refCandidates = [candidate(1), candidate(2)];
    render(<ReferenceCandidates />);
    fireEvent.click(screen.getByRole('button', { name: 'Use recommended' }));
    expect(dispatch.mock.calls[0][0]).toEqual(
      { type: 'SET_REF_MARKER_POSITION', payload: [candidate(1).lat, candidate(1).lon] });
  });

  it('clears the candidates', () => {
    state.refCandidates = [candidate(1)];
    render(<ReferenceCandidates />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear the candidates' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_REF_CANDIDATES', payload: [] });
  });
});
