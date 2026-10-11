/** Profile fetching shared by both maps: first request, and refetch on time step / radius / interval. */
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockState } = vi.hoisted(() => ({ mockState: {} as Record<string, any> }));
vi.mock('../context/AppContext', () => ({ useAppContext: () => ({ state: mockState, dispatch: vi.fn() }) }));

import { ProfileProvider, useProfileContext, useProfileFetch } from './ProfileTool';
import type { LatLng } from '../map/profileGeometry';

const LINE: LatLng[] = [[33.96289, -117.67984], [33.95429, -117.66939]];
let bodies: any[] = [];

beforeEach(() => {
  bodies = [];
  Object.assign(mockState, { currentDataset: 'displacement', currentTimeIndex: 3 });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify({ centre: [{ dist: 0, value: 1 }] }));
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup(line: LatLng[] | null) {
  const wrapper = ({ children }: { children: ReactNode }) => <ProfileProvider>{children}</ProfileProvider>;
  return renderHook(() => ({ ctx: useProfileContext(), fetchLine: useProfileFetch(() => line) }), { wrapper });
}

describe('useProfileFetch', () => {
  it('requests the finished line as [lng, lat] with the current time step and stores the result', async () => {
    const { result } = setup(LINE);
    await act(async () => { await result.current.fetchLine(LINE); });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      coords: [[-117.67984, 33.96289], [-117.66939, 33.95429]], time_index: 3, radius: 0, sampling_interval: 0,
    });
    expect(result.current.ctx.data?.centre).toEqual([{ dist: 0, value: 1 }]);
  });

  it('refetches the current line when the radius, the interval or the time step changes', async () => {
    const { result, rerender } = setup(LINE);
    await act(async () => { result.current.ctx.setActive(true); });
    const n0 = bodies.length;
    await act(async () => { result.current.ctx.setRadius(60); });
    expect(bodies[bodies.length - 1]).toMatchObject({ radius: 60 });
    await act(async () => { result.current.ctx.setSamplingInterval(30); });
    expect(bodies[bodies.length - 1]).toMatchObject({ radius: 60, sampling_interval: 30 });
    mockState.currentTimeIndex = 5;
    await act(async () => { rerender(); });
    expect(bodies[bodies.length - 1]).toMatchObject({ time_index: 5, radius: 60, sampling_interval: 30 });
    expect(bodies.length).toBeGreaterThan(n0);
  });

  it('does not refetch while there is no finished line', async () => {
    const { result } = setup(null);
    await act(async () => { result.current.ctx.setActive(true); });
    await act(async () => { result.current.ctx.setRadius(60); });
    expect(bodies).toHaveLength(0);
  });
});
