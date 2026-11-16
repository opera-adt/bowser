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

  it('converts the length of a rate (a velocity layer) and keeps its time', () => {
    const v = displayUnit('m/yr', 'imperial');
    expect(v.label).toBe('in/yr');
    expect(0.0254 * v.factor).toBeCloseTo(1, 10);
    expect(v.rate).toBeNull();
    expect(25.4 * displayUnit('mm/year', 'imperial').factor).toBeCloseTo(1, 10);
    expect(displayUnit('mm/year', 'imperial').label).toBe('in/year');
    // Metric shows it as the cube gives it.
    expect(displayUnit('m/yr', 'metric')).toEqual({ factor: 1, label: 'm/yr', rate: null });
    // Not a length per time: left alone.
    expect(displayUnit('rad/yr', 'imperial')).toEqual({ factor: 1, label: 'rad/yr', rate: null });
    expect(displayUnit('m/s/s', 'imperial')).toEqual({ factor: 1, label: 'm/s/s', rate: null });
  });

  it('leaves other units alone', () => {
    expect(displayUnit('radians', 'imperial')).toEqual({ factor: 1, label: 'radians', rate: null });
    expect(displayUnit(undefined, 'metric')).toEqual({ factor: 1, label: '', rate: null });
  });
});
