import { describe, expect, it } from 'vitest';
import type { RasterGroup } from '../types';
import { addChartLayer, chartLayerFor, hasTimeAxis, observedDateNear, observedLabelNear, timeIndexOfDate, timeSeriesLayers } from './chartLayers';

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

describe('the observed date nearest a click', () => {
  const t = (d: string) => Date.parse(`${d}T00:00:00Z`);
  const data = { _series: { role: 'data' }, data: [{ x: '2026-01-01' }, { x: '2026-01-13' }, { x: '2026-01-25' }] };
  const model = { _series: { role: 'model' }, data: [{ x: '2026-01-04' }, { x: '2026-01-14' }, { x: '2026-01-24' }] };

  it('takes the nearest observation, never the fitted model', () => {
    expect(observedDateNear([model, data], t('2026-01-14'))).toBe('2026-01-13');
    expect(observedDateNear([model, data], t('2026-01-24'))).toBe('2026-01-25');
  });

  it('counts buffer and area medians as observations, and skips hidden series and bands', () => {
    const median = { _series: { role: 'median' }, data: [{ x: '2026-02-01' }] };
    const band = { _series: { role: 'band_upper' }, data: [{ x: '2026-01-14' }] };
    expect(observedDateNear([band, median], t('2026-01-14'))).toBe('2026-02-01');
    expect(observedDateNear([{ ...data, hidden: true }, model], t('2026-01-14'))).toBeNull();
  });
});

describe('a click on a series whose steps are intervals', () => {
  it("hands back the point's own interval label, so a shared end date does not hide which step it is", () => {
    const t = Date.parse('2026-01-25T00:00:00Z');
    const series = { _series: { role: 'data' }, data: [
      { x: '2026-01-25', _sourceLabel: '2026-01-01_2026-01-25' },
      { x: '2026-02-06', _sourceLabel: '2026-01-13_2026-02-06' },
    ] };
    expect(observedDateNear([series], t)).toBe('2026-01-01_2026-01-25');
    const axis = ['2026-01-01_2026-01-25', '2026-01-13_2026-01-25', '2026-01-13_2026-02-06'];
    expect(timeIndexOfDate(axis, observedDateNear([series], t)!)).toBe(0);
  });
});

describe('the observed point a click is on', () => {
  const series = { _series: { role: 'data' }, data: [
    { x: '2026-01-13', _sourceLabel: 'x_2026-01-13' },
    { x: '2026-01-25', _sourceLabel: 'a_2026-01-25' }, { x: '2026-01-25', _sourceLabel: 'b_2026-01-25' },
  ] };
  const model = { _series: { role: 'model' }, data: [{ x: '2026-01-24' }] };
  const dots = (i: number) => (i === 1 ? [{ x: 10, y: 50 }, { x: 50, y: 10 }, { x: 50, y: 90 }] : [{ x: 48, y: 50 }]);
  const t = (d: string) => Date.parse(`${d}T00:00:00Z`);

  it('goes by date, and by height only between points sharing that date', () => {
    expect(observedLabelNear([model, series], t('2026-01-24'), dots, 85)).toBe('b_2026-01-25');
    expect(observedLabelNear([model, series], t('2026-01-24'), dots, 15)).toBe('a_2026-01-25');
    expect(observedLabelNear([model, series], t('2026-01-14'), dots, 90)).toBe('x_2026-01-13');
  });

  it('without drawn positions or labels, behaves as the date lookup', () => {
    const plain = { _series: { role: 'data' }, data: [{ x: '2026-01-13' }, { x: '2026-01-25' }] };
    expect(observedLabelNear([plain], t('2026-01-24'))).toBe('2026-01-25');
    expect(observedLabelNear([model], t('2026-01-24'))).toBeNull();
  });
});
