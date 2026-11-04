/**
 * Readers for vector files dropped on the map: GeoJSON, CSV/TSV with coordinate
 * columns, KML placemarks and GPX waypoints, tracks and routes. Each turns text into a
 * GeoJSON FeatureCollection (WGS84 lon/lat) or throws an Error with a message for the user.
 * Pure functions (DOMParser for the XML formats), so they run in tests as in the browser.
 */

export type Position = number[];
export interface Geometry {
  type: "Point" | "LineString" | "Polygon" | "MultiPoint" | "MultiLineString" | "MultiPolygon";
  coordinates: unknown;
}
export interface Feature {
  type: "Feature";
  geometry: Geometry | null;
  properties: Record<string, unknown>;
}
export interface FeatureCollection {
  type: "FeatureCollection";
  features: Feature[];
}

const fc = (features: Feature[]): FeatureCollection => ({ type: "FeatureCollection", features });

/* ---------- GeoJSON ---------- */

const GEOMETRY_TYPES = new Set(["Point", "LineString", "Polygon", "MultiPoint", "MultiLineString", "MultiPolygon", "GeometryCollection"]);

/** A FeatureCollection, a Feature, a bare geometry or an array of features. */
export function parseGeoJson(text: string): FeatureCollection {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`not valid JSON (${(err as Error).message})`);
  }
  const asFeature = (x: unknown): Feature[] => {
    const o = x as { type?: string; geometry?: unknown; properties?: unknown; geometries?: unknown[] };
    if (o?.type === "Feature") return [{ type: "Feature", geometry: (o.geometry ?? null) as Geometry | null, properties: (o.properties ?? {}) as Record<string, unknown> }];
    if (o?.type === "GeometryCollection") return (o.geometries ?? []).flatMap(asFeature);
    if (o?.type && GEOMETRY_TYPES.has(o.type)) return [{ type: "Feature", geometry: o as Geometry, properties: {} }];
    return [];
  };
  const o = data as { type?: string; features?: unknown[] };
  let features: Feature[];
  if (Array.isArray(data)) features = data.flatMap(asFeature);
  else if (o?.type === "FeatureCollection" && Array.isArray(o.features)) features = o.features.flatMap(asFeature);
  else features = asFeature(data);
  if (!features.length) throw new Error("no GeoJSON features found");
  return fc(features);
}

/* ---------- CSV / TSV ---------- */

const LON_NAMES = ["lon", "lng", "long", "longitude", "x", "lon_deg", "longitude_deg"];
const LAT_NAMES = ["lat", "latitude", "y", "lat_deg", "latitude_deg"];

/** Split delimited text into rows of fields (double-quoted fields may hold the delimiter, quotes and newlines). */
export function splitDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delim) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

function guessDelimiter(header: string): string {
  const counts = ["\t", ",", ";", "|"].map((d) => [d, header.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

/** Points from a table with lon/lat (or longitude/latitude, lng, x/y) columns; other columns become properties. */
export function parseCsv(text: string, delimiter?: string): FeatureCollection {
  const body = text.replace(/^﻿/, "");
  const firstLine = body.split(/\r?\n/, 1)[0] ?? "";
  const rows = splitDelimited(body, delimiter ?? guessDelimiter(firstLine));
  if (rows.length < 2) throw new Error("the table has no data rows");
  const header = rows[0].map((h) => h.trim());
  const lower = header.map((h) => h.toLowerCase());
  const find = (names: string[]) => {
    for (const n of names) {
      const i = lower.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const xi = find(LON_NAMES);
  const yi = find(LAT_NAMES);
  if (xi < 0 || yi < 0) throw new Error(`no longitude/latitude columns (looked for lon/lat, longitude/latitude, x/y; found: ${header.join(", ")})`);
  const features: Feature[] = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const x = Number(r[xi]);
    const y = Number(r[yi]);
    if (!r[xi]?.trim() || !r[yi]?.trim() || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 360 || Math.abs(y) > 90) {
      skipped++;
      continue;
    }
    const properties: Record<string, unknown> = {};
    header.forEach((h, i) => {
      if (i === xi || i === yi || !h) return;
      const v = (r[i] ?? "").trim();
      properties[h] = v !== "" && Number.isFinite(Number(v)) ? Number(v) : v;
    });
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: [x > 180 ? x - 360 : x, y] }, properties });
  }
  if (!features.length) throw new Error(`no rows with valid coordinates (${skipped} skipped)`);
  return fc(features);
}

/* ---------- XML helpers ---------- */

function parseXml(text: string, what: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error(`not valid ${what} (XML parse error)`);
  return doc;
}

/** Elements by local name, whatever the namespace. */
const byTag = (el: Element | Document, name: string): Element[] => Array.from(el.getElementsByTagNameNS("*", name));
const children = (el: Element, name: string): Element[] => Array.from(el.children).filter((c) => c.localName === name);
const childText = (el: Element, name: string): string | undefined => children(el, name)[0]?.textContent?.trim() || undefined;

/* ---------- KML ---------- */

function kmlCoords(el: Element | undefined): Position[] {
  const text = el ? byTag(el, "coordinates")[0]?.textContent ?? "" : "";
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.split(",").map(Number))
    .filter((p) => p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map((p) => (p.length > 2 && Number.isFinite(p[2]) ? [p[0], p[1], p[2]] : [p[0], p[1]]));
}

function kmlGeometries(el: Element): Geometry[] {
  const out: Geometry[] = [];
  for (const g of Array.from(el.children)) {
    switch (g.localName) {
      case "Point": {
        const c = kmlCoords(g);
        if (c.length) out.push({ type: "Point", coordinates: c[0] });
        break;
      }
      case "LineString": {
        const c = kmlCoords(g);
        if (c.length >= 2) out.push({ type: "LineString", coordinates: c });
        break;
      }
      case "Polygon": {
        const outer = kmlCoords(children(g, "outerBoundaryIs")[0]);
        const inner = children(g, "innerBoundaryIs").map((b) => kmlCoords(b));
        if (outer.length >= 4) out.push({ type: "Polygon", coordinates: [outer, ...inner.filter((r) => r.length >= 4)] });
        break;
      }
      case "MultiGeometry":
        out.push(...kmlGeometries(g));
        break;
    }
  }
  return out;
}

/** Placemarks with Point, LineString, Polygon or MultiGeometry; name, description and ExtendedData as properties. */
export function parseKml(text: string): FeatureCollection {
  const doc = parseXml(text, "KML");
  const features: Feature[] = [];
  for (const pm of byTag(doc, "Placemark")) {
    const properties: Record<string, unknown> = {};
    const name = childText(pm, "name");
    const description = childText(pm, "description");
    if (name) properties.name = name;
    if (description) properties.description = description;
    for (const d of byTag(pm, "Data")) {
      const key = d.getAttribute("name");
      if (key) properties[key] = childText(d, "value") ?? "";
    }
    for (const d of byTag(pm, "SimpleData")) {
      const key = d.getAttribute("name");
      if (key) properties[key] = d.textContent?.trim() ?? "";
    }
    // One feature per geometry (a MultiGeometry of mixed types becomes several features).
    for (const geometry of kmlGeometries(pm)) features.push({ type: "Feature", geometry, properties: { ...properties } });
  }
  if (!features.length) throw new Error("no placemarks with Point, LineString or Polygon geometry");
  return fc(features);
}

/* ---------- GPX ---------- */

function gpxPoint(el: Element): Position | null {
  const lon = Number(el.getAttribute("lon"));
  const lat = Number(el.getAttribute("lat"));
  if (!el.hasAttribute("lon") || !el.hasAttribute("lat") || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const ele = Number(childText(el, "ele"));
  return Number.isFinite(ele) && childText(el, "ele") !== undefined ? [lon, lat, ele] : [lon, lat];
}

function gpxProps(el: Element, type: string): Record<string, unknown> {
  const p: Record<string, unknown> = { gpx_type: type };
  for (const k of ["name", "desc", "cmt", "time", "type", "sym"]) {
    const v = childText(el, k);
    if (v !== undefined) p[k] = v;
  }
  const ele = childText(el, "ele");
  if (ele !== undefined && Number.isFinite(Number(ele))) p.ele = Number(ele);
  return p;
}

const pts = (els: Element[]): Position[] => els.map(gpxPoint).filter((p): p is Position => p !== null);

/** Waypoints (points), tracks (one line per track, multi-line if it has several segments) and routes (lines). */
export function parseGpx(text: string): FeatureCollection {
  const doc = parseXml(text, "GPX");
  const features: Feature[] = [];
  for (const w of byTag(doc, "wpt")) {
    const p = gpxPoint(w);
    if (p) features.push({ type: "Feature", geometry: { type: "Point", coordinates: p }, properties: gpxProps(w, "waypoint") });
  }
  for (const t of byTag(doc, "trk")) {
    const segs = children(t, "trkseg")
      .map((s) => pts(children(s, "trkpt")))
      .filter((s) => s.length >= 2);
    if (!segs.length) continue;
    const geometry: Geometry = segs.length === 1 ? { type: "LineString", coordinates: segs[0] } : { type: "MultiLineString", coordinates: segs };
    features.push({ type: "Feature", geometry, properties: gpxProps(t, "track") });
  }
  for (const r of byTag(doc, "rte")) {
    const line = pts(children(r, "rtept"));
    if (line.length >= 2) features.push({ type: "Feature", geometry: { type: "LineString", coordinates: line }, properties: gpxProps(r, "route") });
  }
  if (!features.length) throw new Error("no waypoints, tracks or routes");
  return fc(features);
}

/* ---------- shared ---------- */

/** [west, south, east, north] of every coordinate in the collection, or null if it has none. */
export function featureBounds(data: { features: unknown[] }): [number, number, number, number] | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  const visit = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number") {
      const [x, y] = c as number[];
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      w = Math.min(w, x);
      e = Math.max(e, x);
      s = Math.min(s, y);
      n = Math.max(n, y);
    } else for (const x of c) visit(x);
  };
  const visitGeom = (g: unknown): void => {
    const o = g as { coordinates?: unknown; geometries?: unknown[] } | null;
    if (!o) return;
    if (o.geometries) o.geometries.forEach(visitGeom);
    else visit(o.coordinates);
  };
  for (const f of data.features as { geometry?: unknown }[]) visitGeom(f?.geometry);
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

export type FileKind = "geojson" | "csv" | "tsv" | "kml" | "kmz" | "gpx" | "shapefile-zip" | "shapefile-part" | "geotiff" | "unknown";

/** What a file is, from its name. */
export function fileKind(name: string): FileKind {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (ext === "geojson" || ext === "json") return "geojson";
  if (ext === "csv" || ext === "txt") return "csv";
  if (ext === "tsv" || ext === "tab") return "tsv";
  if (ext === "kml") return "kml";
  if (ext === "kmz") return "kmz";
  if (ext === "gpx") return "gpx";
  if (ext === "zip") return "shapefile-zip";
  if (["shp", "dbf", "prj", "cpg", "shx"].includes(ext)) return "shapefile-part";
  if (ext === "tif" || ext === "tiff" || ext === "gtiff" || ext === "cog") return "geotiff";
  return "unknown";
}
