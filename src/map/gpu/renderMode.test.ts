import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RENDER_KEY, renderMode, setRenderMode, useRenderMode } from './renderMode';

describe('the renderer asked for', () => {
  afterEach(() => { localStorage.clear(); window.history.replaceState(null, '', '/'); });

  it('is server tiles by default', () => {
    expect(renderMode()).toBe('tiles');
  });

  it('is kept in this browser and followed by the hook', () => {
    const { result } = renderHook(() => useRenderMode());
    expect(result.current).toBe('tiles');
    act(() => setRenderMode('auto'));
    expect(result.current).toBe('auto');
    expect(localStorage.getItem(RENDER_KEY)).toBe('auto');
    act(() => setRenderMode('gpu'));
    expect(result.current).toBe('gpu');
    act(() => setRenderMode('tiles'));
    expect(result.current).toBe('tiles');
    expect(localStorage.getItem(RENDER_KEY)).toBeNull();   // the default is not stored
  });

  it('?render= decides for that visit, whatever is kept', () => {
    localStorage.setItem(RENDER_KEY, 'gpu');
    window.history.replaceState(null, '', '/?render=tiles&dataset=a');
    expect(renderMode()).toBe('tiles');
    window.history.replaceState(null, '', '/?render=nonsense');
    expect(renderMode()).toBe('gpu');                        // not a mode: the kept choice
  });

  it('choosing one takes ?render= out of the address, so the choice holds', () => {
    window.history.replaceState(null, '', '/?dataset=a&render=tiles');
    const { result } = renderHook(() => useRenderMode());
    act(() => setRenderMode('auto'));
    expect(result.current).toBe('auto');
    expect(window.location.search).toBe('?dataset=a');
  });

  it('ignores a value it does not know in storage', () => {
    localStorage.setItem(RENDER_KEY, 'cpu');
    expect(renderMode()).toBe('tiles');
  });
});
