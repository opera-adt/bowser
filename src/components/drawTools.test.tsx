/** The Draw tools and the chart's + Area: the next polygon drawn becomes a chart area. */
import { useEffect } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import type { AppState } from '../types';

const editor = vi.hoisted(() => ({ options: null as any, modes: [] as string[] }));
vi.mock('@geoman-io/maplibre-geoman-free', () => ({ Geoman: class { actionInstances = { helper__snapping: {} }; destroy() {} } }));
vi.mock('@geoman-io/maplibre-geoman-free/dist/maplibre-geoman.css', () => ({}));
vi.mock('maplibre-gl-geo-editor/style.css', () => ({}));
vi.mock('maplibre-gl-geo-editor', () => ({
  GeoEditor: class {
    constructor(options: unknown) { editor.options = options; }
    setGeoman() {}
    getAllFeatureCollection() { return { type: 'FeatureCollection', features: [] }; }
    async loadGeoJson() {}
    enableDrawMode(mode: string) { editor.modes.push(mode); }
  },
}));

import { useDrawTools } from './drawTools';

const SQUARE = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
const container = document.createElement('div');
const map = {
  once: (_: string, cb: () => void) => cb(),
  addControl: () => {}, removeControl: () => {}, getContainer: () => container,
} as any;

let stateRef: AppState;
function Host({ areaDrawing }: { areaDrawing: boolean }) {
  const { state, dispatch } = useAppContext();
  stateRef = state;
  useEffect(() => {
    dispatch(areaDrawing ? { type: 'SET_AREA_DRAWING', payload: true } : { type: 'SET_DRAWING_ENABLED', payload: true });
  }, [areaDrawing, dispatch]);
  useDrawTools(map, true);
  return null;
}

afterEach(() => { cleanup(); editor.options = null; editor.modes = []; });

describe('drawing an area for the chart', () => {
  it('opens the tools in polygon mode and adds the finished polygon to the chart', async () => {
    render(<AppProvider><Host areaDrawing /></AppProvider>);
    await waitFor(() => expect(editor.modes).toContain('polygon'));
    act(() => editor.options.onFeatureCreate({ type: 'Feature', properties: {}, geometry: SQUARE }));
    expect(stateRef.chartAreas.map(a => [a.name, a.geometry])).toEqual([['Area 1', SQUARE]]);
    expect(stateRef.areaDrawing).toBe(false);
    expect(stateRef.drawingEnabled).toBe(false);  // "+ Area" opened the tools, so they close again
    // The next shape is an ordinary drawing.
    act(() => editor.options.onFeatureCreate({ type: 'Feature', properties: {}, geometry: SQUARE }));
    expect(stateRef.chartAreas).toHaveLength(1);
  });

  it('leaves ordinary drawings out of the chart', async () => {
    render(<AppProvider><Host areaDrawing={false} /></AppProvider>);
    await waitFor(() => expect(editor.options).not.toBeNull());
    act(() => editor.options.onFeatureCreate({ type: 'Feature', properties: {}, geometry: SQUARE }));
    expect(stateRef.chartAreas).toHaveLength(0);
    expect(editor.modes).toEqual([]);
  });
});
