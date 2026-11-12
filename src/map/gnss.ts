/**
 * GNSS (UNR, NA fixed) next to InSAR: a station's motion projected on the radar line of
 * sight, and its record lined up with the InSAR series at that spot. Pure functions,
 * pinned by gnss.test.ts; the GNSS tab fetches through /gnss/stations and /gnss/series.
 */
import type { LosMetadata } from '../types';

export interface GnssStation {
  id: string;
  lon: number;
  lat: number;
  first: number;
  last: number;
  ve_mm_yr: number;
  vn_mm_yr: number;
  vu_mm_yr: number;
  sigma_vu_mm_yr: number;
  /** Read from the user's own file (POST /gnss/custom): rates are a straight-line fit, not MIDAS. */
  custom?: boolean;
}

/** A station read from the user's file: GET /gnss/custom. */
export interface CustomGnssStation extends GnssStation {
  custom: true;
  name: string;
  first_date: string;
  last_date: string;
  rows: number;
  skipped: number;
  units: 'm' | 'mm' | 'cm';
  units_from: 'header' | 'file' | 'option' | 'guessed';
  date_format: string | null;
  components: string[];
  source: string;
  frame: string;
  warnings: string[];
}

/** POST /gnss/custom: what one file gave. */
export interface GnssCsvLoaded {
  file: string;
  rows: number;
  skipped: number;
  stations: CustomGnssStation[];
}

export interface GnssSeries {
  station: string;
  frame: string;
  /** UNR's page for the station; null for a station from the user's file. */
  station_page: string | null;
  dates: string[];
  east_mm: number[];
  north_mm: number[];
  up_mm: number[];
  /** Equipment changes and nearby earthquakes within the record (UNR steps file). */
  steps?: GnssStep[];
  /** How the station is built (UNR monument table); null when UNR doesn't say. */
  monument?: GnssMonument | null;
}

export interface GnssStep {
  date: string;
  kind: 'equipment' | 'earthquake';
  detail: string;
  event?: string;
}

export interface GnssMonument {
  monument: string | null;
  monument_height_m: string | null;
  foundation: string | null;
  foundation_depth_m: string | null;
  geology: string | null;
}

/** Vertical markers for steps on a chart: one segment per date across [lo, hi], with gaps between. */
export function stepMarkers(steps: GnssStep[], lo: number, hi: number): { x: number; y: number | null }[] {
  return steps.flatMap(s => {
    const t = Date.parse(s.date);
    return [{ x: t, y: lo }, { x: t, y: hi }, { x: t + 1, y: null }];
  });
}

type Enu = { east: number; north: number; up: number };

/** The overlay that shows the stations found in the GNSS tab. */
export const GNSS_LAYER_ID = 'gnss_stations';
/** The overlay of the stations read from the user's files. */
export const GNSS_CUSTOM_LAYER_ID = 'gnss_custom';

/** Where a station's daily record is read: UNR's through /gnss/series, a file's through /gnss/custom. */
export function gnssSeriesUrl(s: Pick<GnssStation, 'id' | 'custom'>): string {
  return s.custom ? `/gnss/custom/${encodeURIComponent(s.id)}` : `/gnss/series/${s.id}`;
}

/** A key that keeps a UNR station and a file's station of the same name apart. */
export const gnssKey = (s: Pick<GnssStation, 'id' | 'custom'>) => `${s.custom ? 'file' : 'unr'}:${s.id}`;

/** Where the rates come from, for labels. */
export const rateSource = (s: Pick<GnssStation, 'custom'>) => (s.custom ? 'linear fit' : 'MIDAS');

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail ?? `HTTP ${res.status}`);
  return body as T;
}

/** The stations read from files in this server session. */
export async function fetchCustomStations(): Promise<CustomGnssStation[]> {
  return (await json<{ stations: CustomGnssStation[] }>(await fetch('/gnss/custom'))).stations;
}

/** Read one file: its text from this computer, or its path on the server. */
export async function loadGnssFile(
  source: { text: string; name: string } | { path: string },
  units: 'auto' | 'm' | 'mm' | 'cm' = 'auto',
): Promise<GnssCsvLoaded> {
  return json<GnssCsvLoaded>(await fetch('/gnss/custom', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...source, units }),
  }));
}

/** Forget a station read from a file. */
export async function removeCustomStation(id: string): Promise<void> {
  await json(await fetch(`/gnss/custom/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}

/** One line on what a file gave: stations, rows, skipped rows, units and span. */
export function describeLoad(r: GnssCsvLoaded): string {
  const names = r.stations.map(s => s.id).join(', ');
  const s0 = r.stations[0];
  const units = s0 ? ` in ${s0.units}${s0.units_from === 'guessed' ? ' (guessed)' : ''}` : '';
  const first = r.stations.map(s => s.first_date).sort()[0];
  const last = r.stations.map(s => s.last_date).sort().slice(-1)[0];
  return `${r.file || 'File'}: ${names}, ${r.rows} rows${r.skipped ? ` (${r.skipped} skipped)` : ''}${units}, ${first} – ${last}`;
}

/** The ground-to-satellite unit vector, or null when the cube has none. */
export function losVector(m: LosMetadata | null | undefined): Enu | null {
  return m?.los_enu_ground_to_sat ?? null;
}

/**
 * A typical right-looking Sentinel-1 line of sight (ground to satellite) for cubes without one:
 * heading 350° ascending or 190° descending, 39° incidence.
 */
export function typicalLos(pass: 'ascending' | 'descending', incidenceDeg = 39): Enu {
  const r = Math.PI / 180;
  const h = (pass === 'ascending' ? 350 : 190) * r;
  const i = incidenceDeg * r;
  return { east: -Math.sin(i) * Math.cos(h), north: Math.sin(i) * Math.sin(h), up: Math.cos(i) };
}

/** East, north, up projected on the line of sight: positive is towards the satellite. */
export function toLos(los: Enu, e: number, n: number, u: number): number {
  return los.east * e + los.north * n + los.up * u;
}

/** How many mm one data unit is: metres and mm convert, anything else (radians…) doesn't. */
export function mmPerUnit(unit: string | undefined): number | null {
  const u = (unit ?? '').trim().toLowerCase();
  if (['m', 'meter', 'meters', 'metre', 'metres'].includes(u)) return 1000;
  if (['mm', 'millimeter', 'millimeters', 'millimetre', 'millimetres'].includes(u)) return 1;
  return null;
}

/**
 * The station's LOS record over the InSAR dates, set to 0 on the InSAR series' first date
 * (the GNSS day nearest it), so both start together. Dates are YYYY-MM-DD.
 */
export function gnssLosSeries(series: GnssSeries, los: Enu, start: string, end: string): { x: string; y: number }[] {
  const { dates } = series;
  if (!dates.length) return [];
  const t0 = Date.parse(start);
  let i0 = 0;
  for (let i = 1; i < dates.length; i++) {
    if (Math.abs(Date.parse(dates[i]) - t0) < Math.abs(Date.parse(dates[i0]) - t0)) i0 = i;
  }
  const at = (i: number) => toLos(los, series.east_mm[i], series.north_mm[i], series.up_mm[i]);
  const base = at(i0);
  const out: { x: string; y: number }[] = [];
  dates.forEach((d, i) => {
    if (d >= start && d <= end) out.push({ x: d, y: +(at(i) - base).toFixed(2) });
  });
  return out;
}

/** Kilometres between two lon/lat points (haversine). */
export function distanceKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2
    + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}
