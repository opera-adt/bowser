import { describe, expect, it } from 'vitest';
import type { HistogramData } from './colorPresets';
import { defaultThreshold, keptFraction, keptLabel } from './maskThreshold';

const hist = (bins: number[], counts: number[]) => ({ bins, counts, min: bins[0], max: bins[bins.length - 1] } as HistogramData);

describe('a layer mask threshold', () => {
  it('starts at the low end of the layer for ≥ and the high end for ≤, in its own units', () => {
    const amplitude = { min: 0, max: 9000, p2: 40, p98: 2500 };
    expect(defaultThreshold(amplitude, 'min')).toBe(40);
    expect(defaultThreshold(amplitude, 'max')).toBe(2500);
    expect(defaultThreshold({ min: -0.1, max: 0.2 }, 'min')).toBe(-0.1);   // no percentiles: the full range
    expect(defaultThreshold({ min: -0.1, max: 0.2 }, 'max')).toBe(0.2);
  });

  it('says how much of the layer a threshold keeps', () => {
    const h = hist([0, 0.25, 0.5, 0.75, 1], [10, 20, 30, 40]);   // 100 pixels
    expect(keptFraction(h, 0.5, 'min')).toBeCloseTo(0.7);        // the two upper bins
    expect(keptFraction(h, 0.5, 'max')).toBeCloseTo(0.3);
    expect(keptFraction(h, 0.625, 'min')).toBeCloseTo(0.55);     // half of the third bin
    expect(keptFraction(h, -1, 'min')).toBe(1);
    expect(keptFraction(h, 2, 'min')).toBe(0);
    expect(keptFraction(h, 2, 'max')).toBe(1);
  });

  it('has no answer without a usable histogram', () => {
    expect(keptFraction(null, 0.5, 'min')).toBeNull();
    expect(keptFraction(hist([], []), 0.5, 'min')).toBeNull();
    expect(keptFraction(hist([0, 1], [0]), 0.5, 'min')).toBeNull();
  });

  it('labels the share without pretending to be exact at the ends', () => {
    expect(keptLabel(0.634)).toBe('63%');
    expect(keptLabel(0.004)).toBe('<1%');
    expect(keptLabel(0.996)).toBe('>99%');
    expect(keptLabel(0)).toBe('0%');
    expect(keptLabel(1)).toBe('100%');
  });
});
