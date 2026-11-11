/**
 * The experimental GPU renderer's hook: decides tiles vs GPU (capability.ts, from
 * ``?render=``), loads the GPU runtime only when the GPU is chosen (zarrita, codecs and
 * colormap tables in their own chunks), keeps the custom layer's parameters in step
 * with the app state, and falls back to server tiles — without a reload — when the GPU
 * path fails (context loss, chunk errors, render errors, slow frames in ``auto``).
 *
 * A view the GPU path can't draw yet (see params.ts, or 3D terrain) is drawn with
 * tiles while it lasts; the GPU layer stays, empty, and draws again afterwards.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type * as maplibregl from 'maplibre-gl';
import { useAppContext } from '../../context/AppContext';
import { buildTileRequest } from '../../utils/tileParams';
import { chooseRenderer, gpuCaps, parseRenderMode, type Decision } from './capability';
import { gpuParamsFromTileQuery, type ParamsResult } from './params';
import type { GpuCubeLayer } from './layer';

type Runtime = typeof import('./runtime');

export interface GpuRenderStatus {
  /** The GPU layer draws the data; the tile layer should stay empty. */
  active: boolean;
  renderer: 'tiles' | 'gpu';
  reason: string;
  /** Show the debug label (only when ``?render=`` is in the address). */
  showLabel: boolean;
}

let logged = '';
function logOnce(msg: string, warn = false) {
  if (logged === msg) return;
  logged = msg;
  (warn ? console.warn : console.info)(`[bowser] data layer: ${msg}`);
}

/**
 * Which renderer draws the data layer of ``map``, and the GPU layer when it is the GPU.
 * ``blocked`` names a view the GPU layer can't draw (e.g. 3D terrain), or is null.
 */
export function useGpuRender(
  map: maplibregl.Map | null, ready: boolean, beforeId: () => string | undefined, blocked: string | null,
): GpuRenderStatus {
  const { state } = useAppContext();
  const search = typeof window !== 'undefined' ? window.location.search : '';
  const mode = useMemo(() => parseRenderMode(search), [search]);
  const datasetId = useMemo(() => new URLSearchParams(search).get('dataset'), [search]);
  const [decision, setDecision] = useState<Decision>(() => chooseRenderer(mode, gpuCaps));
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const layerRef = useRef<GpuCubeLayer | null>(null);
  const [layerReady, setLayerReady] = useState(0);
  const wantGpu = decision.renderer === 'gpu';

  const dataset = state.currentDataset;
  const dsInfo = dataset ? state.datasetInfo[dataset] : undefined;
  const params: ParamsResult = useMemo(() => {
    if (!wantGpu) return { ok: false, reason: decision.reason };
    if (blocked) return { ok: false, reason: `${blocked} not on the GPU path yet` };
    if (!dataset || !dsInfo) return { ok: false, reason: 'no dataset yet', wait: true };
    const { params: q } = buildTileRequest({
      dataset, dsInfo, timeIndex: state.currentTimeIndex, vmin: state.vmin, vmax: state.vmax,
      colormap: state.colormap, state, datasetId,
    });
    const r = gpuParamsFromTileQuery(q, state.dataMode);
    if (r.ok && runtime && !runtime.hasColormap(r.params.colormap)) {
      return { ok: false, reason: `colormap ${r.params.colormap} not on the GPU path yet` };
    }
    return r;
  }, [wantGpu, decision.reason, blocked, dataset, dsInfo, state, datasetId, runtime]);
  // Waiting for the state to settle keeps the GPU (drawing nothing), not tiles.
  const active = wantGpu && (params.ok || !!params.wait);

  const showLabel = new URLSearchParams(search).has('render');
  useEffect(() => {
    if (mode === 'tiles' && !showLabel) return;   // the default: nothing to say
    if (!wantGpu) logOnce(`tiles — ${decision.reason}`, decision.reason.startsWith('fell back'));
    else if (params.ok) logOnce(`GPU — ${decision.reason}`);
    else if (!params.wait) logOnce(`tiles for this view — ${params.reason}`);
  }, [mode, showLabel, wantGpu, decision, params]);

  // Load the runtime and add the layer once the GPU is chosen and the cube is known.
  const canStart = wantGpu && ready && !!map && !!dataset && state.dataMode === 'md';
  useEffect(() => {
    if (!canStart || !map || layerRef.current) return;
    let cancelled = false;
    const fallBack = (reason: string) => setDecision({ renderer: 'tiles', reason: `fell back to tiles: ${reason}` });
    import('./runtime').then(async rt => {
      if (cancelled) return;
      setRuntime(rt);
      const cube = await rt.GpuCube.open(`${window.location.origin}/zarr/`, dataset, datasetId);
      if (cancelled) return;
      const layer = new rt.GpuCubeLayer(cube, { watchSlowFrames: mode === 'auto', onFailure: fallBack });
      layerRef.current = layer;
      map.addLayer(layer, beforeId());
      setLayerReady(n => n + 1);
    }).catch(err => {
      if (!cancelled) fallBack((err as Error).message);
    });
    return () => { cancelled = true; };
  }, [canStart, map]);  // eslint-disable-line react-hooks/exhaustive-deps

  // After a fallback the GPU layer goes (its textures with it); tiles draw from then on.
  useEffect(() => {
    const layer = layerRef.current;
    if (wantGpu || !map || !layer) return;
    if (map.getLayer(layer.id)) map.removeLayer(layer.id);
    layerRef.current = null;
  }, [wantGpu, map]);

  useEffect(() => () => {
    const layer = layerRef.current;
    layerRef.current = null;
    try {
      if (map && layer && map.getLayer(layer.id)) map.removeLayer(layer.id);
    } catch { /* the map is already gone */ }
  }, [map]);

  // Only a real change reaches the layer (unrelated state changes re-run the memo).
  const paramsKey = params.ok ? JSON.stringify(params.params) : '';
  useEffect(() => {
    layerRef.current?.setParams(params.ok ? params.params : null, state.opacity);
  }, [paramsKey, state.opacity, layerReady]);  // eslint-disable-line react-hooks/exhaustive-deps

  return {
    active,
    renderer: active ? 'gpu' : 'tiles',
    reason: params.ok || params.wait ? decision.reason : params.reason,
    showLabel,
  };
}
