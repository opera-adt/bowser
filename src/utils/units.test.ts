import { describe, expect, it } from 'vitest';
import { displayUnit } from './units';

describe('displayUnit', () => {
  it('keeps metres on the axis and gives mm/yr in metric', () => {
    expect(displayUnit('meters', 'metric')).toEqual({ factor: 1, label: 'm', rate: { factor: 1000, label: 'mm' } });
    expect(displayUnit('mm', 'metric')).toEqual({ factor: 1, label: 'mm', rate: { factor: 1, label: 'mm' } });
  });

  it('shows inches and in/yr in imperial', () => {
    const m = displayUnit('m', 'imperial');
    expect(m.label).toBe('in');
    expect(0.0254 * m.factor).toBeCloseTo(1, 10);
    expect(m.rate).toEqual({ factor: 1, label: 'in' });
    expect(25.4 * displayUnit('mm', 'imperial').factor).toBeCloseTo(1, 10);
  });

  it('leaves other units alone', () => {
    expect(displayUnit('radians', 'imperial')).toEqual({ factor: 1, label: 'radians', rate: null });
    expect(displayUnit(undefined, 'metric')).toEqual({ factor: 1, label: '', rate: null });
  });
});
