import { describe, expect, it } from 'vitest';
import { seriesStyle } from './seriesStyle';

describe('seriesStyle', () => {
  it('draws circles joined by a line by default', () => {
    expect(seriesStyle(undefined, undefined, 4)).toMatchObject({ pointStyle: 'circle', pointRadius: 4, showLine: true, borderDash: [] });
  });

  it('maps shapes to Chart.js point styles', () => {
    expect(seriesStyle('square', 'solid', 4).pointStyle).toBe('rect');
    expect(seriesStyle('diamond', 'solid', 4).pointStyle).toBe('rectRot');
    expect(seriesStyle('cross', 'solid', 4)).toMatchObject({ pointStyle: 'crossRot', pointBorderWidth: 2 });
  });

  it('can drop the line, dash it, or drop the markers', () => {
    expect(seriesStyle('circle', 'none', 4).showLine).toBe(false);
    expect(seriesStyle('circle', 'dashed', 4).borderDash).toEqual([6, 4]);
    expect(seriesStyle('none', 'solid', 4)).toMatchObject({ pointRadius: 0, showLine: true });
  });

  it('never hides both: no marker and no line keeps the markers', () => {
    expect(seriesStyle('none', 'none', 4)).toMatchObject({ pointRadius: 4, showLine: false });
  });
});
