/**
 * Drawing on the MapLibre map with GeoLibre's editor (maplibre-gl-geo-editor on Geoman
 * Free): polygons, lines, rectangles, circles, markers and freehand, then select, move,
 * edit, rotate, cut, scale, copy, split, union, difference, simplify and lasso, with undo.
 *
 * While the tools are on, Geoman owns the shapes and every change is copied into the
 * "Drawings" overlay (DRAWINGS_ID). When they go off, that overlay draws the shapes like
 * any vector layer, so they can be reordered, styled, saved in a project and exported.
 * The editor and Geoman are loaded only when the tools are first turned on.
 */
import { useEffect, useRef } from 'react';
import type * as maplibregl from 'maplibre-gl';
import { useAppContext } from '../context/AppContext';
import { DRAWINGS_ID } from '../map/overlays';
import type { OverlayFeatures } from '../types';

const DRAW_MODES = ['polygon', 'line', 'rectangle', 'circle', 'marker', 'freehand'];
const EDIT_MODES = ['select', 'drag', 'change', 'rotate', 'cut', 'delete', 'scale', 'copy', 'split', 'union', 'difference', 'simplify', 'lasso'];
/** Operations the editor reports only as events on the map container. */
const CONTAINER_EVENTS = ['gm:union', 'gm:split', 'gm:simplify', 'gm:difference', 'gm:lassoend'];

export function useDrawTools(map: maplibregl.Map | null, ready: boolean) {
  const { state, dispatch } = useAppContext();
  const enabled = state.drawingEnabled;
  // The shapes to load when the tools open (read at that moment, not a dependency).
  const drawingsRef = useRef<OverlayFeatures | undefined>(undefined);
  drawingsRef.current = state.overlays.find(o => o.id === DRAWINGS_ID)?.data;

  useEffect(() => {
    if (!ready || !map || !enabled) return;
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let editor: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let geoman: any = null;
    const sync = () => {
      if (!editor) return;
      const fc = editor.getAllFeatureCollection() as OverlayFeatures;
      dispatch({ type: 'SET_DRAWINGS', payload: fc });
    };
    const container = map.getContainer();

    (async () => {
      const [{ Geoman }, { GeoEditor }] = await Promise.all([
        import('@geoman-io/maplibre-geoman-free'),
        import('maplibre-gl-geo-editor'),
        import('@geoman-io/maplibre-geoman-free/dist/maplibre-geoman.css'),
        import('maplibre-gl-geo-editor/style.css'),
      ]);
      if (cancelled) return;
      geoman = new Geoman(map, {});
      await new Promise<void>(resolve => map.once('gm:loaded' as never, () => resolve()));
      if (cancelled) { geoman.destroy({ removeSources: true }); return; }
      editor = new GeoEditor({
        position: 'top-right',
        toolbarOrientation: 'vertical',
        columns: 2,
        drawModes: DRAW_MODES,
        editModes: EDIT_MODES,
        showFeatureProperties: false,
        fitBoundsOnLoad: false,
        onFeatureCreate: sync,
        onFeatureEdit: sync,
        onFeatureDelete: sync,
        onHistoryChange: sync,
      } as never);
      editor.setGeoman(geoman);
      // Top right, under the Points button: the left side holds the map tools and the sidebar toggle.
      map.addControl(editor, 'top-right');
      const saved = drawingsRef.current;
      if (saved?.features.length) await editor.loadGeoJson(saved);
      CONTAINER_EVENTS.forEach(ev => container.addEventListener(ev, sync));
    })().catch(err => {
      console.error('Drawing tools failed to load:', err);
      dispatch({ type: 'SET_OVERLAY_MESSAGE', payload: `Drawing tools could not load: ${(err as Error).message}` });
      dispatch({ type: 'SET_DRAWING_ENABLED', payload: false });
    });

    return () => {
      cancelled = true;
      CONTAINER_EVENTS.forEach(ev => container.removeEventListener(ev, sync));
      if (editor) {
        sync();
        try { map.removeControl(editor); } catch { /* map already gone */ }
      }
      try { geoman?.destroy({ removeSources: true }); } catch { /* map already gone */ }
    };
  }, [ready, map, enabled, dispatch]);

}
