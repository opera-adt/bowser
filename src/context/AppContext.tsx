import React, { createContext, useContext, useReducer, ReactNode } from 'react';
import { AppState, AppAction, LegacyAppAction, TimeSeriesPoint, ChartWindow } from '../types';

// Color palette for different points
const POINT_COLORS = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
  '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'
];

// Generate unique ID for points
function generatePointId(): string {
  return `point_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Get next available color
function getNextColor(existingPoints: TimeSeriesPoint[]): string {
  const usedColors = new Set(existingPoints.map(p => p.color));
  return POINT_COLORS.find(color => !usedColors.has(color)) || POINT_COLORS[existingPoints.length % POINT_COLORS.length];
}

const initialState: AppState = {
  datasetInfo: {},
  timeSeriesPoints: [],
  refMarkerPosition: [0, 0],
  currentDataset: '',
  currentTimeIndex: 0,
  refValues: {},
  selectedBasemap: 'esriSatellite',
  secondaryBasemap: null,
  basemapOpacity: 1,
  secondaryBasemapOpacity: 0.7,
  basemapSwapped: false,
  dataMode: 'md',
  colormap: 'rdbu_r',
  vmin: 0,
  vmax: 1,
  opacity: 1,
  showChart: false,
  chartWindows: [],
  selectedPointId: null,
  showTrends: false,
  showResiduals: false,
  layerMasks: [],
  customMaskPath: null,
  bufferEnabled: false,
  bufferRadius: 500,
  bufferSamples: 10,
  refEnabled: true,
  refMarkerVisible: true,
  refBufferEnabled: false,
  refBufferRadius: 500,
  showRefChart: false,
  markerSize: 4,
  dateRangeStart: null,
  dateRangeEnd: null,
  viewBounds: null,
  viewBoundsApplySeq: 0,
  showColorbar: false,
  showLosIndicator: false,
  graticuleMode: 'off',
  wrapEnabled: false,
  wrapWavelength: null,
  wrapPeriod: 2 * Math.PI,
  complexMode: 'phase',
  pointPickingEnabled: true,
  annotationMode: false,
  annotations: [],
};

function appReducer(state: AppState, action: AppAction | LegacyAppAction): AppState {
  switch (action.type) {
    case 'SET_DATASETS':
      return { ...state, datasetInfo: action.payload };

    // Multi-point actions
    case 'ADD_TIME_SERIES_POINT': {
      const id = generatePointId();
      const color = getNextColor(state.timeSeriesPoints);
      const name = action.payload.name || `Point ${state.timeSeriesPoints.length + 1}`;
      const newPoint: TimeSeriesPoint = {
        id,
        name,
        position: action.payload.position,
        color,
        visible: true,
        data: {},
        trendData: {},
      };
      return {
        ...state,
        timeSeriesPoints: [...state.timeSeriesPoints, newPoint],
        selectedPointId: id,
      };
    }

    case 'REMOVE_TIME_SERIES_POINT':
      return {
        ...state,
        timeSeriesPoints: state.timeSeriesPoints.filter(p => p.id !== action.payload),
        selectedPointId: state.selectedPointId === action.payload ? null : state.selectedPointId,
      };

    case 'UPDATE_TIME_SERIES_POINT':
      return {
        ...state,
        timeSeriesPoints: state.timeSeriesPoints.map(p =>
          p.id === action.payload.id ? { ...p, ...action.payload.updates } : p
        ),
      };

    case 'SET_POINT_DATA':
      return {
        ...state,
        timeSeriesPoints: state.timeSeriesPoints.map(p =>
          p.id === action.payload.pointId
            ? {
                ...p,
                data: {
                  ...p.data,
                  [action.payload.dataset]: action.payload.data
                }
              }
            : p
        ),
      };

    case 'SET_POINT_TREND_DATA':
      return {
        ...state,
        timeSeriesPoints: state.timeSeriesPoints.map(p =>
          p.id === action.payload.pointId
            ? {
                ...p,
                trendData: {
                  ...p.trendData,
                  [action.payload.dataset]: action.payload.trend
                }
              }
            : p
        ),
      };

    case 'SET_SELECTED_POINT':
      return { ...state, selectedPointId: action.payload };

    case 'TOGGLE_TRENDS':
      return { ...state, showTrends: !state.showTrends };

    // Backward compatibility for legacy single point
    case 'SET_TS_MARKER_POSITION': {
      // Convert legacy single point to multi-point system
      const existingPoint = state.timeSeriesPoints.find(p => p.name === 'Legacy Point');
      if (existingPoint) {
        return {
          ...state,
          timeSeriesPoints: state.timeSeriesPoints.map(p =>
            p.id === existingPoint.id ? { ...p, position: action.payload } : p
          ),
        };
      } else {
        // Add as new point if no legacy point exists
        const id = generatePointId();
        const color = getNextColor(state.timeSeriesPoints);
        const newPoint: TimeSeriesPoint = {
          id,
          name: 'Legacy Point',
          position: action.payload,
          color,
          visible: true,
          data: {},
          trendData: {},
        };
        return {
          ...state,
          timeSeriesPoints: [...state.timeSeriesPoints, newPoint],
          selectedPointId: id,
        };
      }
    }

    case 'SET_REF_MARKER_POSITION':
      return { ...state, refMarkerPosition: action.payload };
    case 'SET_CURRENT_DATASET':
      return { ...state, currentDataset: action.payload };
    case 'SET_TIME_INDEX':
      return { ...state, currentTimeIndex: action.payload };
    case 'SET_REF_VALUES':
      return {
        ...state,
        refValues: {
          ...state.refValues,
          [action.payload.dataset]: action.payload.values,
        },
      };
    case 'SET_BASEMAP':
      return { ...state, selectedBasemap: action.payload };
    case 'SET_SECONDARY_BASEMAP':
      return { ...state, secondaryBasemap: action.payload };
    case 'SET_BASEMAP_OPACITY':
      return { ...state, basemapOpacity: action.payload };
    case 'SET_SECONDARY_BASEMAP_OPACITY':
      return { ...state, secondaryBasemapOpacity: action.payload };
    case 'TOGGLE_BASEMAP_SWAP':
      return { ...state, basemapSwapped: !state.basemapSwapped };
    case 'SET_DATA_MODE':
      return { ...state, dataMode: action.payload };
    case 'SET_COLORMAP':
      return { ...state, colormap: action.payload };
    case 'SET_VMIN':
      return { ...state, vmin: action.payload };
    case 'SET_VMAX':
      return { ...state, vmax: action.payload };
    case 'SET_OPACITY':
      return { ...state, opacity: action.payload };
    case 'TOGGLE_RESIDUALS':
      return { ...state, showResiduals: !state.showResiduals };
    case 'ADD_LAYER_MASK':
      return { ...state, layerMasks: [...state.layerMasks, action.payload] };
    case 'REMOVE_LAYER_MASK':
      return { ...state, layerMasks: state.layerMasks.filter(m => m.id !== action.payload) };
    case 'UPDATE_LAYER_MASK':
      return {
        ...state,
        layerMasks: state.layerMasks.map(m =>
          m.id === action.payload.id ? { ...m, ...action.payload.updates } : m
        ),
      };
    case 'SET_CUSTOM_MASK_PATH':
      return { ...state, customMaskPath: action.payload };
    case 'TOGGLE_BUFFER':
      return { ...state, bufferEnabled: !state.bufferEnabled };
    case 'SET_BUFFER_RADIUS':
      return { ...state, bufferRadius: action.payload };
    case 'SET_BUFFER_SAMPLES':
      return { ...state, bufferSamples: action.payload };
    case 'TOGGLE_REF_ENABLED':
      return { ...state, refEnabled: !state.refEnabled };
    case 'TOGGLE_REF_MARKER_VISIBLE':
      return { ...state, refMarkerVisible: !state.refMarkerVisible };
    case 'TOGGLE_REF_BUFFER':
      return { ...state, refBufferEnabled: !state.refBufferEnabled };
    case 'SET_REF_BUFFER_RADIUS':
      return { ...state, refBufferRadius: action.payload };
    case 'TOGGLE_REF_CHART':
      return { ...state, showRefChart: !state.showRefChart };
    case 'SET_MARKER_SIZE':
      return { ...state, markerSize: action.payload };
    case 'SET_DATE_RANGE_START':
      return { ...state, dateRangeStart: action.payload };
    case 'SET_DATE_RANGE_END':
      return { ...state, dateRangeEnd: action.payload };
    case 'SET_VIEW_BOUNDS':
      return { ...state, viewBounds: action.payload };
    case 'APPLY_VIEW_BOUNDS':
      return {
        ...state,
        viewBounds: action.payload,
        viewBoundsApplySeq: state.viewBoundsApplySeq + 1,
      };
    case 'TOGGLE_COLORBAR':
      return { ...state, showColorbar: !state.showColorbar };
    case 'TOGGLE_LOS_INDICATOR':
      return { ...state, showLosIndicator: !state.showLosIndicator };
    case 'TOGGLE_WRAP':
      return { ...state, wrapEnabled: !state.wrapEnabled };
    case 'SET_WRAP_WAVELENGTH':
      return { ...state, wrapWavelength: action.payload };
    case 'SET_WRAP_PERIOD':
      return { ...state, wrapPeriod: action.payload };
    case 'SET_COMPLEX_MODE':
      return { ...state, complexMode: action.payload };
    case 'TOGGLE_POINT_PICKING':
      return { ...state, pointPickingEnabled: !state.pointPickingEnabled };
    case 'TOGGLE_ANNOTATION_MODE':
      return { ...state, annotationMode: !state.annotationMode };
    case 'ADD_ANNOTATION':
      return { ...state, annotations: [...state.annotations, action.payload] };
    case 'REMOVE_ANNOTATION':
      return { ...state, annotations: state.annotations.filter(a => a.id !== action.payload) };
    case 'UPDATE_ANNOTATION':
      return {
        ...state,
        annotations: state.annotations.map(a =>
          a.id === action.payload.id ? { ...a, ...action.payload.updates } : a
        ),
      };
    case 'CYCLE_GRATICULE': {
      const next = state.graticuleMode === 'off' ? 'plain'
                 : state.graticuleMode === 'plain' ? 'zebra'
                 : 'off';
      return { ...state, graticuleMode: next };
    }
    case 'ADD_CHART_WINDOW':
      return { ...state, chartWindows: [...state.chartWindows, action.payload] };
    case 'REMOVE_CHART_WINDOW':
      return { ...state, chartWindows: state.chartWindows.filter(w => w.id !== action.payload) };
    case 'SET_CHART_WINDOW_DS':
      return {
        ...state,
        chartWindows: state.chartWindows.map(w =>
          w.id === action.payload.id ? { ...w, dsNames: action.payload.dsNames } : w
        ),
      };
    case 'TOGGLE_CHART': {
      const opening = !state.showChart;
      const firstWindow: ChartWindow = { id: `chart_${Date.now()}`, dsNames: [] };
      return {
        ...state,
        showChart: opening,
        chartWindows: opening && state.chartWindows.length === 0 ? [firstWindow] : state.chartWindows,
      };
    }
    default:
      return state;
  }
}

interface AppContextType {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialState);

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useAppContext must be used within an AppProvider');
  }
  return context;
}
