import { describe, expect, it } from 'vitest';
import type { RasterGroup } from '../types';
import { addChartLayer, chartLayerFor, hasTimeAxis, timeIndexOfDate, timeSeriesLayers } from './chartLayers';

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

describe('addChartLayer', () => {
  it('keeps the followed layer when the chart follows the map', () => {
    expect(addChartLayer([], 'displacement', 'temporal_coherence')).toEqual(['displacement', 'temporal_coherence']);
  });

  it('appends to a chosen list, once', () => {
    expect(addChartLayer(['a'], 'displacement', 'b')).toEqual(['a', 'b']);
    expect(addChartLayer(['a', 'b'], 'displacement', 'b')).toEqual(['a', 'b']);
  });

  it('gives just the new layer when nothing is followed', () => {
    expect(addChartLayer([], null, 'b')).toEqual(['b']);
  });
});

describe('the time step of a date', () => {
  it('is the date\'s position on the layer\'s axis, whatever form either takes', () => {
    const axis = ['2024-01-01', '2024-01-13', '2024-01-25'];
    expect(timeIndexOfDate(axis, '2024-01-25')).toBe(2);
    expect(timeIndexOfDate(axis, '2024-01-13T00:00:00')).toBe(1);
    expect(timeIndexOfDate(['20240101', '20240101_20240113'], '2024-01-13')).toBe(1);
  });

  it('is null when the layer has no step on that day, or no axis', () => {
    expect(timeIndexOfDate(['2024-01-01'], '2024-02-01')).toBeNull();
    expect(timeIndexOfDate([], '2024-01-01')).toBeNull();
    expect(timeIndexOfDate(undefined, '2024-01-01')).toBeNull();
  });
});


describe('date-pair identity when secondary dates repeat', () => {
  const pairs = ['2026-01-01_2026-01-25', '2026-01-13_2026-01-25', '2026-01-13_2026-02-06'];
  it('selects the actual pair, keeping both acquisitions', () => {
    expect(timeIndexOfDate(pairs, pairs[1])).toBe(1);
    expect(timeIndexOfDate(pairs, '20260113_20260125')).toBe(1);
    expect(timeIndexOfDate(['20260101_20260125', '20260113_20260125'], pairs[1])).toBe(1);
  });
  it('does not replace a missing pair with a different pair ending on the same date', () => {
    expect(timeIndexOfDate(pairs, '2026-01-07_2026-01-25')).toBeNull();
  });
  it('leaves ambiguous date-only selections unresolved but keeps unique day matches', () => {
    expect(timeIndexOfDate(pairs, '2026-01-25')).toBeNull();
    expect(timeIndexOfDate(pairs, '2026-02-06')).toBe(2);
    expect(timeIndexOfDate([pairs[0], pairs[0]], pairs[0])).toBeNull();
  });
  it('keeps explicit subdaily observations and numeric indices distinguishable', () => {
    expect(timeIndexOfDate(['2026-01-25T01:00:00', '2026-01-25T13:00:00'], '2026-01-25T13:00:00')).toBe(1);
    expect(timeIndexOfDate([0, 1, 2], 2)).toBe(2);
  });
});
