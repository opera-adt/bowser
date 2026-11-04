/**
 * Services entries beyond the OpenFreeMap layers: USGS geology (SGMC WMS) and USDA soils
 * (SSURGO map units in the view, classed for reading ground motion; see soils.ts).
 */
import type { Overlay, OverlayFeatures } from '../types';
import { SOIL_CLASSES, soilsInView } from './soils';
import { featureBounds } from './fileParsers';

export const GEOLOGY_WMS = 'https://mrdata.usgs.gov/services/sgmc2';

export function geologyOverlay(id: string): Overlay {
  return {
    id, name: 'Geology (USGS SGMC)', type: 'wms', url: GEOLOGY_WMS, wmsLayers: 'sgmc', visible: true, opacity: 0.55,
    aboveData: false, maxNativeZoom: 22, serviceKey: 'geology',
    attribution: 'USGS State Geologic Map Compilation (SGMC), conterminous US',
  };
}

/** Soils in a view ([west, south, east, north]), as a vector overlay coloured by class. */
export async function soilsOverlay(view: [number, number, number, number], id: string): Promise<{ overlay: Overlay; notes: string[] }> {
  const fc = await soilsInView(view);
  return {
    overlay: {
      id, name: 'Soils (USDA SSURGO)', type: 'vector', visible: true, opacity: 0.7, aboveData: true,
      data: fc as OverlayFeatures, bounds: featureBounds(fc), lineWidth: 0.5, pointRadius: 4, serviceKey: 'soils',
      classColors: { property: 'class', classes: SOIL_CLASSES }, legend: SOIL_CLASSES, soilField: 'class', maxClasses: 6,
      attribution: 'USDA NRCS Soil Survey (SSURGO), via Soil Data Access',
    },
    notes: fc.notes ?? [],
  };
}
