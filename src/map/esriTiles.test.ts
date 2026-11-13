import { afterEach, describe, expect, it, vi } from 'vitest';
import { baseMaps } from '../basemap';
import { basemapSource } from './basemapStyle';
import { ESRI_TILE_PROTOCOL, esriTileUrl, loadEsriTile } from './esriTiles';

const TILE = 'esritiles://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/14/6789/3959?blankTile=false';

afterEach(() => { vi.unstubAllGlobals(); });

describe('Esri basemap tiles', () => {
  it('sends Esri templates through esritiles:// with blankTile=false, and leaves others alone', () => {
    expect(esriTileUrl('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'))
      .toBe('esritiles://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?blankTile=false');
    // Already asked for: not doubled.
    expect(esriTileUrl('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}?blankTile=false'))
      .toBe('esritiles://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}?blankTile=false');
    const osm = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
    expect(esriTileUrl(osm)).toBe(osm);
    expect(esriTileUrl('https://example.com/arcgisonline.com/MapServer/tile/{z}/{y}/{x}')).toContain('https://example.com');
  });

  it('every Esri basemap source uses the protocol; the others keep https', () => {
    for (const [key, item] of Object.entries(baseMaps)) {
      const tile = basemapSource(item).tiles[0];
      if (item.url.includes('arcgisonline.com')) {
        expect(tile.startsWith(`${ESRI_TILE_PROTOCOL}://`), key).toBe(true);
        expect(tile, key).toContain('blankTile=false');
      } else {
        expect(tile.startsWith('https://'), key).toBe(true);
      }
    }
  });

  it('returns the bytes of a tile that exists, fetched over https', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]).buffer;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(bytes, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await loadEsriTile({ url: TILE }, new AbortController());
    expect(new Uint8Array(out.data)).toEqual(new Uint8Array(bytes));
    expect(fetchMock.mock.calls[0][0]).toBe(TILE.replace('esritiles://', 'https://'));
  });

  it('reports a missing tile as status 404, the error MapLibre draws the tiles above for', async () => {
    // Esri's 404 has no CORS header: the browser rejects the fetch.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(loadEsriTile({ url: TILE }, new AbortController())).rejects.toMatchObject({ status: 404 });
    // And a 404 that does arrive.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    await expect(loadEsriTile({ url: TILE }, new AbortController())).rejects.toMatchObject({ status: 404 });
  });

  it('passes an aborted request on as an abort, not as a missing tile', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('aborted', 'AbortError'); }));
    const err = await loadEsriTile({ url: TILE }, new AbortController()).catch(e => e);
    expect(err.name).toBe('AbortError');
    expect(err.status).toBeUndefined();
  });
});
