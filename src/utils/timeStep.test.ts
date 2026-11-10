import { afterEach, describe, expect, it, vi } from 'vitest';
import { clampTimeIndex, readPlaySpeed, savePlaySpeed } from './timeStep';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('clampTimeIndex', () => {
  it('keeps a step within the layer', () => {
    expect(clampTimeIndex(-1, 5)).toBe(0);
    expect(clampTimeIndex(2, 5)).toBe(2);
    expect(clampTimeIndex(7, 5)).toBe(4);
  });
});

describe('play speed', () => {
  it('defaults to one date a second and remembers a choice', () => {
    expect(readPlaySpeed()).toBe(1);
    savePlaySpeed(0.5);
    expect(readPlaySpeed()).toBe(0.5);
  });

  it('ignores a value it does not offer and storage that throws', () => {
    localStorage.setItem('bowser-play-speed', '17');
    expect(readPlaySpeed()).toBe(1);
    const blocked = () => { throw new Error('blocked'); };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked });
    expect(() => savePlaySpeed(2)).not.toThrow();
    expect(readPlaySpeed()).toBe(1);
  });
});
