/**
 * Custom PMTiles archives (Overlays › Services): one file of tiles read with HTTP range
 * requests, raster or vector. The header says which; a vector archive's metadata lists its
 * layers, each drawn as fill, line and points in the overlay's colour.
 */
import { PMTiles, Protocol, TileType } from 'pmtiles';
import type { Overlay } from '../types';
import { vectorLayerSpecs, type VectorLayerSpec } from './overlays';

let protocol: Protocol | null = null;

/** Register the pmtiles:// protocol on MapLibre once (archives are shared across maps). */
export function registerPmtiles(addProtocol: ((name: string, load: never) => void) | undefined): void {
  if (protocol || typeof addProtocol !== 'function') return;
  protocol = new Protocol();
  addProtocol('pmtiles', protocol.tile as never);
}

export interface PmtilesInfo {
  kind: 'raster' | 'vector';
  layers: string[];
  bounds: [number, number, number, number] | null;
  minzoom: number;
  maxzoom: number;
  name: string | null;
  attribution: string | null;
  /** Whether a vector archive has polygons, from its tilestats; null when it does not say. */
  polygons: boolean | null;
}

type Tilestats = { layers?: { geometry?: string }[] };
/** Whether the metadata's tilestats (GDAL and tippecanoe write them) list a polygon layer. */
export function hasPolygonLayers(tilestats: Tilestats | undefined): boolean | null {
  const layers = tilestats?.layers;
  if (!Array.isArray(layers) || !layers.some(l => typeof l.geometry === 'string')) return null;
  return layers.some(l => l.geometry === 'Polygon');
}

const RASTER = new Set<TileType>([TileType.Png, TileType.Jpeg, TileType.Webp, TileType.Avif]);

/** Read an archive's header and metadata: raster or vector, its layers, bounds and zooms. */
export async function inspectPmtiles(url: string): Promise<PmtilesInfo> {
  const archive = new PMTiles(url);
  const header = await archive.getHeader();
  const meta = (await archive.getMetadata().catch(() => ({}))) as { name?: string; attribution?: string; vector_layers?: { id: string }[]; tilestats?: Tilestats };
  const kind = header.tileType === TileType.Mvt ? 'vector' : RASTER.has(header.tileType) ? 'raster' : null;
  if (!kind) throw new Error('unknown tile type in this archive');
  const bounds: [number, number, number, number] = [header.minLon, header.minLat, header.maxLon, header.maxLat];
  return {
    kind,
    layers: kind === 'vector' ? (meta.vector_layers ?? []).map(l => l.id) : [],
    bounds: bounds.every(Number.isFinite) && bounds[0] < bounds[2] ? bounds : null,
    minzoom: header.minZoom,
    maxzoom: header.maxZoom,
    name: meta.name ?? null,
    attribution: meta.attribution ?? null,
    polygons: kind === 'vector' ? hasPolygonLayers(meta.tilestats) : false,
  };
}

/** The overlay for an inspected archive; vector ones start above the data, raster ones below. */
export function pmtilesOverlay(url: string, info: PmtilesInfo, id: string): Overlay {
  const file = decodeURIComponent(url.split('?')[0].split('/').pop() ?? url).replace(/\.pmtiles$/i, '');
  return {
    id, name: info.name || file, type: 'pmtiles', url, visible: true, opacity: info.kind === 'vector' ? 1 : 0.85,
    aboveData: info.kind === 'vector', pmtilesKind: info.kind, sourceLayers: info.layers, bounds: info.bounds,
    minzoom: info.minzoom, maxNativeZoom: info.maxzoom, color: '#e377c2', lineWidth: 1.5, pointRadius: 4,
    attribution: info.attribution ?? undefined,
    ...(info.polygons !== null ? { hasPolygons: info.polygons } : {}),
  };
}

/** A vector archive's layers: fill, line and points for each source layer (ids overlay-<id>__<layer>-…). */
export function pmtilesVectorSpecs(o: Overlay): (VectorLayerSpec & { sourceLayer: string })[] {
  return (o.sourceLayers ?? []).flatMap((layer, i) =>
    vectorLayerSpecs({ ...o, id: `${o.id}__${i}` }).map(spec => ({ ...spec, sourceLayer: layer })));
}
