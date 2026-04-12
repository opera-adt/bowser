export interface RasterGroup {
  name: string;
  file_list: string[];
  mask_file_list: string[];
  mask_min_value: number;
  nodata: number | null;
  uses_spatial_ref: boolean;
  algorithm: string | null;
  latlon_bounds: [number, number, number, number];
  x_values: Array<number | string>;
  available_mask_vars: string[];
  label?: string;
  unit?: string;
}

export interface TimeSeriesPoint {
  id: string;
  name: string;
  position: [number, number]; // [lat, lng]
  color: string;
  visible: boolean;
  data?: { [dataset: string]: number[] };
  trendData?: { [dataset: string]: { slope: number; intercept: number; rSquared: number; mmPerYear: number } };
}

export interface MultiPointTimeSeriesData {
  labels: string[];
  datasets: {
    label: string;
    pointId: string;
    data: Array<{ x: string; y: number }>;
    borderColor: string;
    backgroundColor: string;
    trend?: {
      slope: number;
      intercept: number;
      rSquared: number;
      mmPerYear: number;
    };
  }[];
}

export interface BaseMapItem {
  url: string;
  attribution: string;
}

export interface LayerMask {
  id: string;
  dataset: string;
  threshold: number;
  mode: 'min' | 'max';  // 'min' = keep pixels >= threshold; 'max' = keep pixels <= threshold
}

export interface AppState {
  datasetInfo: { [key: string]: RasterGroup };
  timeSeriesPoints: TimeSeriesPoint[];
  refMarkerPosition: [number, number];
  currentDataset: string;
  currentTimeIndex: number;
  refValues: { [key: string]: number[] };
  selectedBasemap: string;
  dataMode: string;
  colormap: string;
  vmin: number;
  vmax: number;
  opacity: number;
  showChart: boolean;
  selectedPointId: string | null;
  showTrends: boolean;
  showResiduals: boolean;
  layerMasks: LayerMask[];
  customMaskPath: string | null;
  bufferEnabled: boolean;
  bufferRadius: number;
  bufferSamples: number;
  pickingEnabled: boolean;
  refEnabled: boolean;
  refBufferEnabled: boolean;
  refBufferRadius: number;
  showRefChart: boolean;
  isPlaying: boolean;
  animationSpeed: number;
}

export type AppAction =
  | { type: 'SET_DATASETS'; payload: { [key: string]: RasterGroup } }
  | { type: 'ADD_TIME_SERIES_POINT'; payload: { position: [number, number]; name?: string } }
  | { type: 'REMOVE_TIME_SERIES_POINT'; payload: string }
  | { type: 'UPDATE_TIME_SERIES_POINT'; payload: { id: string; updates: Partial<TimeSeriesPoint> } }
  | { type: 'SET_POINT_DATA'; payload: { pointId: string; dataset: string; data: number[] } }
  | { type: 'SET_POINT_TREND_DATA'; payload: { pointId: string; dataset: string; trend: { slope: number; intercept: number; rSquared: number; mmPerYear: number } } }
  | { type: 'SET_REF_MARKER_POSITION'; payload: [number, number] }
  | { type: 'SET_CURRENT_DATASET'; payload: string }
  | { type: 'SET_TIME_INDEX'; payload: number }
  | { type: 'SET_REF_VALUES'; payload: { dataset: string; values: number[] } }
  | { type: 'SET_BASEMAP'; payload: string }
  | { type: 'SET_DATA_MODE'; payload: string }
  | { type: 'SET_COLORMAP'; payload: string }
  | { type: 'SET_VMIN'; payload: number }
  | { type: 'SET_VMAX'; payload: number }
  | { type: 'SET_OPACITY'; payload: number }
  | { type: 'TOGGLE_CHART' }
  | { type: 'SET_SELECTED_POINT'; payload: string | null }
  | { type: 'TOGGLE_TRENDS' }
  | { type: 'TOGGLE_RESIDUALS' }
  | { type: 'ADD_LAYER_MASK'; payload: LayerMask }
  | { type: 'REMOVE_LAYER_MASK'; payload: string }
  | { type: 'UPDATE_LAYER_MASK'; payload: { id: string; updates: Partial<LayerMask> } }
  | { type: 'SET_CUSTOM_MASK_PATH'; payload: string | null }
  | { type: 'TOGGLE_BUFFER' }
  | { type: 'SET_BUFFER_RADIUS'; payload: number }
  | { type: 'SET_BUFFER_SAMPLES'; payload: number }
  | { type: 'TOGGLE_PICKING' }
  | { type: 'TOGGLE_REF_ENABLED' }
  | { type: 'TOGGLE_REF_BUFFER' }
  | { type: 'SET_REF_BUFFER_RADIUS'; payload: number }
  | { type: 'TOGGLE_REF_CHART' }
  | { type: 'TOGGLE_PLAYING' }
  | { type: 'SET_PLAYING'; payload: boolean }
  | { type: 'SET_ANIMATION_SPEED'; payload: number };

// Backward compatibility
export type LegacyAppAction = { type: 'SET_TS_MARKER_POSITION'; payload: [number, number] };
