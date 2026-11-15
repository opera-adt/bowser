import { describe, expect, it } from 'vitest';
import { maskControlRange, maskDefaultThreshold, validMaskMode } from './maskControls';

describe('absolute-value mask controls', () => {
  const range = { min: -12, max: 5, p2: -8, p98: 3 };
  it('offers nonnegative magnitude limits covering both tails without changing signed limits', () => {
    expect(maskControlRange(range, 'abs_max')).toEqual([0, 12]);
    expect(maskControlRange(range, 'abs_min')).toEqual([0, 12]);
    expect(maskControlRange(range, 'min')).toEqual([-8, 3]);
    expect(maskDefaultThreshold(range, 'abs_max')).toBe(12);
    expect(maskDefaultThreshold(range, 'abs_min')).toBe(0);
    expect(maskDefaultThreshold(range, 'max')).toBe(3);
  });
  it('provides finite bounds before a range loads and handles one-sided and constant layers', () => {
    expect(maskControlRange(undefined, 'abs_max')).toEqual([0, 1]);
    expect(maskControlRange({ min: -10, max: -2 }, 'abs_max')).toEqual([0, 10]);
    expect(maskControlRange({ min: 0, max: 0 }, 'abs_max')).toEqual([0, 0]);
    expect(maskDefaultThreshold(undefined, 'abs_max', -5)).toBe(5);
  });
  it('accepts saved absolute comparisons and legacy missing modes but rejects unknown/negative magnitude rules', () => {
    expect(validMaskMode('abs_max', 5)).toBe(true);
    expect(validMaskMode('abs_min', 0)).toBe(true);
    expect(validMaskMode(undefined, -5)).toBe(true);
    expect(validMaskMode('min', -5)).toBe(true);
    expect(validMaskMode('abs_max', -5)).toBe(false);
    expect(validMaskMode('absolute', 5)).toBe(false);
  });
});
