/** Minimal WKT -> GeoJSON for what /frame_intersection returns (POLYGON, MULTIPOLYGON, POINT). */

export type Geometry =
  | { type: "Point"; coordinates: number[] }
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

function ring(text: string): number[][] {
  return text
    .split(",")
    .map((pair) => pair.trim().split(/\s+/).map(Number))
    .filter((xy) => xy.length >= 2 && xy.every(Number.isFinite));
}

/** Split "(a),(b)" at top-level commas between parenthesised groups. */
function groups(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) out.push(text.slice(start, i));
    }
  }
  return out;
}

export function wktToGeometry(wkt: string): Geometry | null {
  const match = /^\s*(POINT|POLYGON|MULTIPOLYGON)\s*(?:Z\s*)?\((.*)\)\s*$/is.exec(wkt);
  if (!match) return null;
  const kind = match[1].toUpperCase();
  const body = match[2];
  if (kind === "POINT") {
    const [xy] = ring(body);
    return xy ? { type: "Point", coordinates: xy } : null;
  }
  if (kind === "POLYGON") {
    // body: "(ring), (ring)"
    return { type: "Polygon", coordinates: groups(body).map(ring) };
  }
  // body: "((ring), (ring)), ((ring))"
  return { type: "MultiPolygon", coordinates: groups(body).map((polygon) => groups(polygon).map(ring)) };
}
