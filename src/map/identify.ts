/**
 * What the identify (pointer) tool reports at a click: the attributes of features under it,
 * and, for the services that are on, the geologic unit (Macrostrat) and the land cover class.
 * Pure parsing here; the requests are made in components/identifyTool.ts.
 */
import { LAND_COVER_CLASSES, LAND_COVER_URL } from './contextLayers';

export interface IdentifyItem {
  title: string;
  rows: [string, string][];
  color?: string;
  link?: string;
}

export interface IdentifyResult {
  lngLat: [number, number];
  items: IdentifyItem[];
  pending: string[];
}

export const MACROSTRAT_POINT = 'https://macrostrat.org/api/v2/geologic_units/map';
const SCALE_ORDER = ['large', 'medium', 'small', 'tiny'];

/** The land cover service's pixel values (Impact Observatory 9-class map). */
const LAND_COVER_VALUES: Record<number, string> = {
  1: 'Water', 2: 'Trees', 4: 'Flooded vegetation', 5: 'Crops', 7: 'Built area', 8: 'Bare ground', 9: 'Snow / ice', 10: 'Clouds', 11: 'Rangeland',
};

export function landCoverClass(value: unknown): { name: string; color: string } | null {
  const name = LAND_COVER_VALUES[Number(value)];
  if (!name) return null;
  return { name, color: LAND_COVER_CLASSES.find(([n]) => n === name)?.[1] ?? '#999999' };
}

export function landCoverIdentifyUrl(lng: number, lat: number, year: number): string {
  const q = new URLSearchParams({
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint', returnGeometry: 'false', returnCatalogItems: 'false', f: 'json',
    time: `${Date.UTC(year, 0, 1)},${Date.UTC(year, 11, 31, 23, 59, 59)}`,
  });
  return `${LAND_COVER_URL}/identify?${q}`;
}

function unitAge(d: Record<string, unknown>): string {
  const t = Number(d.t_int_age);
  const b = Number(d.b_int_age);
  const range = d.t_int_age != null && d.b_int_age != null && Number.isFinite(t) && Number.isFinite(b) ? ` (${t}–${b} Ma)` : '';
  const interval = d.t_int_name === d.b_int_name ? String(d.t_int_name ?? '') : `${d.b_int_name ?? ''}–${d.t_int_name ?? ''}`;
  return `${interval}${range}`.trim();
}

/** The most detailed geologic unit in a Macrostrat point answer, as an identify item (null: none). */
export function geologyItem(body: unknown): IdentifyItem | null {
  const data = ((body as { success?: { data?: Record<string, unknown>[] } })?.success?.data ?? []);
  const rank = (d: Record<string, unknown>) => {
    const i = SCALE_ORDER.indexOf(String(d.scale));
    return i < 0 ? SCALE_ORDER.length : i;
  };
  const [d] = [...data].sort((a, b) => rank(a) - rank(b));
  if (!d) return null;
  const rows: [string, string][] = [['Unit', String(d.name || d.strat_name || 'unnamed unit')]];
  const age = unitAge(d);
  if (age) rows.push(['Age', age]);
  const lith = String(d.lith || '');
  if (lith) rows.push(['Lithology', lith]);
  const descrip = String(d.descrip || '');
  if (descrip) rows.push(['Description', descrip.length > 240 ? `${descrip.slice(0, 240)}…` : descrip]);
  if (d.scale) rows.push(['Map scale', String(d.scale)]);
  return { title: 'Geology (Macrostrat)', rows, color: typeof d.color === 'string' ? d.color : undefined, link: 'https://macrostrat.org/map' };
}

/** A feature's attributes as rows: plain values only, URLs kept as text. */
export function attributeRows(props: Record<string, unknown> | null | undefined, max = 14): [string, string][] {
  return Object.entries(props ?? {})
    .filter(([, v]) => v !== null && v !== undefined && v !== '' && typeof v !== 'object')
    .slice(0, max)
    .map(([k, v]) => [k, typeof v === 'number' && !Number.isInteger(v) ? String(+v.toPrecision(6)) : String(v)]);
}

/** The overlay id a MapLibre layer id belongs to (overlay-<id>, overlay-<id>-fill/-line/-point). */
export function overlayIdOfLayer(layerId: string): string | null {
  const m = /^overlay-(.+?)(-fill|-line|-point)?$/.exec(layerId);
  // PMTiles vector layers are overlay-<id>__<layer index>-…
  return m ? m[1].replace(/__\d+$/, '') : null;
}
