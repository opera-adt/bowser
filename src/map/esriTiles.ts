/**
 * Esri basemap tiles for MapLibre, through the ``esritiles://`` protocol.
 *
 * Where Esri has no tile it answers 200 with a grey "Map data not yet available"
 * image, and how deep its tiles go depends on the place, so the source's
 * ``maxzoom`` cannot stop every such request. With ``blankTile=false`` Esri
 * answers 404 instead, but without a CORS header, so the browser reports a failed
 * request and not a 404, and MapLibre only draws the tiles above a missing one
 * for an error whose ``status`` is 404. This loader fetches the tile and turns a
 * missing one into that error; MapLibre then walks up to the last real tile and
 * upscales it.
 */
export const ESRI_TILE_PROTOCOL = 'esritiles';

const ESRI_TILE = /^https:\/\/([a-z0-9.-]+\.arcgisonline\.com\/.+\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\})(\?.*)?$/i;

/** An Esri tile template as an ``esritiles://`` one with ``blankTile=false``; others unchanged. */
export function esriTileUrl(template: string): string {
  const m = ESRI_TILE.exec(template);
  if (!m) return template;
  const query = new URLSearchParams((m[2] ?? '').slice(1));
  query.set('blankTile', 'false');
  return `${ESRI_TILE_PROTOCOL}://${m[1]}?${query.toString()}`;
}

/** The error MapLibre treats as "no tile here: draw the tiles above it". */
function missingTile(url: string): Error {
  return Object.assign(new Error(`No tile at ${url}`), { status: 404 });
}

/** The ``esritiles://`` loader for ``maplibregl.addProtocol``. */
export async function loadEsriTile(params: { url: string }, abort: AbortController): Promise<{ data: ArrayBuffer }> {
  const url = `https://${params.url.slice(ESRI_TILE_PROTOCOL.length + 3)}`;
  let response: Response;
  try {
    response = await fetch(url, { signal: abort.signal });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;   // the map moved on
    // Esri's 404 has no CORS header, so a missing tile arrives as a failed request.
    throw missingTile(url);
  }
  if (!response.ok) throw missingTile(url);
  return { data: await response.arrayBuffer() };
}

let registered = false;

/** Register the ``esritiles://`` protocol on MapLibre once. */
export function registerEsriTiles(addProtocol: ((name: string, load: never) => void) | undefined): void {
  if (registered || typeof addProtocol !== 'function') return;
  registered = true;
  addProtocol(ESRI_TILE_PROTOCOL, loadEsriTile as never);
}
