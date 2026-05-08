import { useEffect, useRef, useState } from 'react';
import { MapContainer as LeafletMapContainer, TileLayer, Marker, useMapEvents, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useApi } from '../hooks/useApi';
import { useAppContext } from '../context/AppContext';
import { baseMaps } from '../basemap';
import { MousePositionControl } from '../mouse';
import MeasureTool from './MeasureTool';
import { ProfileToolMap, useProfileContext } from './ProfileTool';
import Graticule from './Graticule';

// Fix for default markers in React Leaflet
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

const fontAwesomeIcon = L.divIcon({
  html: '<i class="fa-solid fa-location-dot fa-3x" style="color:#111; text-shadow: 0 0 4px white, 0 0 4px white;"></i>',
  iconSize: [20, 20],
  className: 'myDivIcon'
});

function MapEvents({ toolActive }: { toolActive: boolean }) {
  const { state, dispatch } = useAppContext();
  const { active: profileActive } = useProfileContext();
  const map = useMap();

  useMapEvents({
    click: (e) => {
      if (toolActive || profileActive) return;

      // Annotation mode: open an inline popup to enter text
      if (state.annotationMode) {
        const pos = e.latlng;
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:2px;min-width:180px;';

        const row1 = document.createElement('div');
        row1.style.cssText = 'display:flex;gap:6px;align-items:center;';
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'Annotation text…';
        input.style.cssText = 'flex:1;padding:3px 6px;border:1px solid #888;border-radius:4px;font-size:12px;min-width:0;';
        const colorPick = document.createElement('input');
        colorPick.type = 'color';
        colorPick.value = '#ffffff';
        colorPick.style.cssText = 'width:26px;height:22px;padding:0;border:none;cursor:pointer;background:none;flex-shrink:0;';
        const sizeLabel = document.createElement('span');
        sizeLabel.textContent = 'px';
        sizeLabel.style.cssText = 'font-size:11px;color:#aaa;flex-shrink:0;';
        const sizeInput = document.createElement('input');
        sizeInput.type = 'number';
        sizeInput.value = '13';
        sizeInput.min = '8';
        sizeInput.max = '72';
        sizeInput.style.cssText = 'width:40px;padding:2px 4px;border:1px solid #888;border-radius:4px;font-size:12px;flex-shrink:0;';
        row1.appendChild(input);
        row1.appendChild(colorPick);
        row1.appendChild(sizeInput);
        row1.appendChild(sizeLabel);

        const row2 = document.createElement('div');
        row2.style.cssText = 'display:flex;gap:4px;justify-content:flex-end;';
        const addBtn = document.createElement('button');
        addBtn.textContent = 'Add';
        addBtn.style.cssText = 'padding:2px 10px;cursor:pointer;font-size:12px;border:none;background:#5bc0be;color:#072a2d;border-radius:4px;font-weight:600;';
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = 'padding:2px 10px;cursor:pointer;font-size:12px;border:1px solid #888;background:none;color:#ccc;border-radius:4px;';
        row2.appendChild(cancelBtn);
        row2.appendChild(addBtn);
        wrap.appendChild(row1);
        wrap.appendChild(row2);

        const popup = L.popup({ closeButton: false, closeOnClick: false })
          .setLatLng(pos).setContent(wrap).openOn(map);
        setTimeout(() => input.focus(), 50);

        const commit = () => {
          const text = input.value.trim();
          if (text) {
            dispatch({
              type: 'ADD_ANNOTATION',
              payload: {
                id: `ann_${Date.now()}`,
                position: [pos.lat, pos.lng],
                text,
                color: colorPick.value,
                fontSize: Math.max(8, Math.min(72, parseInt(sizeInput.value) || 13)),
              },
            });
          }
          map.closePopup(popup);
        };
        addBtn.onclick = commit;
        cancelBtn.onclick = () => map.closePopup(popup);
        input.onkeydown = ev => { if (ev.key === 'Enter') commit(); if (ev.key === 'Escape') map.closePopup(popup); };
        return;
      }

      if (!state.pointPickingEnabled) return;
      dispatch({
        type: 'ADD_TIME_SERIES_POINT',
        payload: { position: [e.latlng.lat, e.latlng.lng], name: `Point ${Date.now().toString().slice(-4)}` },
      });
      if (!state.showChart) dispatch({ type: 'TOGGLE_CHART' });
    },
  });

  return null;
}

/** Renders all map annotations as draggable labels; click to open delete popup. */
function AnnotationLayer() {
  const { state, dispatch } = useAppContext();
  const map = useMap();

  useEffect(() => {
    const markers: L.Marker[] = [];
    state.annotations.forEach(ann => {
      const icon = L.divIcon({
        className: '',
        html: `<div style="
          color:${ann.color};font-size:${ann.fontSize}px;font-weight:600;white-space:nowrap;
          text-shadow:0 0 3px rgba(0,0,0,0.9),0 0 3px rgba(0,0,0,0.9);
          cursor:move;user-select:none;padding:2px 5px;
          background:rgba(0,0,0,0.35);border-radius:3px;
          border:1px solid rgba(255,255,255,0.15);
        ">${ann.text}</div>`,
        iconAnchor: [0, 0],
      });
      const m = L.marker(ann.position, { icon, draggable: true })
        .addTo(map);
      m.on('click', (ev) => {
        L.DomEvent.stop(ev);

        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;flex-direction:column;gap:7px;min-width:190px;font-size:12px;';

        // ── Label input ──
        const textRow = document.createElement('div');
        textRow.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
        const textLbl = document.createElement('label');
        textLbl.textContent = 'Label';
        textLbl.style.cssText = 'font-size:10px;color:#aaa;';
        const textInput = document.createElement('input');
        textInput.type = 'text';
        textInput.value = ann.text;
        textInput.style.cssText = 'padding:3px 6px;border:1px solid #666;border-radius:4px;font-size:12px;width:100%;box-sizing:border-box;background:#2a2d35;color:#e8e6e3;';
        textRow.appendChild(textLbl);
        textRow.appendChild(textInput);

        // ── Color + font-size row ──
        const row2 = document.createElement('div');
        row2.style.cssText = 'display:flex;gap:8px;align-items:flex-end;';

        const colorCol = document.createElement('div');
        colorCol.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
        const colorLbl = document.createElement('label');
        colorLbl.textContent = 'Color';
        colorLbl.style.cssText = 'font-size:10px;color:#aaa;';
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.value = ann.color;
        colorInput.style.cssText = 'width:36px;height:26px;padding:0;border:none;cursor:pointer;background:none;';
        colorCol.appendChild(colorLbl);
        colorCol.appendChild(colorInput);

        const sizeCol = document.createElement('div');
        sizeCol.style.cssText = 'display:flex;flex-direction:column;gap:2px;flex:1;';
        const sizeLbl = document.createElement('label');
        sizeLbl.textContent = 'Font size (px)';
        sizeLbl.style.cssText = 'font-size:10px;color:#aaa;';
        const sizeInput = document.createElement('input');
        sizeInput.type = 'number';
        sizeInput.value = String(ann.fontSize);
        sizeInput.min = '8';
        sizeInput.max = '72';
        sizeInput.style.cssText = 'padding:3px 6px;border:1px solid #666;border-radius:4px;font-size:12px;width:100%;box-sizing:border-box;background:#2a2d35;color:#e8e6e3;';
        sizeCol.appendChild(sizeLbl);
        sizeCol.appendChild(sizeInput);

        row2.appendChild(colorCol);
        row2.appendChild(sizeCol);

        // ── Action buttons ──
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:6px;';

        const applyBtn = document.createElement('button');
        applyBtn.innerHTML = '<i class="fa-solid fa-check" style="margin-right:4px"></i>Apply';
        applyBtn.style.cssText = 'flex:1;padding:4px 0;cursor:pointer;font-size:12px;border:1px solid #5bc0be;background:rgba(91,192,190,0.15);color:#5bc0be;border-radius:4px;font-weight:600;';
        applyBtn.onclick = () => {
          dispatch({
            type: 'UPDATE_ANNOTATION',
            payload: {
              id: ann.id,
              updates: {
                text: textInput.value.trim() || ann.text,
                color: colorInput.value,
                fontSize: Math.max(8, Math.min(72, parseInt(sizeInput.value) || ann.fontSize)),
              },
            },
          });
          map.closePopup();
        };

        const delBtn = document.createElement('button');
        delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
        delBtn.title = 'Delete annotation';
        delBtn.style.cssText = 'padding:4px 10px;cursor:pointer;font-size:12px;border:1px solid #e07b7b;background:rgba(224,123,123,0.15);color:#e07b7b;border-radius:4px;';
        delBtn.onclick = () => {
          dispatch({ type: 'REMOVE_ANNOTATION', payload: ann.id });
          map.closePopup();
        };

        btnRow.appendChild(applyBtn);
        btnRow.appendChild(delBtn);

        wrap.appendChild(textRow);
        wrap.appendChild(row2);
        wrap.appendChild(btnRow);

        L.popup({ closeButton: true, offset: [0, -4], minWidth: 200 })
          .setLatLng(m.getLatLng())
          .setContent(wrap)
          .openOn(map);

        setTimeout(() => { textInput.focus(); textInput.select(); }, 50);
        textInput.onkeydown = e => { if (e.key === 'Enter') applyBtn.click(); if (e.key === 'Escape') map.closePopup(); };
      });
      markers.push(m);
    });
    return () => { markers.forEach(m => m.remove()); };
  }, [state.annotations, map, dispatch]);

  return null;
}

// Syncs map view ↔ state.viewBounds.
// Sidebar Apply / Dataset buttons dispatch APPLY_VIEW_BOUNDS, which bumps
// viewBoundsApplySeq; this effect flies to the bounds. Plain moveend only
// dispatches SET_VIEW_BOUNDS (no seq bump), so the map doesn't fly back to
// itself — that round-trip was drifting the center south on zoom-out because
// bounds.getCenter() is the arithmetic mean of N/S, not the Mercator center.
function MapViewController() {
  const { state, dispatch } = useAppContext();
  const map = useMap();

  useEffect(() => {
    if (!state.viewBounds || state.viewBoundsApplySeq === 0) return;
    const [s, w, n, e] = state.viewBounds;
    const bounds = L.latLngBounds([[s, w], [n, e]]);
    const zoom = map.getBoundsZoom(bounds, true);
    map.setView(bounds.getCenter(), zoom, { animate: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.viewBoundsApplySeq]);

  useMapEvents({
    moveend: () => {
      const b = map.getBounds();
      dispatch({
        type: 'SET_VIEW_BOUNDS',
        payload: [
          parseFloat(b.getSouth().toFixed(6)),
          parseFloat(b.getWest().toFixed(6)),
          parseFloat(b.getNorth().toFixed(6)),
          parseFloat(b.getEast().toFixed(6)),
        ],
      });
    },
  });

  return null;
}

function MousePosition() {
  const map = useMap();

  useEffect(() => {
    const mousePositionControl = new MousePositionControl();
    mousePositionControl.addTo(map);

    return () => {
      mousePositionControl.remove();
    };
  }, [map]);

  return null;
}

// Leaflet caches its container size; CSS-driven resizes (sidebar collapse,
// chart panel open/close) leave it drawing for the old dimensions until
// invalidateSize() is called. Without this, tiles stop short of the new
// right edge and the graticule SVG (sized from map.getSize()) doesn't extend.
function MapResizeWatcher() {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer();
    const ro = new ResizeObserver(() => map.invalidateSize({ animate: false }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [map]);
  return null;
}

function ScaleBar() {
  const map = useMap();

  useEffect(() => {
    const scale = L.control.scale({ position: 'bottomleft', imperial: true, metric: true, maxWidth: 150 });
    scale.addTo(map);
    return () => { scale.remove(); };
  }, [map]);

  return null;
}

function RasterTileLayer({ onTileStart, onTileEnd }: { onTileStart?: () => void; onTileEnd?: () => void }) {
  const { state } = useAppContext();
  const [tileUrl, setTileUrl] = useState<string | null>(null);
  // Two-slot model: active = currently shown layer (full opacity);
  // pending = next layer loading silently at opacity 0. Swap happens only when
  // pending fires 'load' (all viewport tiles decoded) → no mixed-tile artifacts.
  const [active, setActive] = useState<{ url: string; id: number } | null>(null);
  const [pending, setPending] = useState<{ url: string; id: number } | null>(null);
  const nextIdRef = useRef(0);

  // Loading state is driven by tile events (tileloadstart/load) on both layers,
  // so zoom/pan on the active layer also triggers the indicator.

  useEffect(() => {
    if (!state.currentDataset || !state.datasetInfo[state.currentDataset] || !state.dataMode) {
      return;
    }
    // dataMode starts as 'md' default; wait until datasets are loaded (which confirms mode is set)
    if (state.dataMode !== 'md' && state.dataMode !== 'cog') {
      return;
    }

    const controller = new AbortController();
    const signal = controller.signal;

    const updateTileLayer = async () => {
      const currentDatasetInfo = state.datasetInfo[state.currentDataset];

      // Use ONLY state — DO NOT read localStorage here
      const colormap = state.colormap;
      const vmin = state.vmin;
      const vmax = state.vmax;

      // Ensure time index is within bounds
      const maxIdx = currentDatasetInfo.x_values.length - 1;
      const timeIdx = Math.max(0, Math.min(state.currentTimeIndex, maxIdx));

      // Build parameters
      const params: Record<string, string> = {
        variable: state.currentDataset,
        time_idx: timeIdx.toString(),
        rescale: `${vmin},${vmax}`,
        colormap_name: colormap,
      };

      // Determine effective algorithm:
      // - complex datasets (algorithm='phase'|'amplitude'): complexMode selects phase vs amplitude;
      //   wrap overrides phase→rewrap but not amplitude (wrapping amplitude makes no sense).
      // - all others: wrap overrides to rewrap, else use native algorithm.
      const isComplex = currentDatasetInfo.algorithm === 'phase' || currentDatasetInfo.algorithm === 'amplitude';
      if (isComplex) {
        if (state.complexMode === 'amplitude') {
          params.algorithm = 'amplitude';
        } else if (state.wrapEnabled) {
          params.algorithm = 'rewrap';
        } else {
          params.algorithm = 'phase';
        }
      } else if (state.wrapEnabled) {
        params.algorithm = 'rewrap';
      } else if (currentDatasetInfo.algorithm) {
        params.algorithm = currentDatasetInfo.algorithm;
      }

      // Build algorithm_params, merging ref shift and wrap parameters.
      // Rewrap accepts shift (subtracted before wrapping), scale_factor, and wrap_range,
      // so ref correction keeps working when algorithm is overridden to 'rewrap'.
      {
        const algorithmParams: Record<string, number> = {};

        if (state.refEnabled && state.refValues[state.currentDataset] && currentDatasetInfo.algorithm === 'shift') {
          const refArr = state.refValues[state.currentDataset];
          const shift = refArr[timeIdx] ?? refArr[0];
          if (shift !== undefined) algorithmParams.shift = shift;
        }

        if (state.wrapEnabled) {
          if (state.wrapWavelength !== null && state.wrapWavelength > 0) {
            algorithmParams.scale_factor = (4 * Math.PI) / state.wrapWavelength;
            algorithmParams.wrap_range = 2 * Math.PI;
          } else {
            algorithmParams.wrap_range = state.wrapPeriod;
          }
        }

        if (Object.keys(algorithmParams).length > 0) {
          params.algorithm_params = JSON.stringify(algorithmParams);
        }
      }

      // Add URL parameter for COG mode
      if (state.dataMode === 'cog') {
        const url = currentDatasetInfo.file_list[timeIdx];
        const maskUrl = currentDatasetInfo.mask_file_list[timeIdx];
        const maskMinValue = currentDatasetInfo.mask_min_value;

        params.url = url;
        if (maskUrl) params.mask = maskUrl;
        if (maskMinValue !== undefined) params.mask_min_value = maskMinValue.toString();
        if (state.customMaskPath) params.custom_mask = state.customMaskPath;
        params.time_idx = timeIdx.toString();
      }

      // Layer masks (both modes)
      if (state.layerMasks.length > 0) {
        params.layer_masks = JSON.stringify(
          state.layerMasks.map(m => ({ dataset: m.dataset, threshold: m.threshold, mode: m.mode }))
        );
      }

      // MD mode: custom mask path
      if (state.dataMode === 'md') {
        if (state.customMaskPath) params.custom_mask_path = state.customMaskPath;
      }

      // Thread the catalog-selected dataset (if the user came from the
      // picker) onto the tile URL so the backend routes this tile to the
      // right BowserState.
      const datasetId = new URLSearchParams(window.location.search).get('dataset');
      if (datasetId) params.dataset = datasetId;

      const urlParams = new URLSearchParams(params).toString();
      const endpoint = state.dataMode === 'md'
        ? `/md/WebMercatorQuad/tilejson.json?${urlParams}`
        : `/cog/WebMercatorQuad/tilejson.json?${urlParams}`;

      try {
        const response = await fetch(endpoint, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const tileInfo = await response.json();
        // Only set if not aborted
        if (!signal.aborted) setTileUrl(tileInfo.tiles[0]);
      } catch (err) {
        if ((err as any).name !== 'AbortError') {
          console.error('Error fetching tile info:', err);
        }
      }
    };

    // Debounce: collapse rapid state changes (histogram → rescale → ref point)
    // into a single request to avoid transient 500s from concurrent opens.
    const debounceTimer = setTimeout(() => updateTileLayer(), 80);
    return () => { clearTimeout(debounceTimer); controller.abort(); };
  }, [
    state.currentDataset,
    state.currentTimeIndex,
    state.datasetInfo,
    state.dataMode,
    state.refValues,
    state.refMarkerPosition,
    state.refEnabled,
    state.colormap,
    state.vmin,
    state.vmax,
    state.layerMasks,
    state.customMaskPath,
    state.wrapEnabled,
    state.wrapWavelength,
    state.wrapPeriod,
    state.complexMode,
  ]);

  // Two-slot swap: when tileUrl changes, keep active visible and load pending at
  // opacity=0. On pending 'load' (all viewport tiles decoded), atomically promote
  // pending → active. No mixed-tile seam artifacts and no blank flash.
  useEffect(() => {
    if (!tileUrl) { setActive(null); setPending(null); return; }
    const id = ++nextIdRef.current;
    setActive(currentActive => {
      if (!currentActive) {
        setPending(null);
        return { url: tileUrl, id };
      }
      setPending({ url: tileUrl, id });
      return currentActive;
    });
  }, [tileUrl]);

  return (
    <>
      {active && (
        <TileLayer
          key={active.id} url={active.url} opacity={state.opacity} maxZoom={22} zIndex={10}
          eventHandlers={{
            tileloadstart: () => onTileStart?.(),
            load: () => onTileEnd?.(),
          }}
        />
      )}
      {pending && (
        <TileLayer
          key={pending.id} url={pending.url} opacity={state.opacity} maxZoom={22} zIndex={11}
          eventHandlers={{
            tileloadstart: () => onTileStart?.(),
            load: () => {
              onTileEnd?.();
              setPending(cur => {
                if (!cur || cur.id !== pending.id) return cur;
                setActive(cur);
                return null;
              });
            },
          }}
        />
      )}
    </>
  );
}

/** Draw radius circles on the map for buffer-enabled points and reference marker. */
function RadiusCircles() {
  const { state } = useAppContext();
  const map = useMap();

  useEffect(() => {
    const circles: L.Circle[] = [];

    // Time-series point buffer circles
    if (state.bufferEnabled && state.bufferRadius > 0) {
      state.timeSeriesPoints.filter(p => p.visible).forEach(point => {
        circles.push(L.circle([point.position[0], point.position[1]], {
          radius: state.bufferRadius,
          color: point.color,
          fillColor: point.color,
          fillOpacity: 0.08,
          weight: 1.5,
          dashArray: '4 3',
        }).addTo(map));
      });
    }

    // Reference marker buffer circle
    if (state.refEnabled && state.refBufferEnabled && state.refBufferRadius > 0) {
      const [lat, lng] = state.refMarkerPosition;
      circles.push(L.circle([lat, lng], {
        radius: state.refBufferRadius,
        color: '#e05d6a',
        fillColor: '#e05d6a',
        fillOpacity: 0.08,
        weight: 1.5,
        dashArray: '4 3',
      }).addTo(map));
    }

    return () => { circles.forEach(c => c.remove()); };
  }, [
    map,
    state.bufferEnabled,
    state.bufferRadius,
    state.refEnabled,
    state.refBufferEnabled,
    state.refBufferRadius,
    state.refMarkerPosition,
    JSON.stringify(state.timeSeriesPoints.map(p => ({ id: p.id, pos: p.position, vis: p.visible }))),
  ]);

  return null;
}

function MarkerEventHandlers() {
  const { state, dispatch } = useAppContext();
  const { fetchPointTimeSeries, fetchBufferTimeSeries } = useApi();
  const map = useMap();

  const handleMarkerClick = (position: [number, number], pointName?: string) => {
    const [lat, lng] = position;
    const content = pointName
      ? `${pointName} (lon, lat):\n(${lng.toFixed(6)}, ${lat.toFixed(6)})`
      : `Reference (lon, lat):\n(${lng.toFixed(6)}, ${lat.toFixed(6)})`;
    L.popup()
      .setLatLng([lat, lng])
      .setContent(content)
      .openOn(map);
  };

  const handleTsMarkerDragEnd = (pointId: string) => (e: L.DragEndEvent) => {
    const marker = e.target;
    const position = marker.getLatLng();
    dispatch({
      type: 'UPDATE_TIME_SERIES_POINT',
      payload: {
        id: pointId,
        updates: { position: [position.lat, position.lng] }
      }
    });
  };

  const handleRefMarkerDragEnd = async (e: L.DragEndEvent) => {
    const marker = e.target;
    const position = marker.getLatLng();
    const lat = position.lat;
    const lng = position.lng;
    // 1) update position in state
    dispatch({ type: 'SET_REF_MARKER_POSITION', payload: [lat, lng] });

    // 2) if current dataset uses the "shift" algo, recompute ref values
    const ds = state.currentDataset;
    const info = ds ? state.datasetInfo[ds] : null;
    if (ds && info?.algorithm === 'shift') {
      try {
        let values: number[] | undefined;
        if (state.refBufferEnabled && state.refBufferRadius > 0) {
          const result = await fetchBufferTimeSeries(lng, lat, ds, state.refBufferRadius, 0);
          if (result?.median) {
            const xValues = state.datasetInfo[ds]?.x_values?.map(String) ?? result.labels?.map(String) ?? [];
            const byX = Object.fromEntries(result.median.map((pt: { x: string; y: number }) => [String(pt.x), pt.y]));
            values = xValues.map((x: string) => byX[x] ?? NaN);
          }
        }
        if (!values) {
          values = await fetchPointTimeSeries(lng, lat, ds);
        }
        if (values) {
          dispatch({ type: 'SET_REF_VALUES', payload: { dataset: ds, values } });
        }
      } catch (err) {
        console.error('Error updating reference values after drag:', err);
      }
    }
  };

  const handleTsMarkerDoubleClick = (pointId: string) => () => {
    // Double-click to remove point
    dispatch({ type: 'REMOVE_TIME_SERIES_POINT', payload: pointId });
  };

  // Create custom colored icons for each point
  const createColoredIcon = (color: string, isSelected: boolean = false) => {
    const iconSize = isSelected ? 25 : 20;
    return L.divIcon({
      html: `<div style="
        width: ${iconSize}px;
        height: ${iconSize}px;
        background-color: ${color};
        border: ${isSelected ? '3px solid white' : '2px solid white'};
        border-radius: 50%;
        box-shadow: 0 2px 4px rgba(0,0,0,0.3);
      "></div>`,
      iconSize: [iconSize, iconSize],
      className: 'custom-colored-marker'
    });
  };

  return (
    <>
      {/* Time Series Points */}
      {state.timeSeriesPoints.filter(p => p.visible).map((point) => (
        <Marker
          key={point.id}
          position={point.position}
          icon={createColoredIcon(point.color, state.selectedPointId === point.id)}
          draggable
          title={`${point.name} - Double-click to remove`}
          eventHandlers={{
            click: () => {
              handleMarkerClick(point.position, point.name);
              dispatch({ type: 'SET_SELECTED_POINT', payload: point.id });
            },
            dragend: handleTsMarkerDragEnd(point.id),
            dblclick: handleTsMarkerDoubleClick(point.id),
          }}
        />
      ))}

      {/* Reference Marker — only rendered when refMarkerVisible */}
      {state.refMarkerVisible && (
        <Marker
          position={state.refMarkerPosition}
          icon={fontAwesomeIcon}
          draggable
          title="Reference Location"
          eventHandlers={{
            click: () => handleMarkerClick(state.refMarkerPosition),
            dragend: handleRefMarkerDragEnd,
          }}
        />
      )}
    </>
  );
}

function MapTopRightToolbar({ onToggleToolbars }: { onToggleToolbars: () => void }) {
  const { state, dispatch } = useAppContext();
  const [basemapOpen, setBasemapOpen] = useState(false);
  const info = state.currentDataset ? state.datasetInfo[state.currentDataset] : null;

  const fitDataset = () => {
    if (!info) return;
    const b = info.latlon_bounds; // [w, s, e, n]
    dispatch({ type: 'APPLY_VIEW_BOUNDS', payload: [b[1], b[0], b[3], b[2]] });
  };

  // Close basemap popover on outside click
  useEffect(() => {
    if (!basemapOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('.basemap-popover') && !t.closest('.basemap-trigger')) setBasemapOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [basemapOpen]);

  return (
    <div className="map-toolbar-right">
      <button className="map-tool-btn" onClick={fitDataset} title="Fit view to dataset" disabled={!info}>
        <i className="fa-solid fa-arrows-to-circle"></i>
      </button>
      <div style={{ position: 'relative' }}>
        <button className="map-tool-btn basemap-trigger" onClick={() => setBasemapOpen(v => !v)} title="Basemap">
          <i className="fa-solid fa-map"></i>
        </button>
        {basemapOpen && (
          <div className="basemap-popover" style={{ minWidth: 220 }}>
            {/* ── Layer 1 (bottom) ── */}
            <div style={{ fontSize: '0.7em', color: 'var(--sb-muted)', marginBottom: 4 }}>
              Layer 1 {state.basemapSwapped ? '(top)' : '(bottom)'}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
              {Object.entries(baseMaps).map(([key, bm]) => (
                <button
                  key={key}
                  className={`basemap-option${state.selectedBasemap === key ? ' active' : ''}`}
                  onClick={() => dispatch({ type: 'SET_BASEMAP', payload: key })}
                  style={{ padding: '2px 7px', fontSize: '0.78em' }}
                >{bm.label ?? key}</button>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{ fontSize: '0.7em', color: 'var(--sb-muted)', flexShrink: 0 }}>Opacity</span>
              <input type="range" min={0} max={1} step={0.05}
                value={state.basemapOpacity}
                onChange={e => dispatch({ type: 'SET_BASEMAP_OPACITY', payload: parseFloat(e.target.value) })}
                style={{ flex: 1 }} />
              <span style={{ fontSize: '0.7em', color: 'var(--sb-muted)', width: 28, textAlign: 'right' }}>
                {Math.round(state.basemapOpacity * 100)}%
              </span>
            </div>

            {/* ── Swap button ── */}
            <button
              onClick={() => dispatch({ type: 'TOGGLE_BASEMAP_SWAP' })}
              title="Swap layer order"
              style={{
                width: '100%', marginBottom: 8, padding: '3px 0',
                background: 'var(--sb-surface2)', border: '1px solid var(--sb-border)',
                borderRadius: 4, color: 'var(--sb-text)', cursor: 'pointer', fontSize: '0.75em',
              }}
            >⇅ Swap order</button>

            {/* ── Layer 2 (top) ── */}
            <div style={{ fontSize: '0.7em', color: 'var(--sb-muted)', marginBottom: 4 }}>
              Layer 2 {state.basemapSwapped ? '(bottom)' : '(top)'}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
              <button
                className={`basemap-option${state.secondaryBasemap === null ? ' active' : ''}`}
                onClick={() => dispatch({ type: 'SET_SECONDARY_BASEMAP', payload: null })}
                style={{ padding: '2px 7px', fontSize: '0.78em' }}
              >None</button>
              {Object.entries(baseMaps).map(([key, bm]) => (
                <button
                  key={key}
                  className={`basemap-option${state.secondaryBasemap === key ? ' active' : ''}`}
                  onClick={() => dispatch({ type: 'SET_SECONDARY_BASEMAP', payload: key })}
                  style={{ padding: '2px 7px', fontSize: '0.78em' }}
                >{bm.label ?? key}</button>
              ))}
            </div>
            {state.secondaryBasemap && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span style={{ fontSize: '0.7em', color: 'var(--sb-muted)', flexShrink: 0 }}>Opacity</span>
                  <input type="range" min={0} max={1} step={0.05}
                    value={state.secondaryBasemapOpacity}
                    onChange={e => dispatch({ type: 'SET_SECONDARY_BASEMAP_OPACITY', payload: parseFloat(e.target.value) })}
                    style={{ flex: 1 }} />
                  <span style={{ fontSize: '0.7em', color: 'var(--sb-muted)', width: 28, textAlign: 'right' }}>
                    {Math.round(state.secondaryBasemapOpacity * 100)}%
                  </span>
                </div>
              </>
            )}
          </div>
        )}
      </div>
      <button
        className={`map-tool-btn${state.showColorbar ? ' active' : ''}`}
        onClick={() => dispatch({ type: 'TOGGLE_COLORBAR' })}
        title="Toggle colorbar on map"
      ><i className="fa-solid fa-palette"></i></button>
      <button
        className={`map-tool-btn${state.showLosIndicator ? ' active' : ''}`}
        onClick={() => dispatch({ type: 'TOGGLE_LOS_INDICATOR' })}
        title="Toggle LOS geometry indicator"
      ><i className="fa-solid fa-satellite"></i></button>
      <button
        className={`map-tool-btn${state.refEnabled ? ' active' : ''}`}
        onClick={() => dispatch({ type: 'TOGGLE_REF_ENABLED' })}
        title="Toggle spatial re-referencing"
      ><i className="fa-solid fa-crosshairs"></i></button>
      <button
        className={`map-tool-btn${state.graticuleMode !== 'off' ? ' active' : ''}`}
        onClick={() => dispatch({ type: 'CYCLE_GRATICULE' })}
        title={`Lat/lon grid: ${state.graticuleMode} (click to cycle)`}
      ><i className="fa-solid fa-border-all"></i></button>
      <button
        className={`map-tool-btn${state.annotationMode ? ' active' : ''}`}
        onClick={() => dispatch({ type: 'TOGGLE_ANNOTATION_MODE' })}
        title={state.annotationMode ? 'Annotation mode ON — click map to place label (double-click label to delete)' : 'Toggle annotation mode'}
      ><i className="fa-solid fa-pen-to-square"></i></button>
      <button
        className={`map-tool-btn${!state.pointPickingEnabled ? ' active' : ''}`}
        onClick={() => dispatch({ type: 'TOGGLE_POINT_PICKING' })}
        title={state.pointPickingEnabled ? 'Point picking ON — click to disable' : 'Point picking OFF — click to enable'}
        style={!state.pointPickingEnabled ? { opacity: 0.5 } : undefined}
      ><i className="fa-solid fa-location-dot"></i></button>
      <button
        className="map-tool-btn"
        onClick={onToggleToolbars}
        title="Hide toolbar"
        style={{ marginTop: 4, opacity: 0.6 }}
      ><i className="fa-solid fa-chevron-right"></i></button>
    </div>
  );
}

export default function MapContainer({ toolbarsVisible, onToggleToolbars }: { toolbarsVisible: boolean; onToggleToolbars: () => void }) {
  const { state } = useAppContext();

  // Calculate initial center from first dataset bounds
  const getInitialCenter = (): [number, number] => {
    if (state.currentDataset && state.datasetInfo[state.currentDataset]) {
      const bounds = state.datasetInfo[state.currentDataset].latlon_bounds;
      const centerLat = (bounds[1] + bounds[3]) / 2;
      const centerLng = (bounds[0] + bounds[2]) / 2;
      return [centerLat, centerLng];
    }

    // If no current dataset, try to get bounds from any available dataset
    const datasets = Object.values(state.datasetInfo);
    if (datasets.length > 0) {
      const bounds = datasets[0].latlon_bounds;
      const centerLat = (bounds[1] + bounds[3]) / 2;
      const centerLng = (bounds[0] + bounds[2]) / 2;
      return [centerLat, centerLng];
    }

    return [0, 0];
  };

  const primaryBm   = baseMaps[state.selectedBasemap] || baseMaps.esriSatellite;
  const secondaryBm = state.secondaryBasemap ? baseMaps[state.secondaryBasemap] : null;
  // Swapped: secondary renders first (bottom), primary on top; default: primary bottom, secondary top
  const bottomBm  = state.basemapSwapped ? secondaryBm  : primaryBm;
  const topBm     = state.basemapSwapped ? primaryBm    : secondaryBm;
  const bottomOp  = state.basemapSwapped ? state.secondaryBasemapOpacity : state.basemapOpacity;
  const topOp     = state.basemapSwapped ? state.basemapOpacity : state.secondaryBasemapOpacity;

  const center = getInitialCenter();
  const hasDatasets = Object.keys(state.datasetInfo).length > 0;
  const [measureActive, setMeasureActive] = useState(false);
  const [tileLoading, setTileLoading] = useState(false);
  const tileCountRef = useRef(0);
  const onTileStart = () => { tileCountRef.current++; setTileLoading(true); };
  const onTileEnd   = () => { if (--tileCountRef.current <= 0) { tileCountRef.current = 0; setTileLoading(false); } };
  const { active: profileActive, setActive: setProfileActive } = useProfileContext();

  return (
    <div className="map-container">
      {toolbarsVisible ? (
        <>
          <div className="map-toolbar">
            <button
              className={`map-tool-btn${measureActive ? ' active' : ''}`}
              title="Measure distance (click points, double-click to finish)"
              onClick={() => { setMeasureActive(v => !v); setProfileActive(false); }}
            >
              <i className="fa-solid fa-ruler"></i>
            </button>
            <button
              className={`map-tool-btn${profileActive ? ' active' : ''}`}
              title="Draw profile line (click start, click end, double-click to extract)"
              onClick={() => { setProfileActive(!profileActive); setMeasureActive(false); }}
            >
              <i className="fa-solid fa-chart-area"></i>
            </button>
          </div>
          <MapTopRightToolbar onToggleToolbars={onToggleToolbars} />
        </>
      ) : (
        <button
          className="map-tool-btn"
          title="Show toolbar"
          onClick={onToggleToolbars}
          style={{ position: 'absolute', top: 10, right: 10, zIndex: 3000 }}
        ><i className="fa-solid fa-bars"></i></button>
      )}
      {tileLoading && (
        <div style={{
          position: 'absolute', bottom: 28, right: 10, zIndex: 3000,
          background: 'rgba(0,0,0,0.55)', color: '#fff', borderRadius: 20,
          padding: '3px 10px', fontSize: '0.72em', display: 'flex',
          alignItems: 'center', gap: 6, pointerEvents: 'none',
        }}>
          <i className="fa-solid fa-spinner fa-spin" style={{ fontSize: '0.9em' }} />
          Loading…
        </div>
      )}
    <LeafletMapContainer
      key={hasDatasets ? 'with-data' : 'no-data'} // Force re-render when data loads
      center={center}
      zoom={9}
      style={{ height: '100%', width: '100%' }}
      doubleClickZoom={false}
      zoomControl={false}
    >
      <TileLayer
        key={bottomBm?.url}
        url={bottomBm?.url ?? ''}
        attribution={bottomBm?.attribution ?? ''}
        opacity={bottomOp}
        maxZoom={22}
        zIndex={1}
        eventHandlers={{ tileloadstart: onTileStart, load: onTileEnd }}
      />
      {topBm && (
        <TileLayer
          key={topBm.url}
          url={topBm.url}
          attribution={topBm.attribution}
          opacity={topOp}
          maxZoom={22}
          zIndex={2}
          eventHandlers={{ tileloadstart: onTileStart, load: onTileEnd }}
        />
      )}
      <RasterTileLayer onTileStart={onTileStart} onTileEnd={onTileEnd} />
      <RadiusCircles />
      <MarkerEventHandlers />
      <AnnotationLayer />
      <MapEvents toolActive={measureActive || profileActive} />
      <MousePosition />
      <ScaleBar />
      <MeasureTool active={measureActive} onDeactivate={() => setMeasureActive(false)} />
      <ProfileToolMap />
      <MapViewController />
      <MapResizeWatcher />
      <Graticule mode={state.graticuleMode} />
    </LeafletMapContainer>
    </div>
  );
}
