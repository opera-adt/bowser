/**
 * Request contract: every API call the UI makes, pinned as a snapshot.
 *
 * The backend side is pinned by tests/regression (golden JSON responses). This side
 * pins what the frontend *asks*, so a map-library swap (Leaflet -> MapLibre) or a
 * refactor can't silently change a URL, a parameter or a POST body. Update on purpose
 * with `npx vitest run -u` and review the snapshot diff.
 */
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { datasetRangeUrl, useApi, withDataset } from './useApi';

type Call = { url: string; method: string; body: unknown };

let calls: Call[] = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body as string) : null,
    });
    return new Response(JSON.stringify({ mode: 'md', title: 't' }), { status: 200 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

const LON = -117.67462;
const LAT = 33.95859;
const REF_LON = -117.67984;
const REF_LAT = 33.96289;
const MASK = [{ id: 'm1', dataset: 'temporal_coherence', threshold: 0.7, mode: 'min' as const }];
const POINTS = [{ id: 'p1', lat: LAT, lon: LON, color: '#f00', name: 'dam' }];

async function exerciseEveryCall() {
  const { result } = renderHook(() => useApi());
  const api = result.current;
  await api.fetchDatasets();
  await api.fetchDataMode();
  await api.fetchConfig();
  await api.fetchPointTimeSeries(LON, LAT, 'displacement');
  await api.fetchChartTimeSeries(LON, LAT, 'displacement');
  await api.fetchChartTimeSeries(LON, LAT, 'displacement', REF_LON, REF_LAT);
  await api.fetchMultiPointTimeSeries(POINTS, 'displacement', REF_LON, REF_LAT, true, MASK, 50);
  await api.fetchTrendAnalysis(LON, LAT, 'displacement', REF_LON, REF_LAT);
  await api.fetchTimeBounds('displacement');
  await api.fetchBufferTimeSeries(LON, LAT, 'displacement', 90, 5, REF_LON, REF_LAT, MASK, 30);
  return calls;
}

describe('useApi request contract', () => {
  it('single-dataset mode (no ?dataset=)', async () => {
    expect(await exerciseEveryCall()).toMatchSnapshot();
  });

  it('catalog mode routes every call to ?dataset=<id>', async () => {
    window.history.replaceState({}, '', '/?dataset=prado-034-a-019');
    const got = await exerciseEveryCall();
    expect(got).toMatchSnapshot();
    // Every data call carries the dataset id; /mode and /config are global.
    for (const c of got) {
      if (c.url.startsWith('/mode') || c.url.startsWith('/config')) continue;
      expect(c.url, c.url).toContain('dataset=prado-034-a-019');
    }
  });

  it('dataset range is routed to the catalog dataset', () => {
    expect(datasetRangeUrl('temporal_coherence')).toBe('/dataset_range/temporal_coherence');
    window.history.replaceState({}, '', '/?dataset=prado-034-a-019');
    expect(datasetRangeUrl('temporal_coherence')).toBe('/dataset_range/temporal_coherence?dataset=prado-034-a-019');
  });

  it('withDataset leaves params alone outside catalog mode', () => {
    expect(withDataset(new URLSearchParams({ a: '1' })).toString()).toBe('a=1');
  });
});
