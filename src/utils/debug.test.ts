import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DEBUG_KEY, DEBUG_MESSAGES_MAX, clearDebugMessages, debugMessage, debugOn, setDebug, useDebug, useDebugMessages } from './debug';
import { vi } from 'vitest';

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

describe('diagnostic messages', () => {
  afterEach(() => { clearDebugMessages(); vi.restoreAllMocks(); });

  it('are kept in order, said in the console, and followed by the hook', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useDebugMessages());
    expect(result.current).toEqual([]);
    act(() => { debugMessage('data layer: GPU — auto: capable GPU'); });
    act(() => { debugMessage('data layer: tiles — fell back to tiles: WebGL context lost', true); });
    expect(result.current.map(m => [m.text, m.warn])).toEqual([
      ['data layer: GPU — auto: capable GPU', false],
      ['data layer: tiles — fell back to tiles: WebGL context lost', true],
    ]);
    expect(info).toHaveBeenCalledWith('[bowser] data layer: GPU — auto: capable GPU');
    expect(warn).toHaveBeenCalledWith('[bowser] data layer: tiles — fell back to tiles: WebGL context lost');
  });

  it('note the same message once when it repeats, and keep only the newest', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { result } = renderHook(() => useDebugMessages());
    act(() => { debugMessage('a'); debugMessage('a'); debugMessage('b'); debugMessage('a'); });
    expect(result.current.map(m => m.text)).toEqual(['a', 'b', 'a']);
    act(() => { for (let i = 0; i < DEBUG_MESSAGES_MAX + 5; i++) debugMessage(`m${i}`); });
    expect(result.current).toHaveLength(DEBUG_MESSAGES_MAX);
    expect(result.current[result.current.length - 1].text).toBe(`m${DEBUG_MESSAGES_MAX + 4}`);
  });
});
