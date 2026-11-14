import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { getViewBounds, roundedBounds, setViewBounds, useViewBounds } from './viewBounds';

afterEach(() => setViewBounds(null));

describe('view bounds', () => {
  it('rounds what the map reports to 6 decimals, south/west/north/east', () => {
    expect(roundedBounds(33.951234567, -117.682345678, 33.97, -117.66)).toEqual([33.951235, -117.682346, 33.97, -117.66]);
  });

  it('tells its readers of a new view, and not of the same one again', () => {
    const { result } = renderHook(() => { const seen = vi.fn(); seen(useViewBounds()); return useViewBounds(); });
    expect(result.current).toBeNull();
    act(() => setViewBounds([1, 2, 3, 4]));
    expect(result.current).toEqual([1, 2, 3, 4]);
    const first = getViewBounds();
    act(() => setViewBounds([1, 2, 3, 4]));
    expect(getViewBounds()).toBe(first);
  });
});
