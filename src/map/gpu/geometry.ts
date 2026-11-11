/**
 * Cube grid geometry for the GPU render spike: pyramid level choice (as the servers'
 * ``dataset_for_tile_zoom``), which chunks a view needs, and the per-chunk mesh whose
 * vertices are projected UTM -> Web Mercator on the CPU in double precision.
 */
import { lonLatToMercator, lonLatToUtm, mercatorToLonLat, utmToLonLat, type UtmZone } from './projection';

/** rasterio-order affine: x = a*col + b*row + c, y = d*col + e*row + f (pixel edges). */
export type Affine = [number, number, number, number, number, number];

export interface LevelGrid {
  /** Path prefix of the level's group in the store ('' for a cube without a pyramid). */
  prefix: string;
  transform: Affine;
  /** [rows, cols] of the level. */
  shape: [number, number];
  /** [rows, cols] of one (inner) chunk. */
  chunk: [number, number];
}

const EQUATOR_M = 40075016.686;

/** The tile zoom MapLibre requests for a 256-px raster source at map ``zoom``. */
export function rasterTileZoom(zoom: number): number {
  return Math.round(zoom + 1);
}

/**
 * The coarsest level whose pixel is no larger than a tile pixel at tile zoom ``z`` —
 * the same pick as ``BowserState.dataset_for_tile_zoom``, so GPU and tiles read the
 * same level.
 */
export function pickLevel(levels: LevelGrid[], z: number, tileSize = 256): number {
  if (levels.length <= 1) return 0;
  const tilePixelM = EQUATOR_M / ((1 << z) * tileSize);
  let chosen = 0;
  levels.forEach((lv, i) => { if (Math.abs(lv.transform[0]) <= tilePixelM) chosen = i; });
  return chosen;
}

/** Affine from 1-D pixel-centre coordinate arrays (x along cols, y along rows). */
export function affineFromCentres(x0: number, x1: number, y0: number, y1: number): Affine {
  const dx = x1 - x0;
  const dy = y1 - y0;
  return [dx, 0, x0 - dx / 2, 0, dy, y0 - dy / 2];
}

/** Fractional [col, row] of UTM (x, y) on a north-up grid. */
export function utmToPixel(t: Affine, x: number, y: number): [number, number] {
  return [(x - t[2]) / t[0], (y - t[5]) / t[4]];
}

/** Integer chunk index ranges [cy0, cy1] x [cx0, cx1] (inclusive) covering a lon/lat box. */
export function chunksForView(
  lv: LevelGrid, zone: UtmZone, west: number, south: number, east: number, north: number,
): { cy0: number; cy1: number; cx0: number; cx1: number } | null {
  // Sample the box edges (a lon/lat box is curved in UTM).
  let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      if (i !== 0 && i !== steps && j !== 0 && j !== steps) continue;
      const lon = west + ((east - west) * i) / steps;
      const lat = south + ((north - south) * j) / steps;
      const [x, y] = lonLatToUtm(lon, lat, zone);
      const [c, r] = utmToPixel(lv.transform, x, y);
      minC = Math.min(minC, c); maxC = Math.max(maxC, c); minR = Math.min(minR, r); maxR = Math.max(maxR, r);
    }
  }
  const [rows, cols] = lv.shape;
  const [ch, cw] = lv.chunk;
  const c0 = Math.max(0, Math.floor(minC)), c1 = Math.min(cols - 1, Math.floor(maxC));
  const r0 = Math.max(0, Math.floor(minR)), r1 = Math.min(rows - 1, Math.floor(maxR));
  if (c0 > c1 || r0 > r1) return null;
  return { cy0: Math.floor(r0 / ch), cy1: Math.floor(r1 / ch), cx0: Math.floor(c0 / cw), cx1: Math.floor(c1 / cw) };
}

export interface ChunkMesh {
  /** Mercator origin (double precision); positions are relative to it. */
  origin: [number, number];
  /** Interleaved [dx, dy, col, row] per vertex, float32. */
  vertices: Float32Array;
  indices: Uint16Array;
}

/**
 * A grid mesh over the valid part of chunk (cy, cx), a vertex every ``step`` pixels:
 * positions in Mercator relative to the first vertex, texcoords in chunk pixels.
 */
export function chunkMesh(lv: LevelGrid, zone: UtmZone, cy: number, cx: number, step = 32): ChunkMesh {
  const [ch, cw] = lv.chunk;
  const h = Math.min(ch, lv.shape[0] - cy * ch);
  const w = Math.min(cw, lv.shape[1] - cx * cw);
  const xs: number[] = [];
  for (let p = 0; p < w; p += step) xs.push(p);
  xs.push(w);
  const ys: number[] = [];
  for (let p = 0; p < h; p += step) ys.push(p);
  ys.push(h);
  const t = lv.transform;
  const verts = new Float32Array(xs.length * ys.length * 4);
  let origin: [number, number] | null = null;
  let k = 0;
  for (const py of ys) {
    for (const px of xs) {
      const col = cx * cw + px, row = cy * ch + py;
      const x = t[0] * col + t[1] * row + t[2];
      const y = t[3] * col + t[4] * row + t[5];
      const [lon, lat] = utmToLonLat(x, y, zone);
      const [mx, my] = lonLatToMercator(lon, lat);
      if (!origin) origin = [mx, my];
      verts[k++] = mx - origin[0];
      verts[k++] = my - origin[1];
      verts[k++] = px;
      verts[k++] = py;
    }
  }
  const nx = xs.length;
  const idx: number[] = [];
  for (let j = 0; j < ys.length - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  return { origin: origin ?? [0, 0], vertices: verts, indices: new Uint16Array(idx) };
}

/**
 * Worst ground error (m) of interpolating the UTM->Mercator map linearly across one
 * mesh cell of ``step`` pixels: the exact Mercator position of a cell centre vs the
 * bilinear mix of the cell's corners.
 */
export function meshError(lv: LevelGrid, zone: UtmZone, row: number, col: number, step: number): number {
  const t = lv.transform;
  const merc = (c: number, r: number) => {
    const [lon, lat] = utmToLonLat(t[0] * c + t[2], t[4] * r + t[5], zone);
    return lonLatToMercator(lon, lat);
  };
  const p00 = merc(col, row), p10 = merc(col + step, row), p01 = merc(col, row + step), p11 = merc(col + step, row + step);
  const exact = merc(col + step / 2, row + step / 2);
  const mix = [(p00[0] + p10[0] + p01[0] + p11[0]) / 4, (p00[1] + p10[1] + p01[1] + p11[1]) / 4];
  const lat = mercatorToLonLat(exact[0], exact[1])[1];
  return Math.hypot(exact[0] - mix[0], exact[1] - mix[1]) * EQUATOR_M * Math.cos((lat * Math.PI) / 180);
}

/** Column-major mat4 ``m`` times translate(ox, oy, 0), in double precision, as float32. */
export function translateMatrix(m: ArrayLike<number>, ox: number, oy: number): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 12; i++) out[i] = m[i];
  for (let i = 0; i < 4; i++) out[12 + i] = m[i] * ox + m[4 + i] * oy + m[12 + i];
  return out;
}
