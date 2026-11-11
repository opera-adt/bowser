import type { RasterGroup } from '../types';

type Layers = { [key: string]: RasterGroup };

/**
 * True when a layer has more than one step to plot. Velocity and other 2-D cube
 * variables have an empty axis; a single-file COG layer has one entry.
 */
export function hasTimeAxis(info: RasterGroup | undefined): boolean {
  return Array.isArray(info?.x_values) && info.x_values.length > 1;
}

/** Names of the layers a time-series chart can show, in catalogue order. */
export function timeSeriesLayers(layers: Layers): string[] {
  return Object.keys(layers).filter(name => hasTimeAxis(layers[name]));
}

/**
 * The layer a chart shows when it follows the map: the map's layer if it has a
 * time axis, otherwise displacement, otherwise the first layer with a time axis.
 */
export function chartLayerFor(current: string, layers: Layers): string | null {
  if (hasTimeAxis(layers[current])) return current;
  const names = timeSeriesLayers(layers);
  return names.find(name => name.toLowerCase() === 'displacement')
    ?? names.find(name => name.toLowerCase().includes('displacement'))
    ?? names[0]
    ?? null;
}

/**
 * The window's layer list after picking `added` from "+ layer…". A window that
 * follows the map (empty list) keeps the layer it shows and adds the new one,
 * so the chart gets both layers instead of swapping one for the other.
 */
export function addChartLayer(chosen: string[], followed: string | null, added: string): string[] {
  const shown = chosen.length > 0 ? chosen : (followed ? [followed] : []);
  return shown.includes(added) ? shown : [...shown, added];
}
