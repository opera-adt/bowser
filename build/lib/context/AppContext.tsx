import React, { createContext, useContext, useReducer, ReactNode } from 'react';
import { AppState, AppAction, LegacyAppAction, TimeSeriesPoint } from '../types';

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
  dataMode: 'md',
  colormap: 'rdbu_r',
  vmin: 0,
  vmax: 1,
  opacity: 1,
  showChart: false,
  selectedPointId: null,
  showTrends: false,
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
    case 'TOGGLE_CHART':
      return { ...state, showChart: !state.showChart };
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
