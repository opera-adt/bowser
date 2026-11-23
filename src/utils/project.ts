/**
 * A saved project: what Project › Save writes, and whether the page has anything worth saving
 * (asked before switching to another dataset, which reloads the page).
 */
import type { AppState } from '../types';
import { defaultMasks } from './defaultMasks';
import { saveFile } from './saveFile';

/** The state a project file keeps: points, reference, annotations, masks, overlays, chart model. */
export const PROJECT_KEYS = [
  'currentDataset', 'currentTimeIndex', 'colormap', 'vmin', 'vmax',
  'opacity', 'dataMode',
  'refMarkerPosition', 'refEnabled', 'refMarkerVisible', 'refTimeIndex',
  'timeSeriesPoints', 'annotations', 'layerMasks', 'customMaskPath', 'overlays', 'units',
  'chartAreas', 'areaBand', 'areaSupport',
  // The chart's model: whether it and its residuals are shown, and its terms.
  'showTrends', 'showResiduals', 'fitSettings',
] as const;
export type ProjectKey = (typeof PROJECT_KEYS)[number];

/** The project file's contents for ``state`` as it is now. */
export function buildProject(state: AppState): Record<string, unknown> {
  const project: Record<string, unknown> = { bowser_project: 1, saved: new Date().toISOString() };
  PROJECT_KEYS.forEach(k => {
    // Drop cached time-series/trend values from points — they refetch on load.
    project[k] = k === 'timeSeriesPoints'
      ? state.timeSeriesPoints.map(({ data: _data, trendData: _trendData, ...rest }) => rest)
      : state[k];
  });
  return project;
}

/** Save ``state`` as a project file; false when the save was cancelled. */
export function saveProjectFile(state: AppState): Promise<boolean> {
  const blob = new Blob([JSON.stringify(buildProject(state), null, 2)], { type: 'application/json' });
  return saveFile(blob, `bowser-project-${new Date().toISOString().slice(0, 16).replace(/[:.]/g, '-')}.json`);
}

/**
 * Whether the page holds work a reload would lose: points, areas, annotations, overlays, an uploaded
 * mask, or masks other than the ones every cube starts with (its recommended mask).
 */
export function hasProjectWork(state: AppState): boolean {
  const masksChanged = state.layerMasks.length > 0
    && JSON.stringify(state.layerMasks) !== JSON.stringify(defaultMasks(state.datasetInfo));
  return state.timeSeriesPoints.length > 0 || state.chartAreas.length > 0 || state.annotations.length > 0
    || masksChanged || !!state.customMaskPath || state.overlays.length > 0;
}
