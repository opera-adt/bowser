import { describe, expect, it } from 'vitest';
import { customGnssOverlay, gnssOverlay } from './contextServices';
import {
  GNSS_CUSTOM_LAYER_ID, GNSS_LAYER_ID, describeLoad, gnssKey, gnssSeriesUrl, rateSource,
  type CustomGnssStation, type GnssCsvLoaded,
} from './gnss';

const station = (over: Partial<CustomGnssStation> = {}): CustomGnssStation => ({
  id: 'DEMO', name: 'Demo site', custom: true, lon: -117.67, lat: 33.96, first: 2025.8, last: 2026.2,
  first_date: '2025-11-01', last_date: '2026-03-28', ve_mm_yr: 3, vn_mm_yr: -1.5, vu_mm_yr: -30, sigma_vu_mm_yr: 1.2,
  rows: 22, skipped: 1, units: 'mm', units_from: 'header', date_format: 'iso', components: ['east', 'north', 'up'],
  source: 'custom_station.csv', frame: 'IGS20', warnings: [], ...over,
});

describe('stations from files', () => {
  it('read their record from /gnss/custom, UNR stations from /gnss/series', () => {
    expect(gnssSeriesUrl({ id: 'P056' })).toBe('/gnss/series/P056');
    expect(gnssSeriesUrl({ id: 'my site.1', custom: true })).toBe('/gnss/custom/my%20site.1');
  });

  it('keep a file station apart from a UNR station of the same name', () => {
    expect(gnssKey({ id: 'P056', custom: true })).not.toBe(gnssKey({ id: 'P056' }));
    expect(rateSource({ custom: true })).toBe('linear fit');
    expect(rateSource({})).toBe('MIDAS');
  });

  it('say what a file gave: stations, rows, skipped rows, units and span', () => {
    const r: GnssCsvLoaded = { file: 'net.csv', rows: 40, skipped: 3, stations: [
      station({ id: 'AAAA', first_date: '2020-01-01', last_date: '2021-01-01' }),
      station({ id: 'BBBB', first_date: '2019-06-01', last_date: '2020-12-01' }),
    ] };
    expect(describeLoad(r)).toBe('net.csv: AAAA, BBBB, 40 rows (3 skipped) in mm, 2019-06-01 – 2021-01-01');
    const guessed = { ...r, skipped: 0, stations: [station({ units: 'm', units_from: 'guessed' })] };
    expect(describeLoad(guessed)).toBe('net.csv: DEMO, 40 rows in m (guessed), 2025-11-01 – 2026-03-28');
  });
});

describe('customGnssOverlay', () => {
  it('draws the stations as amber squares in their own layer, apart from UNR', () => {
    const o = customGnssOverlay([station(), station({ id: 'B2', lon: 10, lat: 20 })]);
    expect(o.id).toBe(GNSS_CUSTOM_LAYER_ID);
    expect(o.id).not.toBe(gnssOverlay([]).id);
    expect(GNSS_LAYER_ID).toBe(gnssOverlay([]).id);
    expect(o.marker).toBe('square');
    expect(o.color).not.toBe(gnssOverlay([]).color);
    expect(o.type).toBe('vector');
    const data = o.data as GeoJSON.FeatureCollection;
    expect(data.features.map(f => (f.geometry as GeoJSON.Point).coordinates)).toEqual([[-117.67, 33.96], [10, 20]]);
    const p = data.features[0].properties!;
    expect(p).toMatchObject({ id: 'DEMO', custom: true, ve_mm_yr: 3, vn_mm_yr: -1.5, vu_mm_yr: -30, sigma_vu_mm_yr: 1.2 });
    // Only scalars: MapLibre would hand lists back as text.
    expect(Object.values(p).every(v => typeof v !== 'object')).toBe(true);
  });
});
