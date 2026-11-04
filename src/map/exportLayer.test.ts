import { describe, expect, it } from "vitest";
import { slugName, toCsv, toKml } from "./exportLayer";

const f = [
  { type: "Feature" as const, geometry: { type: "Point", coordinates: [-118.25, 34.05] }, properties: { name: "A, test", n: 1 } },
  { type: "Feature" as const, geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: { name: "area" } },
];

describe("layer export", () => {
  it("writes CSV with lon/lat, geometry type and quoted attributes", () => {
    const csv = toCsv(f).trim().split("\n");
    expect(csv[0]).toBe("lon,lat,geometry,name,n");
    expect(csv[1]).toBe('-118.25,34.05,Point,"A, test",1');
    expect(csv[2]).toBe("0,0,Polygon,area,");
  });
  it("writes KML placemarks with escaped data", () => {
    const kml = toKml(f, "My <layer>");
    expect(kml).toContain("<name>My &lt;layer&gt;</name>");
    expect(kml).toContain("<Point><coordinates>-118.25,34.05</coordinates></Point>");
    expect(kml).toContain("<Polygon><outerBoundaryIs><LinearRing>");
  });
  it("makes file names", () => expect(slugName("Oil and gas wells · map view")).toBe("oil-and-gas-wells-map-view"));
});
