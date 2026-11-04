import { describe, expect, it } from 'vitest';
import { distanceKm, gnssLosSeries, mmPerUnit, stepMarkers, toLos, typicalLos, type GnssSeries } from './gnss';

const UP = { east: 0, north: 0, up: 1 };
// A typical ascending Sentinel-1 look, ground to satellite.
const ASC = { east: -0.62, north: -0.11, up: 0.78 };

describe('toLos', () => {
  it('projects east, north and up on the line of sight', () => {
    expect(toLos(UP, 5, 5, -10)).toBe(-10);
    expect(toLos(ASC, 1, 0, 0)).toBeCloseTo(-0.62);
    expect(toLos(ASC, -13.63, 12.48, -42.58)).toBeCloseTo(-13.63 * -0.62 + 12.48 * -0.11 + -42.58 * 0.78);
  });
});

describe('mmPerUnit', () => {
  it('converts metres and mm, and nothing else', () => {
    expect(mmPerUnit('meters')).toBe(1000);
    expect(mmPerUnit(' M ')).toBe(1000);
    expect(mmPerUnit('mm')).toBe(1);
    expect(mmPerUnit('radians')).toBeNull();
    expect(mmPerUnit(undefined)).toBeNull();
  });
});

describe('gnssLosSeries', () => {
  const series: GnssSeries = {
    station: 'TEST', frame: 'NA', station_page: '',
    dates: ['2020-01-01', '2020-01-02', '2020-01-10', '2020-02-01'],
    east_mm: [0, 0, 0, 0], north_mm: [0, 0, 0, 0], up_mm: [0, 1, 4, 9],
  };

  it('starts at 0 on the GNSS day nearest the first InSAR date, inside the InSAR span', () => {
    expect(gnssLosSeries(series, UP, '2020-01-09', '2020-01-31')).toEqual([{ x: '2020-01-10', y: 0 }]);
    expect(gnssLosSeries(series, UP, '2020-01-02', '2020-02-01')).toEqual([
      { x: '2020-01-02', y: 0 }, { x: '2020-01-10', y: 3 }, { x: '2020-02-01', y: 8 },
    ]);
  });

  it('is empty without positions', () => {
    expect(gnssLosSeries({ ...series, dates: [], east_mm: [], north_mm: [], up_mm: [] }, UP, '2020-01-01', '2020-12-31')).toEqual([]);
  });
});

describe('distanceKm', () => {
  it('measures along the sphere', () => {
    expect(distanceKm(0, 0, 0, 1)).toBeCloseTo(111.2, 0);
    expect(distanceKm(-90, 34.75, -90, 34.75)).toBe(0);
  });
});

describe('typicalLos', () => {
  it('points west and up for ascending, east and up for descending, as a unit vector', () => {
    const asc = typicalLos('ascending');
    expect(asc.east).toBeCloseTo(-0.62, 2);
    expect(asc.north).toBeCloseTo(-0.11, 2);
    expect(asc.up).toBeCloseTo(0.78, 2);
    const desc = typicalLos('descending');
    expect(desc.east).toBeCloseTo(0.62, 2);
    expect(Math.hypot(desc.east, desc.north, desc.up)).toBeCloseTo(1, 10);
  });
});

describe('stepMarkers', () => {
  it('draws one vertical segment per step, apart from the next', () => {
    const t = Date.parse('2021-11-18');
    expect(stepMarkers([{ date: '2021-11-18', kind: 'equipment', detail: 'Antenna Type Changed' }], -5, 7))
      .toEqual([{ x: t, y: -5 }, { x: t, y: 7 }, { x: t + 1, y: null }]);
  });
});
