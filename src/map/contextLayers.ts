/**
 * Context layers from OpenFreeMap's keyless vector tiles (OpenMapTiles schema,
 * © OpenStreetMap contributors): roads and rail, buildings in 3D, admin boundaries.
 * Ported from the portal's street features; each is an overlay row (order, opacity, style).
 */
import type { Overlay } from '../types';

export type ContextKey = 'roads' | 'buildings' | 'boundaries';

export const OFM_TILEJSON = 'https://tiles.openfreemap.org/planet';
export const OFM_ATTRIBUTION = 'OpenFreeMap © OpenMapTiles © OpenStreetMap contributors';
/** OpenFreeMap has no buildings below this zoom. */
export const BUILDINGS_ZOOM = 13;

export const CONTEXT_LAYERS: { key: ContextKey; name: string; color: string; note: string }[] = [
  { key: 'roads', name: 'Roads', color: '', note: 'Motorways to minor roads, and railways' },
  { key: 'boundaries', name: 'Admin boundaries', color: '#7c3aed', note: 'Countries, states and counties' },
  { key: 'buildings', name: 'Buildings (3D)', color: '#6b7280', note: `From zoom ${BUILDINGS_ZOOM}; tilt the map to see heights` },
];

/** Annual 10 m land use / land cover from Sentinel-2 (Impact Observatory, Microsoft, Esri; CC BY 4.0). */
export const LAND_COVER_URL = 'https://ic.imagery1.arcgis.com/arcgis/rest/services/Sentinel2_10m_LandCover/ImageServer';
export const LAND_COVER_YEARS = [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
export const LAND_COVER_ATTRIBUTION = 'Land cover: Impact Observatory, Microsoft, Esri (CC BY 4.0)';
export const LAND_COVER_CLASSES: [string, string][] = [
  ['Water', '#1a5bab'],
  ['Trees', '#358221'],
  ['Flooded vegetation', '#87d19e'],
  ['Crops', '#ffdb5c'],
  ['Built area', '#ed022a'],
  ['Bare ground', '#ede9e4'],
  ['Snow / ice', '#f2faff'],
  ['Clouds', '#c8c8c8'],
  ['Rangeland', '#efcfa8'],
];

/** Raster tiles for one year of the land cover (the service renders each 256 px Web Mercator tile). */
export function landCoverTiles(year: number): string {
  const q = new URLSearchParams({
    bboxSR: '3857',
    imageSR: '3857',
    size: '256,256',
    format: 'png32',
    transparent: 'true',
    renderingRule: JSON.stringify({ rasterFunction: 'Cartographic Renderer for Visualization and Analysis' }),
    time: `${Date.UTC(year, 0, 1)},${Date.UTC(year, 11, 31, 23, 59, 59)}`,
    f: 'image',
  });
  // MapLibre fills in {bbox-epsg-3857}; keep it unescaped.
  return `${LAND_COVER_URL}/exportImage?bbox={bbox-epsg-3857}&${q}`;
}

/** Land cover for a year, as a tile overlay under the data, with its class legend. */
export function landCoverOverlay(year: number, id: string): Overlay {
  return {
    id, name: `Land cover ${year}`, type: 'wmts', url: landCoverTiles(year), visible: true, opacity: 0.7,
    aboveData: false, maxNativeZoom: 22, landCoverYear: year, legend: LAND_COVER_CLASSES, attribution: LAND_COVER_ATTRIBUTION,
  };
}

const ROAD_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'rail'];
/** Road colours by class when the layer has no single colour. */
const ROAD_COLORS = ['match', ['get', 'class'], 'motorway', '#f59e0b', 'trunk', '#f59e0b', 'rail', '#6b7280', '#fde68a'];

export interface ContextLayerSpec {
  id: string;
  type: 'line' | 'fill-extrusion';
  sourceLayer: string;
  filter?: unknown[];
  minzoom?: number;
  paint: Record<string, unknown>;
}

export function contextOverlay(key: ContextKey, id: string): Overlay {
  const def = CONTEXT_LAYERS.find(c => c.key === key)!;
  return { id, name: def.name, type: 'context', contextKey: key, visible: true, opacity: 0.85, aboveData: true, color: def.color, scale: 1 };
}

/** The MapLibre layer of a context overlay, painted with its style. */
export function contextLayerSpec(o: Overlay): ContextLayerSpec {
  const id = `overlay-${o.id}`;
  const k = o.scale ?? 1;
  if (o.contextKey === 'buildings') {
    return {
      id, type: 'fill-extrusion', sourceLayer: 'building', minzoom: BUILDINGS_ZOOM,
      paint: {
        'fill-extrusion-color': o.color || '#6b7280',
        'fill-extrusion-height': ['*', ['coalesce', ['get', 'render_height'], 6], k],
        'fill-extrusion-base': ['*', ['coalesce', ['get', 'render_min_height'], 0], k],
        'fill-extrusion-opacity': o.opacity,
      },
    };
  }
  if (o.contextKey === 'boundaries') {
    return {
      id, type: 'line', sourceLayer: 'boundary', filter: ['<=', ['get', 'admin_level'], 6],
      paint: {
        'line-color': o.color || '#7c3aed',
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.6 * k, 10, 1.6 * k],
        'line-dasharray': [3, 2],
        'line-opacity': o.opacity,
      },
    };
  }
  return {
    id, type: 'line', sourceLayer: 'transportation', filter: ['in', ['get', 'class'], ['literal', ROAD_CLASSES]],
    paint: {
      'line-color': o.color || ROAD_COLORS,
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.5 * k, 12, 1.6 * k, 16, 5 * k],
      'line-opacity': o.opacity,
    },
  };
}
