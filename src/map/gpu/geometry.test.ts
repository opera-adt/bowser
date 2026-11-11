import { describe, expect, it } from 'vitest';
import proj4 from 'proj4';
import { affineFromCentres, chunkMesh, chunksForView, meshError, pickLevel, rasterTileZoom, translateMatrix, type LevelGrid } from './geometry';
import { epsgFromCrs, lonLatToMercator, lonLatToUtm, mercatorToLonLat, utmToLonLat, utmZoneFromEpsg } from './projection';

const z15 = { zone: 15, south: false };
const frame: LevelGrid[] = [0, 1, 2, 3, 4].map(i => {
  const px = 30 * 2 ** i;
  return { prefix: `${i}/`, transform: [px, 0, 71970, 0, -px, 3385920], shape: [Math.ceil(7733 / 2 ** i), Math.ceil(9464 / 2 ** i)], chunk: [256, 256] };
});

describe('UTM projection', () => {
  it('matches proj4 to well under a millimetre', () => {
    const utm = '+proj=utm +zone=15 +datum=WGS84 +units=m +no_defs';
    for (const [x, y] of [[71970, 3385920], [355890, 3153930], [500000, 3300000], [230000, 3800000]]) {
      const [lon, lat] = utmToLonLat(x, y, z15);
      const [plon, plat] = proj4(utm, 'EPSG:4326', [x, y]);
      expect(Math.abs(lon - plon) * 1e5).toBeLessThan(0.001);   // degrees * 1e5 ~ metres
      expect(Math.abs(lat - plat) * 1e5).toBeLessThan(0.001);
      const [bx, by] = lonLatToUtm(lon, lat, z15);
      expect(Math.abs(bx - x)).toBeLessThan(1e-4);
      expect(Math.abs(by - y)).toBeLessThan(1e-4);
    }
    const south = { zone: 33, south: true };
    const [lon, lat] = utmToLonLat(400000, 7000000, south);
    const [plon, plat] = proj4('+proj=utm +zone=33 +south +datum=WGS84', 'EPSG:4326', [400000, 7000000]);
    expect(lon).toBeCloseTo(plon, 8);
    expect(lat).toBeCloseTo(plat, 8);
  });

  it('reads the zone from proj:code or a WKT', () => {
    expect(utmZoneFromEpsg(epsgFromCrs('EPSG:32615')!)).toEqual(z15);
    expect(epsgFromCrs('PROJCRS["x",BASEGEOGCRS[ID["EPSG",4326]],ID["EPSG",32615]]')).toBe(32615);
    // WKT1, as rioxarray writes spatial_ref's crs_wkt.
    expect(epsgFromCrs('PROJCS["WGS 84 / UTM zone 11N",GEOGCS["WGS 84",AUTHORITY["EPSG","4326"]],'
      + 'UNIT["metre",1,AUTHORITY["EPSG","9001"]],AUTHORITY["EPSG","32611"]]')).toBe(32611);
    expect(utmZoneFromEpsg(32733)).toEqual({ zone: 33, south: true });
    expect(utmZoneFromEpsg(4326)).toBeNull();
  });

  it('round-trips Web Mercator', () => {
    const [x, y] = lonLatToMercator(-90.1, 29.9);
    const [lon, lat] = mercatorToLonLat(x, y);
    expect(lon).toBeCloseTo(-90.1, 10);
    expect(lat).toBeCloseTo(29.9, 10);
  });
});

describe('grid geometry', () => {
  it('picks the level the server picks for a tile zoom', () => {
    // 40075016.686 / (2^z * 256): z=12 -> 38.2 m (30 m level), z=10 -> 152.9 m (120 m level).
    expect(pickLevel(frame, 12)).toBe(0);
    expect(pickLevel(frame, 11)).toBe(1);
    expect(pickLevel(frame, 10)).toBe(2);
    expect(pickLevel(frame, 6)).toBe(4);
    expect(pickLevel(frame.slice(0, 1), 3)).toBe(0);
    expect(rasterTileZoom(8.4)).toBe(9);
    expect(rasterTileZoom(8.6)).toBe(10);
  });

  it('turns coordinate centres into an edge affine', () => {
    expect(affineFromCentres(15, 45, 985, 955)).toEqual([30, 0, 0, 0, -30, 1000]);
  });

  it('finds the chunks under a view', () => {
    const [w, n] = utmToLonLat(71970 + 10, 3385920 - 10, z15);
    const [e, s] = utmToLonLat(71970 + 30 * 300, 3385920 - 30 * 100, z15);
    expect(chunksForView(frame[0], z15, w, s, e, n)).toEqual({ cy0: 0, cy1: 0, cx0: 0, cx1: 1 });
    expect(chunksForView(frame[0], z15, 10, 10, 11, 11)).toBeNull();
  });

  it('builds a mesh over the valid part of an edge chunk', () => {
    const lv = frame[4];   // 484 x 592 -> last chunk row has 228 rows, last col 80 cols
    const m = chunkMesh(lv, z15, 1, 2, 32);
    const xs = [0, 32, 64, 80], ys = [0, 32, 64, 96, 128, 160, 192, 224, 228];
    expect(m.vertices.length).toBe(xs.length * ys.length * 4);
    expect(m.indices.length).toBe((xs.length - 1) * (ys.length - 1) * 6);
    expect(Array.from(m.vertices.slice(-2))).toEqual([80, 228]);
    expect(m.vertices[0]).toBe(0);
  });

  it('keeps the linear mesh error far below a pixel', () => {
    // Far corner of the frame (worst UTM distortion), 32-px cells at 30 m.
    expect(meshError(frame[0], z15, 7700, 0, 32)).toBeLessThan(0.05);
    // A whole 256-px chunk at the coarsest level (123 km) as one cell.
    expect(meshError(frame[4], z15, 0, 0, 256)).toBeLessThan(480 / 4);
  });

  it('translates a matrix in double precision', () => {
    const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(Array.from(translateMatrix(id, 0.25, 0.5)).slice(12)).toEqual([0.25, 0.5, 0, 1]);
  });
});
