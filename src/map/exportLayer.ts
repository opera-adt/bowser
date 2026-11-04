/** Export a vector layer's features to a local file: GeoJSON, CSV (points: lon, lat + attributes), KML or a zipped Shapefile. */
import { toShapefileZip } from "./shapefile";

type Feature = { type: "Feature"; geometry: { type: string; coordinates?: unknown } | null; properties?: Record<string, unknown> | null };

export type ExportFormat = "geojson" | "csv" | "kml" | "shapefile";

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function toGeoJson(features: Feature[]): string {
  return JSON.stringify({ type: "FeatureCollection", features }, null, 1);
}

/** One row per feature: lon/lat of points (or the first vertex), then every attribute. */
export function toCsv(features: Feature[]): string {
  const keys = [...new Set(features.flatMap((f) => Object.keys(f.properties ?? {})))].filter((k) => typeof features.find((f) => f.properties?.[k] !== undefined)?.properties?.[k] !== "object");
  const cell = (v: unknown) => {
    const t = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const first = (c: unknown): number[] | null => (Array.isArray(c) && typeof c[0] === "number" ? (c as number[]) : Array.isArray(c) && c.length ? first(c[0]) : null);
  const rows = features.map((f) => {
    const xy = first(f.geometry?.coordinates) ?? [NaN, NaN];
    return [xy[0], xy[1], f.geometry?.type ?? "", ...keys.map((k) => f.properties?.[k])].map(cell).join(",");
  });
  return [["lon", "lat", "geometry", ...keys].map(cell).join(","), ...rows].join("\n") + "\n";
}

function kmlGeometry(g: Feature["geometry"]): string {
  if (!g) return "";
  const c = g.coordinates as never;
  const xy = (p: number[]) => `${p[0]},${p[1]}`;
  const ring = (r: number[][]) => `<LinearRing><coordinates>${r.map(xy).join(" ")}</coordinates></LinearRing>`;
  const poly = (p: number[][][]) => `<Polygon><outerBoundaryIs>${ring(p[0])}</outerBoundaryIs>${p.slice(1).map((h) => `<innerBoundaryIs>${ring(h)}</innerBoundaryIs>`).join("")}</Polygon>`;
  switch (g.type) {
    case "Point":
      return `<Point><coordinates>${xy(c)}</coordinates></Point>`;
    case "LineString":
      return `<LineString><coordinates>${(c as number[][]).map(xy).join(" ")}</coordinates></LineString>`;
    case "Polygon":
      return poly(c);
    case "MultiPoint":
      return `<MultiGeometry>${(c as number[][]).map((p) => `<Point><coordinates>${xy(p)}</coordinates></Point>`).join("")}</MultiGeometry>`;
    case "MultiLineString":
      return `<MultiGeometry>${(c as number[][][]).map((l) => `<LineString><coordinates>${l.map(xy).join(" ")}</coordinates></LineString>`).join("")}</MultiGeometry>`;
    case "MultiPolygon":
      return `<MultiGeometry>${(c as number[][][][]).map(poly).join("")}</MultiGeometry>`;
    default:
      return "";
  }
}

export function toKml(features: Feature[], name: string): string {
  const marks = features.map((f) => {
    const p = f.properties ?? {};
    const title = p.name ?? p.label ?? p.text ?? p.title ?? "";
    const data = Object.entries(p)
      .filter(([, v]) => typeof v !== "object" || v === null)
      .map(([k, v]) => `<Data name="${esc(k)}"><value>${esc(v)}</value></Data>`)
      .join("");
    return `<Placemark><name>${esc(title)}</name><ExtendedData>${data}</ExtendedData>${kmlGeometry(f.geometry)}</Placemark>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(name)}</name>${marks.join("")}</Document></kml>\n`;
}

export function slugName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "layer";
}

export function downloadLayer(name: string, features: Feature[], format: ExportFormat): void {
  const [data, type, ext]: [string | Uint8Array, string, string] =
    format === "csv"
      ? [toCsv(features), "text/csv", "csv"]
      : format === "kml"
        ? [toKml(features, name), "application/vnd.google-earth.kml+xml", "kml"]
        : format === "shapefile"
          ? [toShapefileZip(features, slugName(name).replace(/-/g, "_")), "application/zip", "zip"]
          : [toGeoJson(features), "application/geo+json", "geojson"];
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data as BlobPart], { type }));
  a.download = `${slugName(name)}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
