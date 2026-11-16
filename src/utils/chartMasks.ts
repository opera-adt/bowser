import type { AppState } from '../types';

export interface ChartMaskOptions {
  primary_mask?: true;
  mask_min_value?: number;
  custom_mask_path?: string;
}

/** Forward the same configured/uploaded masks as the selected layer's map. */
export function chartMaskOptions(
  state: Pick<AppState, 'dataMode' | 'datasetInfo' | 'customMaskPath'>,
  dataset: string,
  externalSupported = true,
): ChartMaskOptions {
  const options: ChartMaskOptions = {};
  if (!externalSupported) return options;
  const info = state.datasetInfo[dataset];
  if (state.dataMode === 'cog' && info?.mask_file_list?.some(Boolean)) {
    options.primary_mask = true;
    options.mask_min_value = info.mask_min_value;
  }
  if (state.customMaskPath) options.custom_mask_path = state.customMaskPath;
  return options;
}
