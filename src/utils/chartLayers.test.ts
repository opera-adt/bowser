import { describe, expect, it } from 'vitest';
import type { RasterGroup } from '../types';
import { chartLayerFor, hasTimeAxis, timeSeriesLayers } from './chartLayers';

const layer = (x_values: Array<number | string>) => ({ x_values }) as RasterGroup;
const DATES = ['2024-01-01', '2024-01-13'];

const CUBE = {
  velocity: layer([]),
  short_wavelength_displacement: layer(DATES),
  temporal_coherence: layer(DATES),
  displacement: layer(DATES),
  amplitude_dispersion: layer([]),
};

describe('hasTimeAxis', () => {
  it('needs more than one step', () => {
    expect(hasTimeAxis(layer(DATES))).toBe(true);
    expect(hasTimeAxis(layer([]))).toBe(false);      // 2-D cube variable
    expect(hasTimeAxis(layer([0]))).toBe(false);     // single-file COG layer
    expect(hasTimeAxis(undefined)).toBe(false);
  });
});

describe('timeSeriesLayers', () => {
  it('leaves out layers without a time axis and keeps the order', () => {
    expect(timeSeriesLayers(CUBE)).toEqual(['short_wavelength_displacement', 'temporal_coherence', 'displacement']);
  });
});

describe('chartLayerFor', () => {
  it('follows the map layer when it has a time axis', () => {
    expect(chartLayerFor('temporal_coherence', CUBE)).toBe('temporal_coherence');
  });

  it('shows displacement when the map layer is velocity', () => {
    expect(chartLayerFor('velocity', CUBE)).toBe('displacement');
  });

  it('matches the COG layer name whatever its case', () => {
    expect(chartLayerFor('Velocity', { Velocity: layer([0]), Coherence: layer(DATES), Displacement: layer(DATES) })).toBe('Displacement');
  });

  it('falls back to a displacement variant, then to the first time layer', () => {
    expect(chartLayerFor('velocity', { velocity: layer([]), coherence: layer(DATES), short_wavelength_displacement: layer(DATES) }))
      .toBe('short_wavelength_displacement');
    expect(chartLayerFor('velocity', { velocity: layer([]), unwrappedPhase: layer(DATES), coherence: layer(DATES) })).toBe('unwrappedPhase');
  });

  it('gives nothing when no layer has a time axis', () => {
    expect(chartLayerFor('velocity', { velocity: layer([]) })).toBeNull();
    expect(chartLayerFor('', {})).toBeNull();
  });
});
