/**
 * Write GeoJSON features as a zipped ESRI Shapefile (.shp, .shx, .dbf, .prj, .cpg) in the browser.
 * A Shapefile holds one geometry type, so a mixed layer becomes up to three sets of files in the
 * same zip: <name>_points, <name>_lines and <name>_polygons. Coordinates are WGS84 lon/lat; text
 * attributes are UTF-8 (the .cpg says so), at most 254 bytes each.
 */
type Geometry = { type: string; coordinates?: unknown } | null;
type Feature = { type: "Feature"; geometry: Geometry; properties?: Record<string, unknown> | null };

const WGS84_PRJ =
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

type Kind = "points" | "lines" | "polygons";
const SHAPE_TYPE: Record<Kind, number> = { points: 1, lines: 3, polygons: 5 };

type Pt = [number, number];
/** One shapefile record: its parts (a point is one part of one vertex) and the feature's attributes. */
interface Rec {
  parts: Pt[][];
  props: Record<string, unknown>;
}

const xy = (p: unknown): Pt => [Number((p as number[])[0]), Number((p as number[])[1])];

/** Signed area of a ring (> 0: counter-clockwise in lon/lat). */
function ringArea(r: Pt[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2;
}

/** Shapefile rings: outer clockwise, holes counter-clockwise (GeoJSON is the opposite), closed. */
function shpRings(polygon: unknown): Pt[][] {
  return (polygon as unknown[][]).map((ring, k) => {
    const r = ring.map(xy);
    if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push([...r[0]] as Pt);
    const ccw = ringArea(r) > 0;
    const wantCw = k === 0;
    return (wantCw && ccw) || (!wantCw && !ccw) ? r.reverse() : r;
  });
}

/** Sort features into the three shapefile kinds (multi-points become one record per point). */
export function splitByKind(features: Feature[]): Record<Kind, Rec[]> {
  const out: Record<Kind, Rec[]> = { points: [], lines: [], polygons: [] };
  for (const f of features) {
    const g = f.geometry;
    const props = f.properties ?? {};
    if (!g?.coordinates) continue;
    const c = g.coordinates as unknown[];
    switch (g.type) {
      case "Point":
        out.points.push({ parts: [[xy(c)]], props });
        break;
      case "MultiPoint":
        for (const p of c) out.points.push({ parts: [[xy(p)]], props });
        break;
      case "LineString":
        out.lines.push({ parts: [(c as unknown[]).map(xy)], props });
        break;
      case "MultiLineString":
        out.lines.push({ parts: (c as unknown[][]).map((l) => l.map(xy)), props });
        break;
      case "Polygon":
        out.polygons.push({ parts: shpRings(c), props });
        break;
      case "MultiPolygon":
        out.polygons.push({ parts: (c as unknown[]).flatMap(shpRings), props });
        break;
    }
  }
  for (const k of Object.keys(out) as Kind[]) out[k] = out[k].filter((r) => r.parts.every((p) => p.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))));
  return out;
}

function bbox(recs: Rec[]): [number, number, number, number] {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of recs)
    for (const p of r.parts)
      for (const [x, y] of p) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  return recs.length ? [x0, y0, x1, y1] : [0, 0, 0, 0];
}

function header(view: DataView, type: number, bytes: number, box: [number, number, number, number]): void {
  view.setInt32(0, 9994, false);
  view.setInt32(24, bytes / 2, false);
  view.setInt32(28, 1000, true);
  view.setInt32(32, type, true);
  box.forEach((v, i) => view.setFloat64(36 + i * 8, v, true));
}

/** The .shp and .shx of one kind. */
export function writeShp(kind: Kind, recs: Rec[]): { shp: Uint8Array; shx: Uint8Array } {
  const type = SHAPE_TYPE[kind];
  const sizes = recs.map((r) => (kind === "points" ? 20 : 44 + 4 * r.parts.length + 16 * r.parts.reduce((n, p) => n + p.length, 0)));
  const shpBytes = 100 + sizes.reduce((n, s) => n + 8 + s, 0);
  const shp = new DataView(new ArrayBuffer(shpBytes));
  const shx = new DataView(new ArrayBuffer(100 + 8 * recs.length));
  const box = bbox(recs);
  header(shp, type, shpBytes, box);
  header(shx, type, shx.byteLength, box);
  let o = 100;
  recs.forEach((r, i) => {
    shx.setInt32(100 + i * 8, o / 2, false);
    shx.setInt32(104 + i * 8, sizes[i] / 2, false);
    shp.setInt32(o, i + 1, false);
    shp.setInt32(o + 4, sizes[i] / 2, false);
    o += 8;
    shp.setInt32(o, type, true);
    if (kind === "points") {
      shp.setFloat64(o + 4, r.parts[0][0][0], true);
      shp.setFloat64(o + 12, r.parts[0][0][1], true);
      o += 20;
      return;
    }
    bbox([r]).forEach((v, k) => shp.setFloat64(o + 4 + k * 8, v, true));
    const points = r.parts.flat();
    shp.setInt32(o + 36, r.parts.length, true);
    shp.setInt32(o + 40, points.length, true);
    let p = o + 44;
    let start = 0;
    for (const part of r.parts) {
      shp.setInt32(p, start, true);
      start += part.length;
      p += 4;
    }
    for (const [x, y] of points) {
      shp.setFloat64(p, x, true);
      shp.setFloat64(p + 8, y, true);
      p += 16;
    }
    o += sizes[i];
  });
  return { shp: new Uint8Array(shp.buffer), shx: new Uint8Array(shx.buffer) };
}

interface DbfField {
  key: string;
  name: string;
  type: "C" | "N" | "L";
  length: number;
  decimals: number;
}

const enc = new TextEncoder();

/** UTF-8 bytes of `s`, cut to at most `max` bytes without splitting a character. */
function utf8(s: string, max: number): Uint8Array {
  const b = enc.encode(s);
  if (b.length <= max) return b;
  let n = max;
  while (n > 0 && (b[n] & 0xc0) === 0x80) n -= 1;
  return b.subarray(0, n);
}

/** dBase field names: ASCII, at most 10 characters, unique. */
function fieldNames(keys: string[]): string[] {
  const used = new Set<string>();
  return keys.map((k) => {
    const base = (k.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+/, "") || "FIELD").slice(0, 10);
    let name = base;
    for (let i = 1; used.has(name.toUpperCase()); i++) name = `${base.slice(0, 10 - String(i).length)}${i}`;
    used.add(name.toUpperCase());
    return name;
  });
}

function dbfFields(recs: Rec[]): DbfField[] {
  const keys = [...new Set(recs.flatMap((r) => Object.keys(r.props)))].filter((k) => recs.some((r) => r.props[k] !== null && r.props[k] !== undefined && typeof r.props[k] !== "object"));
  const names = fieldNames(keys);
  return keys.map((key, i) => {
    const values = recs.map((r) => r.props[key]).filter((v) => v !== null && v !== undefined && v !== "");
    if (values.length && values.every((v) => typeof v === "boolean")) return { key, name: names[i], type: "L", length: 1, decimals: 0 };
    if (values.length && values.every((v) => typeof v === "number" && Number.isFinite(v))) {
      const nums = values as number[];
      const decimals = nums.every(Number.isInteger) ? 0 : 8;
      const length = Math.min(254, Math.max(...nums.map((v) => v.toFixed(decimals).length), 1));
      return { key, name: names[i], type: "N", length, decimals };
    }
    const length = Math.min(254, Math.max(1, ...recs.map((r) => (r.props[key] === null || r.props[key] === undefined ? 0 : enc.encode(String(r.props[key])).length))));
    return { key, name: names[i], type: "C", length, decimals: 0 };
  });
}

/** The .dbf (dBase III) of the records' attributes. */
export function writeDbf(recs: Rec[]): Uint8Array {
  const fields = dbfFields(recs);
  const headerBytes = 32 + 32 * fields.length + 1;
  const recordBytes = 1 + fields.reduce((n, f) => n + f.length, 0);
  const out = new Uint8Array(headerBytes + recordBytes * recs.length + 1);
  const view = new DataView(out.buffer);
  const now = new Date();
  out[0] = 0x03;
  out.set([now.getFullYear() - 1900, now.getMonth() + 1, now.getDate()], 1);
  view.setUint32(4, recs.length, true);
  view.setUint16(8, headerBytes, true);
  view.setUint16(10, recordBytes, true);
  fields.forEach((f, i) => {
    const at = 32 + i * 32;
    out.set(enc.encode(f.name), at);
    out[at + 11] = f.type.charCodeAt(0);
    out[at + 16] = f.length;
    out[at + 17] = f.decimals;
  });
  out[headerBytes - 1] = 0x0d;
  let o = headerBytes;
  for (const r of recs) {
    out[o] = 0x20; // not deleted
    let p = o + 1;
    for (const f of fields) {
      out.fill(0x20, p, p + f.length);
      const v = r.props[f.key];
      if (v !== null && v !== undefined && v !== "") {
        if (f.type === "N" && typeof v === "number") {
          const s = enc.encode(v.toFixed(f.decimals).slice(0, f.length));
          out.set(s, p + f.length - s.length); // right-aligned
        } else if (f.type === "L") out[p] = v ? 0x54 : 0x46;
        else out.set(utf8(String(v), f.length), p);
      }
      p += f.length;
    }
    o += recordBytes;
  }
  out[out.length - 1] = 0x1a;
  return out;
}

/* ---------- a minimal zip (stored, no compression) ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipStore(files: [string, Uint8Array][]): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // UTF-8 names
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, nameBytes.length, true);
    local.push(new Uint8Array(lh.buffer), nameBytes, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, nameBytes.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const parts = [...local, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of parts) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

/** The zipped Shapefile of `features` (file names start with `base`). Throws if nothing can be written. */
export function toShapefileZip(features: Feature[], base: string): Uint8Array {
  const kinds = splitByKind(features);
  const present = (Object.keys(kinds) as Kind[]).filter((k) => kinds[k].length);
  if (!present.length) throw new Error("no point, line or polygon features to write");
  const files: [string, Uint8Array][] = [];
  for (const k of present) {
    const name = present.length > 1 ? `${base}_${k}` : base;
    const { shp, shx } = writeShp(k, kinds[k]);
    files.push([`${name}.shp`, shp], [`${name}.shx`, shx], [`${name}.dbf`, writeDbf(kinds[k])], [`${name}.prj`, enc.encode(WGS84_PRJ)], [`${name}.cpg`, enc.encode("UTF-8")]);
  }
  return zipStore(files);
}
