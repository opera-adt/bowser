/** Turning the Draw tools on must not flash Geoman's own toolbar on the left. */
import { useEffect } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';

const created = vi.hoisted(() => ({ geomanOptions: undefined as any, editorOptions: undefined as any }));
vi.mock('@geoman-io/maplibre-geoman-free', () => ({
  Geoman: class {
    actionInstances = { helper__snapping: {} };
    constructor(_map: unknown, options: unknown) { created.geomanOptions = options; }
    destroy() {}
  },
}));
vi.mock('@geoman-io/maplibre-geoman-free/dist/maplibre-geoman.css', () => ({}));
vi.mock('maplibre-gl-geo-editor/style.css', () => ({}));
vi.mock('maplibre-gl-geo-editor', () => ({
  GeoEditor: class {
    constructor(options: unknown) { created.editorOptions = options; }
    setGeoman() {}
    getAllFeatureCollection() { return { type: 'FeatureCollection', features: [] }; }
    async loadGeoJson() {}
  },
}));

import { useDrawTools } from './drawTools';

const container = document.createElement('div');
const map = {
  once: (_: string, cb: () => void) => cb(),
  addControl: () => {}, removeControl: () => {}, getContainer: () => container,
} as any;

function Host() {
  const { dispatch } = useAppContext();
  useEffect(() => { dispatch({ type: 'SET_DRAWING_ENABLED', payload: true }); }, [dispatch]);
  useDrawTools(map, true);
  return null;
}

afterEach(() => { cleanup(); created.geomanOptions = undefined; created.editorOptions = undefined; });

describe('Draw tools toolbar', () => {
  it('starts Geoman without its own toolbar, so only the editor toolbar (top right) appears', async () => {
    render(<AppProvider><Host /></AppProvider>);
    await waitFor(() => expect(created.editorOptions).toBeDefined());
    expect(created.geomanOptions?.settings?.useControlsUi).toBe(false);
    expect(created.editorOptions.position).toBe('top-right');
  });
});
