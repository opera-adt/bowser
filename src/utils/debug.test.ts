import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DEBUG_KEY, debugOn, setDebug, useDebug } from './debug';

describe('diagnostics (debug mode)', () => {
  afterEach(() => { localStorage.clear(); window.history.replaceState(null, '', '/'); });

  it('is off by default', () => {
    expect(debugOn()).toBe(false);
  });

  it('is kept in this browser and followed by the hook', () => {
    const { result } = renderHook(() => useDebug());
    expect(result.current).toBe(false);
    act(() => setDebug(true));
    expect(result.current).toBe(true);
    expect(localStorage.getItem(DEBUG_KEY)).toBe('1');
    act(() => setDebug(false));
    expect(result.current).toBe(false);
    expect(localStorage.getItem(DEBUG_KEY)).toBeNull();
  });

  it('?debug=1 turns it on for that visit', () => {
    window.history.replaceState(null, '', '/?debug=1');
    expect(debugOn()).toBe(true);
  });
});
