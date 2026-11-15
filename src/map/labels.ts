/**
 * Text labels beside the points of a vector layer (GNSS station names).
 *
 * The map's style has no font server, so that it works offline and in the desktop app: a
 * label is an image drawn from its text when the map first asks for it, and MapLibre places
 * it like any icon, hiding the ones that would overlap.
 */
import type { Map as MapLibreMap } from 'maplibre-gl';

const PREFIX = 'bowser-label:';
/** Space left of the text, in CSS px, so it clears the point it belongs to. */
export const LABEL_GAP = 9;
const FONT = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
const RATIO = 2;

/** The icon-image expression for a layer labelled by ``field``. */
export const labelImageExpression = (field: string): unknown[] => ['concat', PREFIX, ['to-string', ['get', field]]];

/** The label's text, if ``imageId`` is one of ours. */
export function labelText(imageId: string): string | null {
  return imageId.startsWith(PREFIX) ? imageId.slice(PREFIX.length) : null;
}

function labelImage(text: string): ImageData | null {
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  if (!g) return null;
  g.font = FONT;
  const w = Math.ceil(g.measureText(text).width) + LABEL_GAP + 4;
  const h = 16;
  c.width = w * RATIO;
  c.height = h * RATIO;
  g.scale(RATIO, RATIO);
  g.font = FONT;
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  // Dark text with a white edge reads on imagery and on a light basemap alike.
  g.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  g.lineWidth = 3;
  g.strokeText(text, LABEL_GAP, h / 2);
  g.fillStyle = '#111827';
  g.fillText(text, LABEL_GAP, h / 2);
  return g.getImageData(0, 0, c.width, c.height);
}

function addLabel(map: MapLibreMap, id: string, text: string): void {
  if (map.hasImage(id)) return;
  const image = labelImage(text);
  if (image) map.addImage(id, image, { pixelRatio: RATIO });
}

/**
 * Draw the labels of these features before their layer is added, so that all of them are
 * placed at once: an image drawn only when the map misses it shows up a move later.
 */
export function ensureLabels(map: MapLibreMap, features: unknown[], field: string): void {
  for (const f of features) {
    const value = (f as { properties?: Record<string, unknown> | null } | null)?.properties?.[field];
    if (value !== undefined && value !== null) addLabel(map, PREFIX + String(value), String(value));
  }
}

const watched = new WeakSet<MapLibreMap>();

/** Draw any other label as the map asks for it. Safe to call for every labelled layer. */
export function watchLabelImages(map: MapLibreMap): void {
  if (watched.has(map)) return;
  watched.add(map);
  map.on('styleimagemissing', (e: { id: string }) => {
    const text = labelText(e.id);
    if (text !== null) addLabel(map, e.id, text);
  });
}
