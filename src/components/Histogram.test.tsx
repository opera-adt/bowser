/** The colour histogram: one request per settled date, none while playing through the dates. */
import { useEffect } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import type { AppAction } from '../types';

vi.mock('react-chartjs-2', () => ({ Bar: () => <canvas data-testid="hist-bars" /> }));

import Histogram, { clearHistogramCache, HISTOGRAM_DEBOUNCE_MS } from './Histogram';

const BODY = {
  bins: [-2, -1, 0, 1, 2], counts: [1, 2, 3, 4], min: -2, max: 2,
  p2: -1.9, p98: 1.9, p16: -1, p84: 1, p23: -1.8, p977: 1.8,
};

let dispatchRef: (a: AppAction) => void;
function Harness() {
  const { dispatch } = useAppContext();
  dispatchRef = dispatch;
  useEffect(() => { dispatch({ type: 'SET_CURRENT_DATASET', payload: 'displacement' }); }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  return <Histogram />;
}

const fetchMock = vi.fn(async () => new Response(JSON.stringify(BODY)));
const requested = () => (fetchMock.mock.calls as unknown as [string][]).map(([url]) =>
  Number(new URL(url, 'http://x').searchParams.get('time_index')));
const send = (a: AppAction) => act(() => { dispatchRef(a); });
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  clearHistogramCache();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Histogram', () => {
  it('asks once for the date the slider settles on', async () => {
    render(<AppProvider><Harness /></AppProvider>);
    await wait(HISTOGRAM_DEBOUNCE_MS + 10);
    expect(requested()).toEqual([0]);
    for (const i of [1, 2, 3, 4]) {
      send({ type: 'SET_TIME_INDEX', payload: i });
      await wait(HISTOGRAM_DEBOUNCE_MS / 3);
    }
    expect(requested()).toEqual([0]);
    await wait(HISTOGRAM_DEBOUNCE_MS);
    expect(requested()).toEqual([0, 4]);
  });

  it('asks nothing while playing, keeps the range buttons, and asks for the date it stops on', async () => {
    render(<AppProvider><Harness /></AppProvider>);
    await wait(HISTOGRAM_DEBOUNCE_MS + 10);
    expect(requested()).toEqual([0]);
    send({ type: 'SET_PLAYING', payload: true });
    for (const i of [1, 2, 3, 4, 5, 6]) {
      send({ type: 'SET_TIME_INDEX', payload: i });
      await wait(2 * HISTOGRAM_DEBOUNCE_MS);  // slower than the debounce
    }
    expect(requested()).toEqual([0]);
    // The last histogram stays, so its presets still apply while playing.
    expect(screen.getByTestId('hist-bars')).toBeTruthy();
    expect(screen.queryByText('Computing…')).toBeNull();
    send({ type: 'SET_PLAYING', payload: false });
    await wait(HISTOGRAM_DEBOUNCE_MS + 10);
    expect(requested()).toEqual([0, 6]);
  });
});
