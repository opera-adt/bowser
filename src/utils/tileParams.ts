import type { AppState, RasterGroup } from '../types';

/** The parts of the app state that decide a raster tile request. */
export type TileState = Pick<
  AppState,
  | 'complexMode'
  | 'wrapEnabled'
  | 'wrapWavelength'
  | 'wrapPeriod'
  | 'refEnabled'
  | 'refValues'
  | 'dataMode'
  | 'customMaskPath'
  | 'layerMasks'
>;

export interface TileRequest {
  dataset: string;
  dsInfo: RasterGroup;
  timeIndex: number;
  vmin: number;
  vmax: number;
  colormap: string;
  state: TileState;
  /** Catalog dataset id (``?dataset=``), or null outside catalog mode. */
  datasetId: string | null;
}

/**
 * The tilejson endpoint for the raster layer, with every query parameter.
 *
 * Map-library independent: the Leaflet layer and any replacement (MapLibre) build
 * their tile source from this one function, so the request the backend sees for a
 * given UI state can't drift between them. Pinned by tileParams.test.ts.
 */
export function buildTileRequest(req: TileRequest): { endpoint: string; params: Record<string, string> } {
  const { dataset, dsInfo, vmin, vmax, colormap, state } = req;
  const maxIdx = dsInfo.x_values.length - 1;
  const timeIdx = Math.max(0, Math.min(req.timeIndex, maxIdx));

  const params: Record<string, string> = {
    variable: dataset,
    time_idx: timeIdx.toString(),
    rescale: `${vmin},${vmax}`,
    colormap_name: colormap,
  };

  const isComplex = dsInfo.algorithm === 'phase' || dsInfo.algorithm === 'amplitude';
  if (isComplex) {
    if (state.complexMode === 'amplitude') params.algorithm = 'amplitude';
    else if (state.wrapEnabled) params.algorithm = 'rewrap';
    else params.algorithm = 'phase';
  } else if (state.wrapEnabled) {
    params.algorithm = 'rewrap';
  } else if (dsInfo.algorithm) {
    params.algorithm = dsInfo.algorithm;
  }

  {
    const algorithmParams: Record<string, number> = {};
    if (state.refEnabled && state.refValues[dataset] && dsInfo.algorithm === 'shift') {
      const refArr = state.refValues[dataset];
      const shift = refArr[timeIdx] ?? refArr[0];
      if (shift !== undefined) algorithmParams.shift = shift;
    }
    if (state.wrapEnabled) {
      if (state.wrapWavelength !== null && state.wrapWavelength > 0) {
        algorithmParams.scale_factor = (4 * Math.PI) / state.wrapWavelength;
        algorithmParams.wrap_range = 2 * Math.PI;
      } else {
        algorithmParams.wrap_range = state.wrapPeriod;
      }
    }
    if (Object.keys(algorithmParams).length > 0) {
      params.algorithm_params = JSON.stringify(algorithmParams);
    }
  }

  if (state.dataMode === 'cog') {
    params.url = dsInfo.file_list[timeIdx];
    const maskUrl = dsInfo.mask_file_list[timeIdx];
    if (maskUrl) params.mask = maskUrl;
    if (dsInfo.mask_min_value !== undefined) params.mask_min_value = dsInfo.mask_min_value.toString();
    if (state.customMaskPath) params.custom_mask = state.customMaskPath;
  }

  if (state.layerMasks.length > 0) {
    params.layer_masks = JSON.stringify(
      state.layerMasks.map(m => ({ dataset: m.dataset, threshold: m.threshold, mode: m.mode }))
    );
  }

  if (state.dataMode === 'md' && state.customMaskPath) {
    params.custom_mask_path = state.customMaskPath;
  }

  if (req.datasetId) params.dataset = req.datasetId;

  const urlParams = new URLSearchParams(params).toString();
  const endpoint = state.dataMode === 'md'
    ? `/md/WebMercatorQuad/tilejson.json?${urlParams}`
    : `/cog/WebMercatorQuad/tilejson.json?${urlParams}`;
  return { endpoint, params };
}
