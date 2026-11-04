/**
 * USDA soils (SSURGO, through Soil Data Access; any origin): map units in the view, classed by what they mean for
 * reading ground motion. Peat can really subside as it drains and oxidises, expansive clay shrinks and swells with
 * moisture, and wet soils change the radar signal. The polygons are simplified on the server to about a pixel.
 */

type Feature = { type: "Feature"; geometry: { type: string; coordinates: unknown } | null; properties: Record<string, unknown> };
type FeatureCollection = { type: "FeatureCollection"; features: Feature[]; notes?: string[] };
import { wktToGeometry } from "./wkt";

export const SDA_URL = "https://sdmdataaccess.sc.egov.usda.gov/Tabular/post.rest";
/** Up to this many map-unit polygons in view, all of them come; above it, only those big enough to see (polygonFilter). */
export const SOIL_POLYGON_LIMIT = 4000;
/** Above this many polygons in view, ask to zoom in: the survey takes too long to search. */
export const SOIL_POLYGON_MAX = 1_000_000;
/** Polygons narrower than this on screen are dropped in wide views: about 6,000 stay at any width from 4° to 16°. */
const SMALL_POLYGON_PIXELS = 6;

export const SOIL_CLASSES: [string, string][] = [
  ["Organic (peat, muck)", "#a21caf"],
  ["Expansive clay", "#ea580c"],
  ["Wet (hydric)", "#0284c7"],
  ["Other soil", "#a3a3a3"],
];

export interface SoilAttributes {
  taxorder?: string | null;
  /** Largest linear extensibility (%) in the top 150 cm: shrink-swell. */
  lep?: number | null;
  /** Largest organic matter (%) in the top 50 cm. */
  om?: number | null;
  /** Share of the map unit that is hydric (%). */
  hydric?: number | null;
}

/** The class a map unit's dominant soil falls in; the thresholds are NRCS's (LEP 6 % = high shrink-swell). */
export function soilClass(a: SoilAttributes): string {
  if (a.taxorder === "Histosols" || (a.om ?? 0) >= 20) return "Organic (peat, muck)";
  if (a.taxorder === "Vertisols" || (a.lep ?? 0) >= 6) return "Expansive clay";
  if ((a.hydric ?? 0) >= 66) return "Wet (hydric)";
  return "Other soil";
}

async function sda(query: string, signal?: AbortSignal): Promise<Record<string, string | null>[]> {
  const r = await fetch(SDA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ format: "JSON+COLUMNNAME", query }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
  });
  if (!r.ok) throw new Error(`Soil Data Access answered ${r.status}`);
  const text = await r.text();
  if (!text.trim() || text.trim() === "{}") return []; // what it sends for no rows
  const [columns, ...rows] = (JSON.parse(text) as { Table?: (string | null)[][] }).Table ?? [[]];
  return rows.map((row) => Object.fromEntries(columns.map((c, i) => [c as string, row[i]])));
}

const num = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? null : Number(v));

/** The size filter for a view: nothing up to the limit, then polygons big enough to see, with a note saying so. */
export function polygonFilter(count: number, [w, s, e, n]: [number, number, number, number]): { where: string; notes: string[]; tolerance: string } {
  if (count <= SOIL_POLYGON_LIMIT) return { where: "", notes: [], tolerance: ((e - w) / 2000).toPrecision(2) };
  const side = (SMALL_POLYGON_PIXELS * (e - w)) / 1600;
  const km = side * 111.32 * Math.cos((((s + n) / 2) * Math.PI) / 180);
  return {
    where: `p.mupolygongeo.STArea() > ${(side * side).toExponential(2)}`,
    // outlines at about 2 pixels: finer detail costs frame rate and cannot be seen
    tolerance: ((e - w) / 800).toPrecision(2),
    notes: [`polygons under about ${km < 1 ? km.toFixed(1) : km.toFixed(0)} km across, too small to see at this zoom (zoom in and add the layer again for them)`],
  };
}

const viewWkt = ([w, s, e, n]: [number, number, number, number]) =>
  `POLYGON((${w.toFixed(5)} ${s.toFixed(5)},${e.toFixed(5)} ${s.toFixed(5)},${e.toFixed(5)} ${n.toFixed(5)},${w.toFixed(5)} ${n.toFixed(5)},${w.toFixed(5)} ${s.toFixed(5)}))`;

/** Map units in a view as polygons with their soil properties. Water and other non-soil units are left out. */
export async function soilsInView([w, s, e, n]: [number, number, number, number], signal?: AbortSignal): Promise<FeatureCollection> {
  const keys = `SDA_Get_Mupolygonkey_from_intersection_with_WktWgs84('${viewWkt([w, s, e, n])}')`;
  const [{ n: count }] = await sda(`SELECT COUNT(*) AS n FROM ${keys}`, signal);
  if (Number(count) > SOIL_POLYGON_MAX) throw new Error(`${Number(count).toLocaleString()} soil polygons in view (limit ${SOIL_POLYGON_MAX.toLocaleString()}); zoom in`);
  if (!Number(count)) return { type: "FeatureCollection", features: [] };
  const { where, notes, tolerance } = polygonFilter(Number(count), [w, s, e, n]);
  const polygons = await sda(`SELECT p.mukey, p.mupolygongeo.Reduce(${tolerance}).STAsText() AS wkt FROM ${keys} k JOIN mupolygon p ON p.mupolygonkey = k.mupolygonkey${where ? ` WHERE ${where}` : ""}`, signal);
  const mukeys = [...new Set(polygons.map((p) => p.mukey).filter((k): k is string => /^\d+$/.test(k ?? "")))];
  if (!mukeys.length) return { type: "FeatureCollection", features: [] };
  const attributes = await sda(
    `SELECT mu.mukey, mu.muname, a.hydclprs AS hydric, a.drclassdcd AS drainage, a.flodfreqdcd AS flooding, c.compname, c.taxorder,
       (SELECT MAX(h.lep_r) FROM chorizon h WHERE h.cokey = c.cokey AND h.hzdept_r < 150) AS lep,
       (SELECT MAX(h.om_r) FROM chorizon h WHERE h.cokey = c.cokey AND h.hzdept_r < 50) AS om
     FROM mapunit mu JOIN muaggatt a ON a.mukey = mu.mukey
     JOIN component c ON c.cokey = (SELECT TOP 1 cc.cokey FROM component cc WHERE cc.mukey = mu.mukey ORDER BY cc.comppct_r DESC)
     WHERE mu.mukey IN (${mukeys.join(",")})`,
    signal,
  );
  const byKey = new Map(attributes.map((a) => [a.mukey, a]));
  const features: Feature[] = [];
  for (const p of polygons) {
    const a = byKey.get(p.mukey);
    const geometry = p.wkt ? wktToGeometry(p.wkt) : null;
    if (!a || !geometry || a.compname === "Water") continue;
    const hydric = num(a.hydric);
    const lep = num(a.lep);
    const om = num(a.om);
    features.push({
      type: "Feature",
      geometry: geometry as Feature["geometry"],
      properties: {
        class: soilClass({ taxorder: a.taxorder, lep, om, hydric }),
        map_unit: a.muname,
        soil: a.compname,
        order: a.taxorder,
        drainage: a.drainage,
        flooding: a.flooding,
        hydric_pct: hydric,
        shrink_swell_lep_pct: lep,
        organic_matter_pct: om,
        mukey: p.mukey,
      },
    });
  }
  return { type: "FeatureCollection", features, ...(notes.length ? { notes } : {}) };
}

export const RECLAIMED_CLASSES: [string, string][] = [
  ["Fill, dredged or made land", "#b45309"],
  ["Drained peat or muck", "#a21caf"],
  ["Drained wetland soil", "#0284c7"],
  ["Urban land on wet or organic ground", "#475569"],
];

/** Terms that find candidates in the survey; reclaimedClass decides, by whole words. */
const RECLAIMED_SQL = ["fill", "made land", "dredg", "spoil", "dump", "udorthent", "arents", "drained", "diked", "urban land"]
  .map((term) => `mu.muname LIKE '%${term}%'`)
  .join(" OR ");

/**
 * What a map unit's name says about ground that people built up or drained, both of which can compact and subside;
 * null if it says neither. Plain urban land counts only on recorded wet or organic ground, as most of it is not reclaimed.
 */
export function reclaimedClass(muname: string, hydricPct: number | null = null): string | null {
  const name = muname.toLowerCase();
  if (/^water\b/.test(name)) return null;
  if (/\b(fill|fills|filled|landfill|made land|dredged?|spoils?|dumps?|udorthents|arents)\b/.test(name)) return "Fill, dredged or made land";
  const drained = /\b(drained|diked)\b/.test(name.replace(/\b(poorly|well|moderately|somewhat|excessively|very)\s+drained\b/g, ""));
  if (drained) return /\b(muck|mucky|peat|peaty)\b/.test(name) ? "Drained peat or muck" : "Drained wetland soil";
  if (/\burban land\b/.test(name) && (/\b(wet|organic) substratum\b/.test(name) || (hydricPct ?? 0) >= 50)) return "Urban land on wet or organic ground";
  return null;
}

/** Map units in a view that the soil survey records as filled, dredged, made or drained, as polygons. */
export async function reclaimedInView(view: [number, number, number, number], signal?: AbortSignal): Promise<FeatureCollection> {
  const units = await sda(
    `SELECT mu.mukey, mu.muname, a.hydclprs AS hydric, a.drclassdcd AS drainage
     FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('${viewWkt(view)}') k
     JOIN mapunit mu ON mu.mukey = k.mukey JOIN muaggatt a ON a.mukey = mu.mukey
     WHERE ${RECLAIMED_SQL}`,
    signal,
  );
  const classes = new Map<string, { kind: string; unit: Record<string, string | null> }>();
  for (const unit of units) {
    const kind = reclaimedClass(unit.muname ?? "", num(unit.hydric));
    if (kind && /^\d+$/.test(unit.mukey ?? "")) classes.set(unit.mukey!, { kind, unit });
  }
  if (!classes.size) return { type: "FeatureCollection", features: [] };
  const from = `FROM SDA_Get_Mupolygonkey_from_intersection_with_WktWgs84('${viewWkt(view)}') k JOIN mupolygon p ON p.mupolygonkey = k.mupolygonkey WHERE p.mukey IN (${[...classes.keys()].join(",")})`;
  const [{ n: count }] = await sda(`SELECT COUNT(*) AS n ${from}`, signal);
  if (Number(count) > SOIL_POLYGON_MAX) throw new Error(`${Number(count).toLocaleString()} polygons in view (limit ${SOIL_POLYGON_MAX.toLocaleString()}); zoom in`);
  const { where, notes, tolerance } = polygonFilter(Number(count), view);
  const polygons = await sda(`SELECT p.mukey, p.mupolygongeo.Reduce(${tolerance}).STAsText() AS wkt ${from}${where ? ` AND ${where}` : ""}`, signal);
  const features: Feature[] = [];
  for (const p of polygons) {
    const hit = classes.get(p.mukey ?? "");
    const geometry = p.wkt ? wktToGeometry(p.wkt) : null;
    if (!hit || !geometry) continue;
    features.push({
      type: "Feature",
      geometry: geometry as Feature["geometry"],
      properties: { class: hit.kind, map_unit: hit.unit.muname, drainage: hit.unit.drainage, hydric_pct: num(hit.unit.hydric), mukey: p.mukey },
    });
  }
  return { type: "FeatureCollection", features, ...(notes.length ? { notes } : {}) };
}
