/**
 * UTM <-> lon/lat (WGS84, Krüger series to n^4, sub-millimetre inside a zone) and
 * lon/lat -> MapLibre's Web Mercator [0, 1] world coordinates.
 *
 * The GPU render spike projects each chunk's mesh vertices on the CPU with these, in
 * double precision; the GPU interpolates linearly between vertices (see meshError).
 */

const A_AXIS = 6378137;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const N = F / (2 - F);
const N2 = N * N, N3 = N2 * N, N4 = N3 * N;
const A = (A_AXIS / (1 + N)) * (1 + N2 / 4 + N4 / 64);
const ALPHA = [
  N / 2 - (2 * N2) / 3 + (5 * N3) / 16 + (41 * N4) / 180,
  (13 * N2) / 48 - (3 * N3) / 5 + (557 * N4) / 1440,
  (61 * N3) / 240 - (103 * N4) / 140,
  (49561 * N4) / 161280,
];
const BETA = [
  N / 2 - (2 * N2) / 3 + (37 * N3) / 96 - N4 / 360,
  N2 / 48 + N3 / 15 - (437 * N4) / 1440,
  (17 * N3) / 480 - (37 * N4) / 840,
  (4397 * N4) / 161280,
];
const DELTA = [
  2 * N - (2 * N2) / 3 - 2 * N3 + (116 * N4) / 45,
  (7 * N2) / 3 - (8 * N3) / 5 - (227 * N4) / 45,
  (56 * N3) / 15 - (136 * N4) / 35,
  (4279 * N4) / 630,
];
const E2N = (2 * Math.sqrt(N)) / (1 + N);
const DEG = Math.PI / 180;

export interface UtmZone { zone: number; south: boolean }

/** The UTM zone of an EPSG code (326zz north, 327zz south), or null. */
export function utmZoneFromEpsg(epsg: number): UtmZone | null {
  if (epsg > 32600 && epsg <= 32660) return { zone: epsg - 32600, south: false };
  if (epsg > 32700 && epsg <= 32760) return { zone: epsg - 32700, south: true };
  return null;
}

/** The EPSG code in ``proj:code`` ("EPSG:32615") or a WKT (its last EPSG ID / AUTHORITY). */
export function epsgFromCrs(text: string | undefined | null): number | null {
  if (!text) return null;
  const code = /^EPSG:(\d+)$/i.exec(text.trim());
  if (code) return Number(code[1]);
  // WKT2 ID["EPSG",32615] or WKT1 AUTHORITY["EPSG","32615"]; the CRS's own is the last.
  const ids = [...text.matchAll(/(?:ID|AUTHORITY)\["EPSG",\s*"?(\d+)"?\]/g)];
  return ids.length ? Number(ids[ids.length - 1][1]) : null;
}

const centralMeridian = (z: UtmZone) => (z.zone * 6 - 183) * DEG;

/** UTM easting/northing (metres) -> [lon, lat] degrees. */
export function utmToLonLat(x: number, y: number, z: UtmZone): [number, number] {
  const xi = (y - (z.south ? 10000000 : 0)) / (K0 * A);
  const eta = (x - 500000) / (K0 * A);
  let xip = xi, etap = eta;
  for (let j = 1; j <= 4; j++) {
    xip -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etap -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xip) / Math.cosh(etap));
  let phi = chi;
  for (let j = 1; j <= 4; j++) phi += DELTA[j - 1] * Math.sin(2 * j * chi);
  const lam = centralMeridian(z) + Math.atan2(Math.sinh(etap), Math.cos(xip));
  return [lam / DEG, phi / DEG];
}

/** [lon, lat] degrees -> UTM easting/northing (metres) in zone ``z``. */
export function lonLatToUtm(lon: number, lat: number, z: UtmZone): [number, number] {
  const phi = lat * DEG;
  const lam = lon * DEG - centralMeridian(z);
  const s = Math.sin(phi);
  const t = Math.sinh(Math.atanh(s) - E2N * Math.atanh(E2N * s));
  const xip = Math.atan2(t, Math.cos(lam));
  const etap = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let xi = xip, eta = etap;
  for (let j = 1; j <= 4; j++) {
    xi += ALPHA[j - 1] * Math.sin(2 * j * xip) * Math.cosh(2 * j * etap);
    eta += ALPHA[j - 1] * Math.cos(2 * j * xip) * Math.sinh(2 * j * etap);
  }
  return [500000 + K0 * A * eta, (z.south ? 10000000 : 0) + K0 * A * xi];
}

/** [lon, lat] -> MapLibre MercatorCoordinate x, y (world = [0, 1]^2, y down). */
export function lonLatToMercator(lon: number, lat: number): [number, number] {
  const x = (180 + lon) / 360;
  const y = (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
  return [x, y];
}

/** Inverse of lonLatToMercator. */
export function mercatorToLonLat(x: number, y: number): [number, number] {
  const lon = x * 360 - 180;
  const y2 = 180 - y * 360;
  const lat = (360 / Math.PI) * Math.atan(Math.exp((y2 * Math.PI) / 180)) - 90;
  return [lon, lat];
}

/** Metres on the ground per Mercator world unit at ``lat`` (for error estimates). */
export function metresPerMercatorUnit(lat: number): number {
  return 40075016.686 * Math.cos(lat * DEG);
}
