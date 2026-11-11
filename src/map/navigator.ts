/**
 * The map the page shows, as the Assistant's page tools move it: one small interface the
 * MapLibre and Leaflet maps both register (MapLibreMap.tsx, MapContainer.tsx), so get_view,
 * fly_to, fit_bounds, pan and zoom have one implementation (src/assistant/pageTools.ts).
 *
 * Zoom levels are MapLibre's (512-px tiles: 0 shows the world); the Leaflet map's own levels
 * (256-px tiles) are one higher for the same scale, and its adapter converts.
 */

export interface MapView {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
  /** [west, south, east, north] */
  bounds: [number, number, number, number];
  map: 'maplibre' | 'leaflet';
  width: number;
  height: number;
}

export interface TerrainControl {
  get(): { enabled: boolean; exaggeration: number };
  /** As the terrain popover: on/off and exaggeration (clamped, remembered); then the pitch, if given. */
  set(enabled: boolean, exaggeration: number, pitch?: number): Promise<{ enabled: boolean; exaggeration: number }>;
}

export interface MapNavigator {
  kind: 'maplibre' | 'leaflet';
  getView(): MapView;
  /** Each resolves once the map has stopped moving (or after a few seconds). */
  flyTo(lon: number, lat: number, zoom?: number): Promise<void>;
  /** ``maxZoom`` (MapLibre scale) keeps a small box from zooming in too far. */
  fitBounds(west: number, south: number, east: number, north: number, padding: number, maxZoom?: number): Promise<void>;
  panBy(dx: number, dy: number): Promise<void>;
  zoomTo(zoom: number): Promise<void>;
  /** MapLibre only. */
  terrain?: TerrainControl;
}

let current: MapNavigator | null = null;

/** Register the page's map; returns the function that unregisters it. */
export function registerNavigator(nav: MapNavigator): () => void {
  current = nav;
  return () => { if (current === nav) current = null; };
}

export function getNavigator(): MapNavigator | null {
  return current;
}

/** Leaflet's zoom for a MapLibre zoom, and back. */
export const leafletZoom = (z: number) => z + 1;
export const maplibreZoom = (z: number) => z - 1;

/** Run ``move`` and resolve when the map fires ``moveend`` (or after ``ms``). */
export function whenMoved(
  on: (ev: 'moveend', fn: () => void) => void,
  off: (ev: 'moveend', fn: () => void) => void,
  move: () => void,
  ms = 3000,
): Promise<void> {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      off('moveend', finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    on('moveend', finish);
    move();
  });
}
