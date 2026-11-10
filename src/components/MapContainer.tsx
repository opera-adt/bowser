import { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { MapContainer as LeafletMapContainer, TileLayer, WMSTileLayer, Marker, useMapEvents, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useApi } from '../hooks/useApi';
import { useRasterTileUrl } from '../map/useRasterTileUrl';
import { MapLeftToolbar, MapTopRightToolbar, type MapFeature } from './MapToolbars';

/** Identify reads MapLibre's rendered features, so the Leaflet fallback has no identify tool. */
const LEAFLET_UNSUPPORTED: ReadonlySet<MapFeature> = new Set(['identify']);
import {
  mapClickActions, markerPopupText, pixelInspectRequest, pixelInspectText,
  pointClickActions, pointDoubleClickActions, pointDragEndActions, refDragEnd, viewBoundsAction,
} from '../map/interactions';
import { leafletZoom, maplibreZoom, registerNavigator, whenMoved } from '../map/navigator';
import { useAppContext } from '../context/AppContext';
import { baseMaps } from '../basemap';
import { basemapLeafletZoom, MAP_MAX_ZOOM } from '../map/basemapStyle';
import { MousePositionControl } from '../mouse';
import MeasureTool from './MeasureTool';
import { ProfileToolMap, useProfileContext } from './ProfileTool';
import Graticule from './Graticule';
import SplitDivider from './SplitDivider';
import { geotiffTileUrl, overlayVizKey } from '../map/overlays';
import { annotationCreateForm, annotationEditForm, annotationLabelHtml } from '../map/annotationForms';

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
      const decision = mapClickActions(state, [e.latlng.lat, e.latlng.lng], { toolActive, profileActive });
      if (decision.kind === 'ignore') return;

      // Annotation mode: open an inline popup to enter text
      if (decision.kind === 'annotate') {
        const pos = e.latlng;
        let popup: L.Popup | null = null;
        const form = annotationCreateForm([pos.lat, pos.lng], { dispatch, close: () => { if (popup) map.closePopup(popup); } });
        popup = L.popup({ closeButton: false, closeOnClick: false })
          .setLatLng(pos).setContent(form.el).openOn(map);
        setTimeout(() => form.focus(), 50);
        return;
      }
      decision.actions.forEach(dispatch);
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
      const icon = L.divIcon({ className: '', html: annotationLabelHtml(ann), iconAnchor: [0, 0] });
      const m = L.marker(ann.position, { icon, draggable: true })
        .addTo(map);
      m.on('click', (ev) => {
        L.DomEvent.stop(ev);

        const form = annotationEditForm(ann, { dispatch, close: () => map.closePopup() });
        L.popup({ closeButton: true, offset: [0, -4], minWidth: 200 })
          .setLatLng(m.getLatLng())
          .setContent(form.el)
          .openOn(map);
        setTimeout(() => form.focus(), 50);
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
      dispatch(viewBoundsAction(b.getSouth(), b.getWest(), b.getNorth(), b.getEast()));
    },
  });

  // The Assistant's map tools (src/map/navigator.ts); zoom levels converted to MapLibre's.
  useEffect(() => {
    const moved = (move: () => void) => whenMoved((e, f) => map.on(e, f), (e, f) => map.off(e, f), move);
    return registerNavigator({
      kind: 'leaflet',
      getView: () => {
        const b = map.getBounds();
        const c = map.getCenter();
        const size = map.getSize();
        return {
          center: [c.lng, c.lat], zoom: maplibreZoom(map.getZoom()), bearing: 0, pitch: 0,
          bounds: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], map: 'leaflet',
          width: size.x, height: size.y,
        };
      },
      flyTo: (lon, lat, zoom) => moved(() => map.flyTo([lat, lon], zoom === undefined ? map.getZoom() : leafletZoom(zoom))),
      fitBounds: (w, s, e, n, padding, maxZoom) => moved(() => map.fitBounds([[s, w], [n, e]], {
        padding: [padding, padding], ...(maxZoom === undefined ? {} : { maxZoom: leafletZoom(maxZoom) }),
      })),
      panBy: (dx, dy) => moved(() => map.panBy([dx, dy])),
      zoomTo: z => moved(() => map.setZoom(leafletZoom(z))),
    });
  }, [map]);

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

function RasterTileLayer({
  onTileStart, onTileEnd, pane, overrideDataset, overrideColormap, overrideVmin, overrideVmax, overrideOpacity, overrideTimeIndex,
}: {
  onTileStart?: () => void;
  onTileEnd?: () => void;
  pane?: string;
  overrideDataset?: string;
  overrideColormap?: string;
  overrideVmin?: number;
  overrideVmax?: number;
  overrideOpacity?: number;
  overrideTimeIndex?: number;
}) {
  const { state } = useAppContext();
  const tileUrl = useRasterTileUrl({
    dataset: overrideDataset, colormap: overrideColormap, vmin: overrideVmin,
    vmax: overrideVmax, timeIndex: overrideTimeIndex,
  });
  const [active, setActive] = useState<{ url: string; id: number } | null>(null);
  const [pending, setPending] = useState<{ url: string; id: number } | null>(null);
  const nextIdRef = useRef(0);

  const effectiveOpacity = overrideOpacity ?? state.opacity;


  useEffect(() => {
    if (!tileUrl) { setActive(null); setPending(null); return; }
    const id = ++nextIdRef.current;
    setActive(currentActive => {
      if (!currentActive) { setPending(null); return { url: tileUrl, id }; }
      setPending({ url: tileUrl, id });
      return currentActive;
    });
  }, [tileUrl]);

  return (
    <>
      {active && (
        <TileLayer
          key={`${active.id}:${pane ?? ''}`} url={active.url} opacity={effectiveOpacity} maxZoom={22} zIndex={10}
          {...(pane ? { pane } : {})}
          eventHandlers={{
            tileloadstart: () => onTileStart?.(),
            tileload: () => onTileEnd?.(),
            tileerror: () => onTileEnd?.(),
          }}
        />
      )}
      {pending && (
        <TileLayer
          key={`${pending.id}:${pane ?? ''}`} url={pending.url} opacity={effectiveOpacity} maxZoom={22} zIndex={11}
          {...(pane ? { pane } : {})}
          eventHandlers={{
            tileloadstart: () => onTileStart?.(),
            tileload: () => onTileEnd?.(),
            tileerror: () => onTileEnd?.(),
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
    L.popup()
      .setLatLng(position)
      .setContent(markerPopupText(position, pointName))
      .openOn(map);
  };

  const handleTsMarkerDragEnd = (pointId: string) => (e: L.DragEndEvent) => {
    const position = e.target.getLatLng();
    pointDragEndActions(pointId, [position.lat, position.lng]).forEach(dispatch);
  };

  const handleRefMarkerDragEnd = async (e: L.DragEndEvent) => {
    const position = e.target.getLatLng();
    await refDragEnd(state, [position.lat, position.lng], { fetchPointTimeSeries, fetchBufferTimeSeries }, dispatch);
  };

  const handleTsMarkerDoubleClick = (pointId: string) => () => {
    // Double-click to remove point
    pointDoubleClickActions(pointId).forEach(dispatch);
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
              pointClickActions(point.id).forEach(dispatch);
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

function PixelInspectLayer() {
  const { state } = useAppContext();
  const map = useMap();
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!state.pixelInspectEnabled) {
      setTooltip(null);
      if (timerRef.current) clearTimeout(timerRef.current);
      if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    }
  }, [state.pixelInspectEnabled]);

  useMapEvents({
    mousemove: (e) => {
      if (!state.pixelInspectEnabled || !state.currentDataset) return;
      const { x, y } = e.containerPoint;

      // In split screen, choose dataset based on which side the cursor is on.
      const req = pixelInspectRequest(state, [e.latlng.lat, e.latlng.lng], x, map.getSize().x);
      if (!req) return;
      const { dataset: activeDataset, onRight } = req;

      if (timerRef.current) clearTimeout(timerRef.current);
      if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
      timerRef.current = setTimeout(async () => {
        const controller = new AbortController();
        abortRef.current = controller;
        try {
          // Reads only the displayed time step — one chunk fetch, not the
          // whole (~80-shard) time series we then throw 99% of away.
          const res = await fetch(req.url, { signal: controller.signal });
          if (!res.ok) return;
          const values: number[] = await res.json();
          const val = values[0];  // backend returned only the requested step
          const unit = state.datasetInfo[activeDataset]?.unit ?? '';
          setTooltip({ x, y, text: pixelInspectText(val, unit, state.splitScreen, onRight) });
        } catch (err) {
          if ((err as Error).name !== 'AbortError') setTooltip(null);
        }
      }, 150);
    },
    mouseout: () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
      setTooltip(null);
    },
  });

  const parent = map.getContainer().parentElement;
  if (!state.pixelInspectEnabled || !tooltip || !parent) return null;

  return ReactDOM.createPortal(
    <div style={{
      position: 'absolute',
      left: tooltip.x + 14,
      top: tooltip.y - 10,
      background: 'rgba(10,10,10,0.88)',
      color: '#e8e6e3',
      padding: '3px 8px',
      borderRadius: 4,
      fontSize: '0.78em',
      fontFamily: 'var(--font-mono, monospace)',
      pointerEvents: 'none',
      whiteSpace: 'nowrap',
      zIndex: 3500,
      border: '1px solid rgba(255,255,255,0.15)',
      boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
    }}>
      {tooltip.text}
    </div>,
    parent,
  );
}

// Leaflet component: creates split panes and applies clip-path as splitPosition changes.
function SplitScreenControl() {
  const { state } = useAppContext();
  const map = useMap();

  // Create panes synchronously during render — the only way to guarantee they exist
  // before React-Leaflet's addLayer (which fires in useLayoutEffect) runs.
  // createPane is idempotent thanks to the getPane guard.
  if (!map.getPane('splitLeft')) {
    const p = map.createPane('splitLeft');
    p.style.zIndex = '200';
    p.style.pointerEvents = 'none';
  }
  if (!map.getPane('splitRight')) {
    const p = map.createPane('splitRight');
    p.style.zIndex = '201';
    p.style.pointerEvents = 'none';
  }

  useEffect(() => {
    const leftPane = map.getPane('splitLeft');
    const rightPane = map.getPane('splitRight');
    if (!leftPane || !rightPane) return;

    if (!state.splitScreen) {
      leftPane.style.clipPath = '';
      rightPane.style.clipPath = '';
      return;
    }

    // clip: rect() uses pixel values in the pane's own coordinate system.
    // The pane sits inside leaflet-map-pane which has CSS translate(dx,dy) for
    // panning. The divider is at screen-X = mapWidth * splitPosition.
    // In pane-local coords: localX = screenDividerX - dx.
    // We update on every move so the clip stays fixed in screen space.
    const updateClip = () => {
      const sz = map.getSize();
      const divX = Math.round(sz.x * state.splitPosition);
      const dx = L.DomUtil.getPosition(map.getPanes().mapPane).x;
      const lx = divX - dx; // divider in pane-local coords
      leftPane.style.clipPath  = `polygon(-99999px -99999px,${lx}px -99999px,${lx}px 99999px,-99999px 99999px)`;
      rightPane.style.clipPath = `polygon(${lx}px -99999px,99999px -99999px,99999px 99999px,${lx}px 99999px)`;
    };

    updateClip();
    map.on('move zoom viewreset moveend resize', updateClip);
    return () => {
      map.off('move zoom viewreset moveend resize', updateClip);
      leftPane.style.clipPath = '';
      rightPane.style.clipPath = '';
    };
  }, [state.splitScreen, state.splitPosition, map]);

  return null;
}

// User raster overlays, drawn between the basemap (zIndex 1-2) and the data
// layer (zIndex 10). Array order = stacking order; index 0 sits just above the
// basemap. Each overlay is tiled by the /overlay titiler (reprojected on the fly).
function OverlayLayers() {
  const { state } = useAppContext();
  const split = state.splitScreen;
  return (
    <>
      {state.overlays.flatMap((o, i) => {
        if (!o.visible || o.type === 'vector' || o.type === 'context' || o.type === 'pmtiles') return [];
        const zIndex = Math.min(3 + i, 9);
        // In split-screen, draw into the left/right (clipped) pane(s) per `side`.
        const side = o.side ?? 'both';
        const panes: (string | undefined)[] = !split
          ? [undefined]
          : side === 'left' ? ['splitLeft']
          : side === 'right' ? ['splitRight']
          : ['splitLeft', 'splitRight'];

        // Resolve the tile URL once (geotiff); WMS uses params.
        const url = o.type === 'geotiff' ? geotiffTileUrl(o) : '';
        const vizKey = overlayVizKey(o);

        return panes.map((pane) => {
          // Pane name (not index) in the key: react-leaflet can't move a layer
          // between panes after creation, so switching side must remount it.
          const key = `${o.id}:${pane ?? 'default'}:${vizKey}:${o.vmin}:${o.vmax}`;
          // Only pass `pane` when set: Leaflet's getPane(undefined) returns
          // undefined (it only resolves string pane names), and the layer then
          // crashes on `getPane().appendChild`. Omitting it uses the default pane.
          const paneProp = pane ? { pane } : {};
          // maxNativeZoom: past the service's deepest tiles, upsample instead of
          // requesting non-existent tiles (which 404 → the overlay vanishes on zoom-in).
          const mnz = o.maxNativeZoom;
          if (o.type === 'wms') {
            return (
              <WMSTileLayer key={key} {...paneProp} url={o.url ?? ''}
                params={{ layers: o.wmsLayers ?? '', format: 'image/png', transparent: true } as any}
                opacity={o.opacity} zIndex={zIndex} maxZoom={22} maxNativeZoom={mnz} />
            );
          }
          if (o.type === 'wmts') {
            return <TileLayer key={key} {...paneProp} url={o.url ?? ''} opacity={o.opacity} zIndex={zIndex} maxZoom={22} maxNativeZoom={mnz} />;
          }
          return <TileLayer key={key} {...paneProp} url={url} opacity={o.opacity} zIndex={zIndex} maxZoom={22} />;
        });
      })}
    </>
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
  // Debounce-settle instead of a counter: a per-tile counter leaked (tile errors
  // never fired the end event, and layer swaps dropped in-flight tiles) so the
  // spinner stuck on forever. Show "loading" on any tile start; clear it once no
  // tile has started/ended for a short settle window. Leak-proof.
  const settleRef = useRef<number | null>(null);
  const onTileStart = () => {
    if (settleRef.current) { window.clearTimeout(settleRef.current); settleRef.current = null; }
    setTileLoading(true);
  };
  const onTileEnd = () => {
    if (settleRef.current) window.clearTimeout(settleRef.current);
    settleRef.current = window.setTimeout(() => setTileLoading(false), 400);
  };
  const { active: profileActive } = useProfileContext();

  return (
    <div className="map-container">
      {toolbarsVisible ? (
        <>
          <MapLeftToolbar
            measureActive={measureActive}
            onToggleMeasure={() => setMeasureActive(v => !v)}
            onMeasureOff={() => setMeasureActive(false)}
            unsupported={LEAFLET_UNSUPPORTED}
          />
          <MapTopRightToolbar onToggleToolbars={onToggleToolbars} />
        </>
      ) : (
        <button
          className="map-tool-btn"
          data-command="map.toolbar"
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
    {state.splitScreen && <SplitDivider />}
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
        {...(bottomBm ? basemapLeafletZoom(bottomBm) : { maxZoom: MAP_MAX_ZOOM })}
        zIndex={1}
        eventHandlers={{ tileloadstart: onTileStart, tileload: onTileEnd, tileerror: onTileEnd }}
      />
      {topBm && (
        <TileLayer
          key={topBm.url}
          url={topBm.url}
          attribution={topBm.attribution}
          opacity={topOp}
          {...basemapLeafletZoom(topBm)}
          zIndex={2}
          eventHandlers={{ tileloadstart: onTileStart, tileload: onTileEnd, tileerror: onTileEnd }}
        />
      )}
      <OverlayLayers />
      <SplitScreenControl />
      <RasterTileLayer
        pane={state.splitScreen ? 'splitLeft' : undefined}
        onTileStart={onTileStart} onTileEnd={onTileEnd}
      />
      {state.splitScreen && state.splitDataset && (
        <RasterTileLayer
          pane="splitRight"
          overrideDataset={state.splitDataset}
          overrideColormap={state.splitColormap}
          overrideVmin={state.splitVmin}
          overrideVmax={state.splitVmax}
          overrideOpacity={state.splitOpacity}
          overrideTimeIndex={state.splitTimeIndex}
          onTileStart={onTileStart} onTileEnd={onTileEnd}
        />
      )}
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
      <PixelInspectLayer />
    </LeafletMapContainer>
    </div>
  );
}
