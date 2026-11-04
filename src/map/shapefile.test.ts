import { describe, expect, it } from "vitest";
import shp from "shpjs";
import { crc32, splitByKind, toShapefileZip } from "./shapefile";

const features = [
  { type: "Feature" as const, geometry: { type: "Point", coordinates: [-117.6, 35.7] }, properties: { name: "Ridgecrest", mag: 7.1, depth: 8, felt: true, "long field name é": "ünïcode" } },
  { type: "Feature" as const, geometry: { type: "Point", coordinates: [-117.5, 35.8] }, properties: { name: "B", mag: 4, depth: 12, felt: false } },
  { type: "Feature" as const, geometry: { type: "LineString", coordinates: [[-117, 35], [-116, 36]] }, properties: { id: 1 } },
  {
    type: "Feature" as const,
    // GeoJSON: outer ring counter-clockwise, hole clockwise
    geometry: { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[2, 2], [2, 4], [4, 4], [4, 2], [2, 2]]] },
    properties: { id: 2 },
  },
  { type: "Feature" as const, geometry: null, properties: { skipped: true } },
];

describe("shapefile writer", () => {
  it("crc32 matches the reference value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("splits by geometry kind and orients rings the shapefile way", () => {
    const k = splitByKind(features);
    expect(k.points).toHaveLength(2);
    expect(k.lines).toHaveLength(1);
    expect(k.polygons).toHaveLength(1);
    const [outer, hole] = k.polygons[0].parts;
    const area = (r: number[][]) => r.reduce((a, p, i) => { const q = r[(i + 1) % r.length]; return a + (p[0] * q[1] - q[0] * p[1]); }, 0) / 2;
    expect(area(outer)).toBeLessThan(0); // clockwise
    expect(area(hole)).toBeGreaterThan(0); // counter-clockwise
  });

  it("round-trips through shpjs (one shapefile per geometry type)", async () => {
    const zip = toShapefileZip(features, "quakes");
    const out = (await shp(zip.buffer as ArrayBuffer)) as unknown as { fileName: string; features: { geometry: { type: string; coordinates: unknown }; properties: Record<string, unknown> }[] }[];
    const by = Object.fromEntries(out.map((l) => [l.fileName, l]));
    expect(Object.keys(by).sort()).toEqual(["quakes_lines", "quakes_points", "quakes_polygons"]);
    const p = by.quakes_points.features;
    expect(p[0].geometry.coordinates).toEqual([-117.6, 35.7]);
    expect(p[0].properties.name).toBe("Ridgecrest");
    expect(p[0].properties.mag).toBeCloseTo(7.1);
    expect(p[1].properties.depth).toBe(12);
    expect(p[0].properties.felt).toBe(true);
    expect(p[1].properties.felt).toBe(false);
    expect(Object.values(p[0].properties)).toContain("ünïcode");
    const line = by.quakes_lines.features[0].geometry.coordinates as number[][];
    line.flat().forEach((v, i) => expect(v).toBeCloseTo([-117, 35, -116, 36][i], 9));
    const poly = by.quakes_polygons.features[0].geometry;
    expect(poly.type).toBe("Polygon");
    expect((poly.coordinates as unknown[]).length).toBe(2);
  });

  it("a single-type layer keeps the plain name; nothing to write is an error", async () => {
    const out = (await shp(toShapefileZip(features.slice(0, 2), "pts").buffer as ArrayBuffer)) as unknown as { fileName: string; features: unknown[] };
    expect(out.fileName).toBe("pts");
    expect(out.features).toHaveLength(2);
    expect(() => toShapefileZip([features[4]], "x")).toThrow(/no point, line or polygon/);
  });
});
