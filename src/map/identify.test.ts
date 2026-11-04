import { describe, expect, it } from 'vitest';
import { attributeRows, geologyItem, landCoverClass, landCoverIdentifyUrl, overlayIdOfLayer } from './identify';

describe('identify', () => {
  it('names land cover pixel values', () => {
    expect(landCoverClass('1')).toEqual({ name: 'Water', color: '#1a5bab' });
    expect(landCoverClass(7)?.name).toBe('Built area');
    expect(landCoverClass(3)).toBeNull();
  });

  it('asks the land cover service for one year at a point', () => {
    const u = new URL(landCoverIdentifyUrl(-90.114, 34.755, 2024));
    expect(u.pathname).toMatch(/ImageServer\/identify$/);
    expect(JSON.parse(u.searchParams.get('geometry')!)).toEqual({ x: -90.114, y: 34.755, spatialReference: { wkid: 4326 } });
    expect(u.searchParams.get('time')).toBe(`${Date.UTC(2024, 0, 1)},${Date.UTC(2024, 11, 31, 23, 59, 59)}`);
  });

  it('takes the most detailed Macrostrat unit', () => {
    const body = { success: { data: [
      { name: 'Regional unit', scale: 'small', t_int_name: 'Eocene', b_int_name: 'Eocene' },
      { name: 'Alluvium', scale: 'large', lith: 'sand, silt', t_int_name: 'Holocene', b_int_name: 'Pleistocene', t_int_age: 0, b_int_age: 2.58, color: '#fffab4' },
    ] } };
    const item = geologyItem(body)!;
    expect(item.rows[0]).toEqual(['Unit', 'Alluvium']);
    expect(item.rows).toContainEqual(['Age', 'Pleistocene–Holocene (0–2.58 Ma)']);
    expect(item.rows).toContainEqual(['Lithology', 'sand, silt']);
    expect(item.color).toBe('#fffab4');
    expect(geologyItem({ success: { data: [] } })).toBeNull();
  });

  it('lists plain attributes only', () => {
    expect(attributeRows({ a: 1.23456789, b: 'x', c: null, d: { nested: 1 }, e: '' })).toEqual([['a', '1.23457'], ['b', 'x']]);
  });

  it('maps layer ids back to overlays', () => {
    expect(overlayIdOfLayer('overlay-ov_1_2-fill')).toBe('ov_1_2');
    expect(overlayIdOfLayer('overlay-gnss_stations-point')).toBe('gnss_stations');
    expect(overlayIdOfLayer('overlay-landcover_17')).toBe('landcover_17');
    expect(overlayIdOfLayer('data-3')).toBeNull();
  });
});
