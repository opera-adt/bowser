/**
 * Map interactions, independent of the map library.
 *
 * Each function takes plain coordinates (lat, lng) and app state and returns the
 * actions to dispatch (or the request to make). The Leaflet components call these
 * today and the MapLibre ones will tomorrow, so both behave identically; the
 * behaviour is pinned by interactions.test.ts.
 */
import type { AppAction, AppState, MapAnnotation } from '../types';

type LatLng = [number, number];

/** Map click: add a time-series point (and open the chart), unless something else owns the click. */
export function mapClickActions(
  state: Pick<AppState, 'annotationMode' | 'pointPickingEnabled' | 'showChart'>,
  position: LatLng,
  opts: { toolActive: boolean; profileActive: boolean; now?: number },
): { kind: 'ignore' } | { kind: 'annotate'; position: LatLng } | { kind: 'actions'; actions: AppAction[] } {
  if (opts.toolActive || opts.profileActive) return { kind: 'ignore' };
  if (state.annotationMode) return { kind: 'annotate', position };
  if (!state.pointPickingEnabled) return { kind: 'ignore' };
  const now = opts.now ?? Date.now();
  const actions: AppAction[] = [
    { type: 'ADD_TIME_SERIES_POINT', payload: { position, name: `Point ${now.toString().slice(-4)}` } },
  ];
  if (!state.showChart) actions.push({ type: 'TOGGLE_CHART' });
  return { kind: 'actions', actions };
}

/** The annotation the inline form creates (text trimmed; size clamped to 8–72 px). */
export function annotationAction(
  position: LatLng, text: string, color: string, size: string, now: number = Date.now(),
): AppAction | null {
  const t = text.trim();
  if (!t) return null;
  const payload: MapAnnotation = {
    id: `ann_${now}`,
    position,
    text: t,
    color,
    fontSize: Math.max(8, Math.min(72, parseInt(size) || 13)),
  };
  return { type: 'ADD_ANNOTATION', payload };
}

/** Popup text when a marker is clicked. */
export function markerPopupText([lat, lng]: LatLng, pointName?: string): string {
  return pointName
    ? `${pointName} (lon, lat):\n(${lng.toFixed(6)}, ${lat.toFixed(6)})`
    : `Reference (lon, lat):\n(${lng.toFixed(6)}, ${lat.toFixed(6)})`;
}

export const pointClickActions = (pointId: string): AppAction[] => [
  { type: 'SET_SELECTED_POINT', payload: pointId },
];

export const pointDragEndActions = (pointId: string, position: LatLng): AppAction[] => [
  { type: 'UPDATE_TIME_SERIES_POINT', payload: { id: pointId, updates: { position } } },
];

export const pointDoubleClickActions = (pointId: string): AppAction[] => [
  { type: 'REMOVE_TIME_SERIES_POINT', payload: pointId },
];

export interface RefApi {
  fetchPointTimeSeries: (lon: number, lat: number, ds: string) => Promise<number[] | undefined>;
  fetchBufferTimeSeries: (
    lon: number, lat: number, ds: string, bufferM: number, nSamples: number,
  ) => Promise<{ median?: { x: string; y: number }[]; labels?: string[] } | undefined>;
}

/**
 * Reference marker dropped at ``position``: move it, then (for "shift" datasets)
 * fetch the reference time series, as the buffer median when the reference buffer is
 * on, else at the point. Dispatches as it goes so the marker moves immediately.
 */
export async function refDragEnd(
  state: Pick<AppState, 'currentDataset' | 'datasetInfo' | 'refBufferEnabled' | 'refBufferRadius'>,
  position: LatLng,
  api: RefApi,
  dispatch: (a: AppAction) => void,
): Promise<void> {
  const [lat, lng] = position;
  dispatch({ type: 'SET_REF_MARKER_POSITION', payload: [lat, lng] });
  const ds = state.currentDataset;
  const info = ds ? state.datasetInfo[ds] : null;
  if (!ds || info?.algorithm !== 'shift') return;
  try {
    let values: number[] | undefined;
    if (state.refBufferEnabled && state.refBufferRadius > 0) {
      const result = await api.fetchBufferTimeSeries(lng, lat, ds, state.refBufferRadius, 0);
      if (result?.median) {
        const xValues = state.datasetInfo[ds]?.x_values?.map(String) ?? result.labels?.map(String) ?? [];
        const byX = Object.fromEntries(result.median.map(pt => [String(pt.x), pt.y]));
        values = xValues.map((x: string) => byX[x] ?? NaN);
      }
    }
    if (!values) values = await api.fetchPointTimeSeries(lng, lat, ds);
    if (values) dispatch({ type: 'SET_REF_VALUES', payload: { dataset: ds, values } });
  } catch (err) {
    console.error('Error updating reference values after drag:', err);
  }
}

/** Pixel-inspect hover: which dataset/time step to read, and the /point URL for it. */
export function pixelInspectRequest(
  state: Pick<AppState, 'currentDataset' | 'splitScreen' | 'splitDataset' | 'splitPosition'
    | 'splitTimeIndex' | 'currentTimeIndex'>,
  [lat, lng]: LatLng,
  containerX: number,
  mapWidth: number,
): { dataset: string; onRight: boolean; url: string } | null {
  if (!state.currentDataset) return null;
  const onRight = !!(state.splitScreen && state.splitDataset && containerX > mapWidth * state.splitPosition);
  const dataset = onRight ? state.splitDataset! : state.currentDataset;
  const params = new URLSearchParams({
    dataset_name: dataset,
    lon: lng.toFixed(6),
    lat: lat.toFixed(6),
    time_idx: String(onRight ? state.splitTimeIndex : state.currentTimeIndex),
  });
  return { dataset, onRight, url: `/point?${params}` };
}

/** Pixel-inspect tooltip text for a value (``nodata`` when missing). */
export function pixelInspectText(
  val: number | null | undefined, unit: string, splitScreen: boolean, onRight: boolean,
): string {
  if (val === undefined || val === null || !isFinite(val)) return 'nodata';
  const valStr = unit ? `${val.toPrecision(4)} ${unit}` : val.toPrecision(4);
  return splitScreen ? `${onRight ? 'R' : 'L'}: ${valStr}` : valStr;
}
