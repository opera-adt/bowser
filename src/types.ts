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
  reference_date?: string | null;
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

export interface ClickedPointTimeseries {
  pointId: number;
  timeseries: Array<{ date: string; displacement: number }>;
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
  // V2 point layer state
  activePointLayer: string | null;
  pointLayerBounds: [number, number, number, number] | null;
  clickedPoints: ClickedPointTimeseries[];
  pointColorBy: string;
  pointVmin: number;
  pointVmax: number;
  pointAttributes: Record<string, { type: string; min?: number; max?: number; mean?: number; count?: number }>;
  pointFilter: string;
  pointBasemap: 'satellite' | 'osm' | 'dark';
  pointColormap: string;
  referencePointId: number | null;
  referenceTimeseries: Array<{ date: string; displacement: number }>;
  // Histogram bins for current color-by attribute
  pointHistogram: { edges: number[]; counts: number[] } | null;
  // Chart theme
  chartTheme: 'dark' | 'light';
  // Layer visibility
  rasterLayerVisible: boolean;
  pointLayerVisible: boolean;
  pointOpacity: number;
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
  // V2 point layer actions
  | { type: 'SET_ACTIVE_POINT_LAYER'; payload: string }
  | { type: 'SET_POINT_LAYER_BOUNDS'; payload: [number, number, number, number] }
  | { type: 'SET_CLICKED_POINT_TIMESERIES'; payload: ClickedPointTimeseries }
  | { type: 'CLEAR_CLICKED_POINTS' }
  | { type: 'REMOVE_CLICKED_POINT'; payload: number }
  | { type: 'SET_POINT_COLOR_BY'; payload: string }
  | { type: 'SET_POINT_VMIN'; payload: number }
  | { type: 'SET_POINT_VMAX'; payload: number }
  | { type: 'SET_POINT_ATTRIBUTES'; payload: Record<string, { type: string; min?: number; max?: number; mean?: number; count?: number }> }
  | { type: 'SET_POINT_FILTER'; payload: string }
  | { type: 'SET_POINT_BASEMAP'; payload: 'satellite' | 'osm' | 'dark' }
  | { type: 'SET_POINT_COLORMAP'; payload: string }
  | { type: 'SET_REFERENCE_POINT'; payload: { pointId: number; timeseries: Array<{ date: string; displacement: number }> } }
  | { type: 'CLEAR_REFERENCE_POINT' }
  | { type: 'SET_CHART_THEME'; payload: 'dark' | 'light' }
  | { type: 'SET_POINT_HISTOGRAM'; payload: { edges: number[]; counts: number[] } | null }
  | { type: 'SET_RASTER_LAYER_VISIBLE'; payload: boolean }
  | { type: 'SET_POINT_LAYER_VISIBLE'; payload: boolean }
  | { type: 'SET_POINT_OPACITY'; payload: number };

// Backward compatibility
export type LegacyAppAction = { type: 'SET_TS_MARKER_POSITION'; payload: [number, number] };
