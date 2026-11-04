import { afterEach, describe, expect, it, vi } from "vitest";
import { RECLAIMED_CLASSES, SOIL_CLASSES, SOIL_POLYGON_LIMIT, SOIL_POLYGON_MAX, polygonFilter, reclaimedClass, reclaimedInView, soilClass, soilsInView } from "./soils";

const view: [number, number, number, number] = [-121.6, 38.0, -121.5, 38.1];
const table = (...rows: unknown[][]) => new Response(JSON.stringify({ Table: rows }));
const ATTR = ["mukey", "muname", "hydric", "drainage", "flooding", "compname", "taxorder", "lep", "om"];

/** Soil Data Access stand-in: answers by which of the three queries it was sent. */
function stubSda(count: number, polygons: unknown[][], attributes: unknown[][]) {
  const queries: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_u: unknown, o: RequestInit) => {
    const q = JSON.parse(o.body as string).query as string;
    queries.push(q);
    if (q.includes("COUNT(*)")) return table(["n"], [String(count)]);
    if (q.includes("STAsText")) return table(["mukey", "wkt"], ...polygons);
    return table(ATTR, ...attributes);
  }));
  return queries;
}

describe("soilClass", () => {
  it.each([
    [{ taxorder: "Histosols" }, "Organic (peat, muck)"],
    [{ om: 44 }, "Organic (peat, muck)"],
    [{ taxorder: "Vertisols" }, "Expansive clay"],
    [{ lep: 7.5 }, "Expansive clay"],
    [{ hydric: 100 }, "Wet (hydric)"],
    [{ hydric: 30, lep: 2, om: 1, taxorder: "Alfisols" }, "Other soil"],
    [{}, "Other soil"],
  ])("%j is %s", (a, c) => {
    expect(soilClass(a)).toBe(c);
  });

  it("peat wins over the other classes: it is what subsides", () => {
    expect(soilClass({ taxorder: "Histosols", lep: 9, hydric: 100 })).toBe("Organic (peat, muck)");
  });

  it("every class has a colour", () => {
    expect(SOIL_CLASSES.map(([c]) => c)).toEqual(["Organic (peat, muck)", "Expansive clay", "Wet (hydric)", "Other soil"]);
  });
});

describe("soilsInView", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("joins polygons with their soil, classed, and leaves water out", async () => {
    stubSda(2, [["1", "POLYGON ((-121.6 38, -121.5 38, -121.5 38.1, -121.6 38))"], ["2", "POLYGON ((-121.6 38, -121.5 38, -121.5 38.1, -121.6 38))"]], [
      ["1", "Rindge muck", "100", "Very poorly drained", "None", "Rindge", "Histosols", null, "44"],
      ["2", "Water", "0", null, null, "Water", null, null, null],
    ]);
    const fc = await soilsInView(view);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry?.type).toBe("Polygon");
    expect(fc.features[0].properties).toMatchObject({ class: "Organic (peat, muck)", map_unit: "Rindge muck", organic_matter_pct: 44, shrink_swell_lep_pct: null, hydric_pct: 100 });
  });

  it("refuses a view with too many polygons, before downloading them", async () => {
    const queries = stubSda(SOIL_POLYGON_MAX + 1, [], []);
    await expect(soilsInView(view)).rejects.toThrow("zoom in");
    expect(queries).toHaveLength(1);
  });

  it("returns nothing where there is no soil data", async () => {
    const queries = stubSda(0, [], []);
    expect((await soilsInView(view)).features).toEqual([]);
    expect(queries).toHaveLength(1);
  });

  it("skips a polygon that simplified away, and map keys that are not numbers", async () => {
    const queries = stubSda(2, [["1", null], ["1'); DROP", "POLYGON ((0 0, 1 0, 1 1, 0 0))"]], [["1", "A", "0", null, null, "A", null, null, null]]);
    expect((await soilsInView(view)).features).toEqual([]);
    expect(queries[2]).toContain("IN (1)");
  });

  it("reports the service's refusal, and reads its empty answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    await expect(soilsInView(view)).rejects.toThrow("Soil Data Access answered 500");
  });
});

describe("polygonFilter", () => {
  const wide: [number, number, number, number] = [-121, 35, -117, 37.4];

  it("keeps everything up to the limit", () => {
    expect(polygonFilter(SOIL_POLYGON_LIMIT, wide)).toEqual({ where: "", notes: [], tolerance: "0.0020" });
  });

  it("above it, drops what is too small to see, and says so", () => {
    const { where, notes, tolerance } = polygonFilter(82_504, wide);
    expect(where).toMatch(/^p\.mupolygongeo\.STArea\(\) > 2\.25e-4$/);
    expect(notes[0]).toContain("under about 1 km across");
    expect(tolerance).toBe("0.0050");
  });
});

describe("soilsInView in a wide view", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks only for polygons big enough to see and reports the rest", async () => {
    const queries = stubSda(82_504, [["1", "POLYGON ((-121 35, -117 35, -117 37, -121 35))"]], [["1", "Rindge muck", "100", "Very poorly drained", "None", "Rindge", "Histosols", null, "44"]]);
    const fc = await soilsInView([-121, 35, -117, 37.4]);
    expect(queries[1]).toContain("WHERE p.mupolygongeo.STArea() >");
    expect(fc.features).toHaveLength(1);
    expect(fc.notes?.[0]).toContain("too small to see");
  });
});

describe("reclaimedClass", () => {
  it.each([
    ["Aquents, dredged, frequently flooded", 100, "Fill, dredged or made land"],
    ["Cut and fill land-Diablo complex, 9 to 30 percent slopes", 0, "Fill, dredged or made land"],
    ["Made land", 0, "Fill, dredged or made land"],
    ["Dumps", 100, "Fill, dredged or made land"],
    ["Udorthents, limestone substratum-Urban land complex, 0 to 2 percent slopes", 5, "Fill, dredged or made land"],
    ["Arents-Urban land complex, organic substratum", 0, "Fill, dredged or made land"],
    ["Rindge muck, 0 to 2 percent slopes, partially drained, MLRA 16", 100, "Drained peat or muck"],
    ["Pahokee muck, drained, 0 to 1 percent slopes", 100, "Drained peat or muck"],
    ["Ryde silt loam, partially drained, 0 to 2 percent slopes, MLRA 16", 100, "Drained wetland soil"],
    ["Urban land, wet substratum", 0, "Urban land on wet or organic ground"],
    ["Urban land", 100, "Urban land on wet or organic ground"],
  ])("%s is %s", (name, hydric, kind) => {
    expect(reclaimedClass(name, hydric)).toBe(kind);
    expect(RECLAIMED_CLASSES.map(([c]) => c)).toContain(kind);
  });

  it.each([
    ["Urban land", 6],
    ["Merrimac-Urban land complex, 0 to 8 percent slopes", 0],
    ["Fillmore silt loam", 0],
    ["Millfield loam", 0],
    ["Water, dredge channel, more than 2 meter water depth", 0],
    ["Parents loam, moderately well drained", 0],
    ["Sharkey clay, poorly drained", 100],
  ])("%s is not reclaimed", (name, hydric) => {
    expect(reclaimedClass(name, hydric)).toBeNull();
  });
});

describe("reclaimedInView", () => {
  afterEach(() => vi.unstubAllGlobals());

  const stub = (units: unknown[][], polygons: unknown[][], count = polygons.length) => {
    const queries: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, o: RequestInit) => {
      const q = JSON.parse(o.body as string).query as string;
      queries.push(q);
      if (q.includes("COUNT(*)")) return table(["n"], [String(count)]);
      if (q.includes("STAsText")) return table(["mukey", "wkt"], ...polygons);
      return table(["mukey", "muname", "hydric", "drainage"], ...units);
    }));
    return queries;
  };

  it("draws only the units its class test accepts, whatever the name search found", async () => {
    const queries = stub(
      [["1", "Aquents, dredged", "90", "Very poorly drained"], ["2", "Fillmore silt loam", "0", "Well drained"]],
      [["1", "POLYGON ((-121.6 38, -121.5 38, -121.5 38.1, -121.6 38))"]],
    );
    const fc = await reclaimedInView(view);
    expect(queries[1]).toContain("p.mukey IN (1)");
    expect(fc.features[0].properties).toMatchObject({ class: "Fill, dredged or made land", map_unit: "Aquents, dredged", hydric_pct: 90 });
  });

  it("asks for no polygons when nothing in view is reclaimed", async () => {
    const queries = stub([["2", "Fillmore silt loam", "0", "Well drained"]], []);
    expect((await reclaimedInView(view)).features).toEqual([]);
    expect(queries).toHaveLength(1);
  });

  it("thins a wide view as the soils layer does", async () => {
    const queries = stub([["1", "Made land", "0", null]], [], 50_000);
    const fc = await reclaimedInView([-121, 35, -117, 37.4]);
    expect(queries[2]).toContain("AND p.mupolygongeo.STArea() >");
    expect(fc.notes?.[0]).toContain("too small to see");
  });
});
