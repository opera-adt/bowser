import { describe, expect, it } from 'vitest';
import type { MultiPointTimeSeriesData, RasterGroup } from '../types';
import { activeRefTime, canReReference, refDateLabel, relativeChartData, relativeTo } from './refDate';

const info = (over: Partial<RasterGroup> = {}): RasterGroup => ({
  name: 'displacement', file_list: [], mask_file_list: [], mask_min_value: 0, nodata: null,
  uses_spatial_ref: true, algorithm: 'shift', latlon_bounds: [0, 0, 1, 1],
  x_values: ['2026-01-01', '2026-01-13', '2026-01-25'], available_mask_vars: [], ...over,
});

describe('which layers can be shown relative to another date', () => {
  it('needs a displacement-like layer with a time axis, in MD mode', () => {
    expect(canReReference(info())).toBe(true);
    expect(canReReference(info({ uses_spatial_ref: false }))).toBe(false);
    expect(canReReference(info({ x_values: ['2026-01-01'] }))).toBe(false);
    expect(activeRefTime(info(), 1, 'md')).toBe(1);
    expect(activeRefTime(info(), 7, 'md')).toBe(2);
    expect(activeRefTime(info(), undefined, 'md')).toBeNull();
    expect(activeRefTime(info(), 1, 'cog')).toBeNull();
  });

  it('names the date a step is relative to', () => {
    expect(refDateLabel('2018-01-05T00:00:00')).toBe('2018-01-05');
    expect(refDateLabel('2016-07-26_2018-01-05')).toBe('2018-01-05');
  });
});

describe('chart series relative to another date', () => {
  it('subtracts each series’ own value at that date', () => {
    const data = [{ x: '2026-01-01', y: 1 }, { x: '2026-01-13', y: 4 }, { x: '2026-01-25', y: 10 }];
    expect(relativeTo(data, '2026-01-13').map(p => p.y)).toEqual([-3, 0, 6]);
    // No value at that date (a NaN the server left out): nothing to show.
    expect(relativeTo(data.filter(p => p.x !== '2026-01-13'), '2026-01-13')).toEqual([]);
  });

  it('changes only the re-referenced layers', () => {
    const cd = (ys: number[]): MultiPointTimeSeriesData => ({
      labels: ['a', 'b'],
      datasets: [{ label: 'P1', pointId: 'p1', borderColor: '', backgroundColor: '', data: ys.map((y, i) => ({ x: ['a', 'b'][i], y })) }],
    });
    const out = relativeChartData({ disp: cd([2, 5]), other: cd([2, 5]) }, { disp: 'b' });
    expect(out.disp.datasets[0].data.map(p => p.y)).toEqual([-3, 0]);
    expect(out.other.datasets[0].data.map(p => p.y)).toEqual([2, 5]);
  });
});
