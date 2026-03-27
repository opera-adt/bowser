import { useEffect, useRef } from 'react';
import { useAppContext } from '../context/AppContext';
import { AppAction } from '../types';

// Keys we serialize to URL
const URL_KEYS = [
  'colorBy', 'vmin', 'vmax', 'colormap', 'basemap', 'filter',
  'lat', 'lon', 'zoom', 'theme',
] as const;

/**
 * Parse URL search params into partial state overrides.
 * Called once on mount to restore a shared view.
 */
export function parseUrlState(): Record<string, string> {
  const params = new URLSearchParams(window.location.search);
  const result: Record<string, string> = {};
  for (const key of URL_KEYS) {
    const val = params.get(key);
    if (val !== null) result[key] = val;
  }
  return result;
}

/**
 * Hook that syncs relevant app state to the URL search params.
 * Updates URL with history.replaceState (no page reload, no history spam).
 */
export function useUrlStateSync() {
  const { state } = useAppContext();
  const isFirstRender = useRef(true);

  useEffect(() => {
    // Skip the first render — let parseUrlState handle initial load
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    const params = new URLSearchParams();

    // Point viz state
    if (state.pointColorBy && state.pointColorBy !== 'velocity') {
      params.set('colorBy', state.pointColorBy);
    }
    if (state.pointVmin !== -10) params.set('vmin', state.pointVmin.toFixed(2));
    if (state.pointVmax !== 10) params.set('vmax', state.pointVmax.toFixed(2));
    if (state.pointColormap !== 'rdbu_r') params.set('colormap', state.pointColormap);
    if (state.pointBasemap !== 'satellite') params.set('basemap', state.pointBasemap);
    if (state.pointFilter) params.set('filter', state.pointFilter);
    if (state.chartTheme !== 'dark') params.set('theme', state.chartTheme);

    const search = params.toString();
    const url = search ? `?${search}` : window.location.pathname;
    window.history.replaceState(null, '', url);
  }, [
    state.pointColorBy, state.pointVmin, state.pointVmax,
    state.pointColormap, state.pointBasemap, state.pointFilter,
    state.chartTheme,
  ]);
}

/**
 * Apply URL params to the app state during initialization.
 * Call this after the default init in App.tsx.
 */
export function applyUrlState(
  dispatch: React.Dispatch<AppAction>,
  urlState: Record<string, string>,
) {
  if (urlState.colorBy) {
    dispatch({ type: 'SET_POINT_COLOR_BY', payload: urlState.colorBy });
  }
  if (urlState.vmin) {
    dispatch({ type: 'SET_POINT_VMIN', payload: parseFloat(urlState.vmin) });
  }
  if (urlState.vmax) {
    dispatch({ type: 'SET_POINT_VMAX', payload: parseFloat(urlState.vmax) });
  }
  if (urlState.colormap) {
    dispatch({ type: 'SET_POINT_COLORMAP', payload: urlState.colormap });
  }
  if (urlState.basemap) {
    dispatch({ type: 'SET_POINT_BASEMAP', payload: urlState.basemap as 'satellite' | 'osm' | 'dark' });
  }
  if (urlState.filter) {
    dispatch({ type: 'SET_POINT_FILTER', payload: urlState.filter });
  }
  if (urlState.theme === 'light') {
    dispatch({ type: 'SET_CHART_THEME', payload: 'light' });
  }
}
