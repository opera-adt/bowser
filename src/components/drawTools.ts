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
  // The chart's "+ Area" waits for the next polygon drawn (read in the editor's callback).
  const areaDrawingRef = useRef(state.areaDrawing);
  areaDrawingRef.current = state.areaDrawing;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onCreate = (feature: any) => {
      sync();
      const geometry = feature?.geometry;
      if (areaDrawingRef.current && (geometry?.type === 'Polygon' || geometry?.type === 'MultiPolygon')) {
        dispatch({ type: 'ADD_CHART_AREA', payload: { geometry } });
      }
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
        onFeatureCreate: onCreate,
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
      // Polygon mode only once the editor's snapping helper has started: switching modes while it
      // is still starting makes Geoman start it twice ("Action instance already exists").
      for (let i = 0; i < 20 && !geoman.actionInstances?.helper__snapping; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (cancelled) return;
      editorRef.current = editor;
      if (areaDrawingRef.current) editor.enableDrawMode('polygon');
    })().catch(err => {
      console.error('Drawing tools failed to load:', err);
      dispatch({ type: 'SET_OVERLAY_MESSAGE', payload: `Drawing tools could not load: ${(err as Error).message}` });
      dispatch({ type: 'SET_DRAWING_ENABLED', payload: false });
    });

    return () => {
      cancelled = true;
      editorRef.current = null;
      CONTAINER_EVENTS.forEach(ev => container.removeEventListener(ev, sync));
      if (editor) {
        sync();
        try { map.removeControl(editor); } catch { /* map already gone */ }
      }
      try { geoman?.destroy({ removeSources: true }); } catch { /* map already gone */ }
    };
  }, [ready, map, enabled, dispatch]);

  // "+ Area" while the tools are already open: start a polygon now.
  useEffect(() => {
    if (state.areaDrawing) editorRef.current?.enableDrawMode('polygon');
  }, [state.areaDrawing]);

}
