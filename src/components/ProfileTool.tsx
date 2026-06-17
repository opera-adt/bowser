import { useEffect, useRef, useState, useCallback, createContext, useContext } from 'react';
import { useMap } from 'react-leaflet';
import { Chart as ChartJS } from 'chart.js';
import { Line } from 'react-chartjs-2';
import L from 'leaflet';
import { useAppContext } from '../context/AppContext';
import { useDraggableResizable } from '../hooks/useDraggableResizable';
import { downloadChartAsPng } from '../utils/screenshot';

interface CentrePoint { dist: number; value: number }
interface ProfileResponse {
  centre: CentrePoint[];
  median: CentrePoint[] | null;
  samples: CentrePoint[][];
  binned?: boolean;
  bin_width?: number;
}

interface ProfileState {
  data: ProfileResponse | null;
  loading: boolean;
  radius: number;
  samplingInterval: number;
  active: boolean;
  hoverDist: number | null;
  setActive: (a: boolean) => void;
  setRadius: (r: number) => void;
  setSamplingInterval: (s: number) => void;
  setHoverDist: (d: number | null) => void;
  clearAll: () => void;
  // private setters for ProfileToolMap
  _setData: (d: ProfileResponse | null) => void;
  _setLoading: (l: boolean) => void;
}

export const ProfileContext = createContext<ProfileState>({
  data: null, loading: false, radius: 0, samplingInterval: 0, active: false, hoverDist: null,
  setActive: () => {}, setRadius: () => {}, setSamplingInterval: () => {}, setHoverDist: () => {}, clearAll: () => {},
  _setData: () => {}, _setLoading: () => {},
});

export function useProfileContext() { return useContext(ProfileContext); }

// Direction palette: start green → end red, middle orange. Matches the
// start→end gradient on the profile chart line so both views agree on which
// end is which.
const START_COLOR = '#2ca02c';
const END_COLOR = '#d62728';
const MID_COLOR = '#f0a500';

function vertexIcon(index: number, total: number): L.DivIcon {
  const isStart = index === 0;
  const isEnd = total > 1 && index === total - 1;
  const bg = isStart ? START_COLOR : isEnd ? END_COLOR : MID_COLOR;
  const label = String(index + 1);
  return L.divIcon({
    className: '',
    html: `<div style="width:18px;height:18px;border-radius:50%;background:${bg};color:white;border:2px solid white;box-sizing:border-box;margin-left:-9px;margin-top:-9px;cursor:grab;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;box-shadow:0 0 3px rgba(0,0,0,0.4);user-select:none;">${label}</div>`,
    iconSize: [0, 0],
  });
}

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

// ── Provider ──────────────────────────────────────────────────────────────────
export function ProfileProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [radius, setRadius] = useState(0);
  const [samplingInterval, setSamplingInterval] = useState(0);
  const [active, setActive] = useState(false);
  const [hoverDist, setHoverDist] = useState<number | null>(null);
  const clearAll = useCallback(() => { setData(null); setHoverDist(null); }, []);

  return (
    <ProfileContext.Provider value={{
      data, loading, radius, samplingInterval, active, hoverDist,
      setActive, setRadius, setSamplingInterval, setHoverDist, clearAll,
      _setData: setData, _setLoading: setLoading,
    }}>
      {children}
    </ProfileContext.Provider>
  );
}

// ── Map-only component (inside Leaflet MapContainer, renders null) ─────────────
/** Interpolate a lat/lng position at `targetDist` metres along a polyline. */
function latlngAtDist(pts: L.LatLng[], targetDist: number): L.LatLng | null {
  if (pts.length < 2) return null;
  let cum = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const segLen = pts[i].distanceTo(pts[i + 1]);
    if (cum + segLen >= targetDist) {
      const frac = segLen > 0 ? (targetDist - cum) / segLen : 0;
      return L.latLng(
        pts[i].lat + frac * (pts[i + 1].lat - pts[i].lat),
        pts[i].lng + frac * (pts[i + 1].lng - pts[i].lng),
      );
    }
    cum += segLen;
  }
  return pts[pts.length - 1];
}

export function ProfileToolMap() {
  const map = useMap();
  const { state } = useAppContext();
  const ctx = useContext(ProfileContext);
  const { active, radius, samplingInterval, hoverDist, _setData, _setLoading, clearAll: ctxClearAll } = ctx;

  const polyRef    = useRef<L.Polyline | null>(null);
  const previewRef = useRef<L.Polyline | null>(null);
  const markersRef = useRef<L.Marker[]>([]);
  const ptsRef     = useRef<L.LatLng[]>([]);
  const modeRef    = useRef<'idle' | 'drawing' | 'ready'>('idle');
  const hoverDotRef = useRef<L.CircleMarker | null>(null);

  // Always-current refs so Leaflet handlers don't close over stale values
  const radiusRef = useRef(radius);
  const siRef     = useRef(samplingInterval);
  useEffect(() => { radiusRef.current = radius; }, [radius]);
  useEffect(() => { siRef.current = samplingInterval; }, [samplingInterval]);

  const fetchFnRef = useRef<(pts: L.LatLng[], r: number, si: number) => Promise<void>>();

  const fetchProfile = useCallback(async (pts: L.LatLng[], r: number, si: number) => {
    if (pts.length < 2 || !state.currentDataset) return;
    _setLoading(true);
    try {
      const res = await fetch('/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          coords: pts.map(p => [p.lng, p.lat]),
          dataset_name: state.currentDataset,
          time_index: state.currentTimeIndex,
          n_samples: 200,
          radius: r,
          n_random: 5,
          sampling_interval: si,
        }),
      });
      if (!res.ok) return;
      const json = await res.json();
      if (Array.isArray(json)) {
        _setData({ centre: json, median: null, samples: [], binned: false });
      } else {
        _setData({
          centre: json.centre ?? [],
          median: json.median ?? null,
          samples: json.samples ?? [],
          binned: json.binned ?? false,
          bin_width: json.bin_width,
        });
      }
    } finally {
      _setLoading(false);
    }
  }, [state.currentDataset, state.currentTimeIndex, _setData, _setLoading]);

  fetchFnRef.current = fetchProfile;

  const updatePoly = (pts: L.LatLng[]) => {
    if (polyRef.current) polyRef.current.setLatLngs(pts);
    else polyRef.current = L.polyline(pts, { color: '#f0a500', weight: 2.5 }).addTo(map);
  };

  const rebuildMarkers = (pts: L.LatLng[]) => {
    markersRef.current.forEach(m => m.remove());
    markersRef.current = pts.map((pt, idx) => {
      const m = L.marker(pt, {
        icon: vertexIcon(idx, pts.length),
        draggable: true,
        title: 'Drag to move',
      }).addTo(map);
      m.on('drag', () => { ptsRef.current[idx] = m.getLatLng(); updatePoly(ptsRef.current); });
      m.on('dragend', () => {
        ptsRef.current[idx] = m.getLatLng();
        fetchFnRef.current?.(ptsRef.current, radiusRef.current, siRef.current);
      });
      return m;
    });
  };

  const clearAll = useCallback(() => {
    polyRef.current?.remove();    polyRef.current = null;
    previewRef.current?.remove(); previewRef.current = null;
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];
    ptsRef.current = [];
    modeRef.current = 'idle';
    hoverDotRef.current?.remove(); hoverDotRef.current = null;
    ctxClearAll();
  }, [ctxClearAll]);

  // Show/hide gray dot on map as user hovers over the profile chart
  useEffect(() => {
    if (hoverDist === null || modeRef.current !== 'ready' || ptsRef.current.length < 2) {
      hoverDotRef.current?.remove();
      hoverDotRef.current = null;
      return;
    }
    const pos = latlngAtDist(ptsRef.current, hoverDist);
    if (!pos) return;
    if (hoverDotRef.current) {
      hoverDotRef.current.setLatLng(pos);
    } else {
      hoverDotRef.current = L.circleMarker(pos, {
        radius: 7, color: 'white', weight: 2,
        fillColor: '#888888', fillOpacity: 0.9, interactive: false,
      }).addTo(map);
    }
  }, [hoverDist, map]);

  // Re-fetch when time index changes
  useEffect(() => {
    if (active && modeRef.current === 'ready' && ptsRef.current.length >= 2)
      fetchFnRef.current?.(ptsRef.current, radiusRef.current, siRef.current);
  }, [state.currentTimeIndex, active]);

  // Re-fetch when radius changes
  useEffect(() => {
    if (active && modeRef.current === 'ready' && ptsRef.current.length >= 2)
      fetchFnRef.current?.(ptsRef.current, radius, siRef.current);
  }, [radius, active]);

  // Re-fetch when samplingInterval changes
  useEffect(() => {
    if (active && modeRef.current === 'ready' && ptsRef.current.length >= 2)
      fetchFnRef.current?.(ptsRef.current, radiusRef.current, samplingInterval);
  }, [samplingInterval, active]);

  // Buffer corridor visualization
  useEffect(() => {
    if (!active || radius <= 0 || ptsRef.current.length < 2) return;
    const pts = ptsRef.current;
    const offsetPoints: L.LatLng[][] = [[], []];
    for (let i = 0; i < pts.length; i++) {
      const bearingRad = i < pts.length - 1
        ? Math.atan2(pts[i+1].lng - pts[i].lng, pts[i+1].lat - pts[i].lat)
        : Math.atan2(pts[i].lng - pts[i-1].lng, pts[i].lat - pts[i-1].lat);
      const lat = pts[i].lat;
      const mPerDegLat = 111320;
      const mPerDegLng = 111320 * Math.cos((lat * Math.PI) / 180);
      const perp = bearingRad + Math.PI / 2;
      const dLat = (radius / mPerDegLat) * Math.cos(perp);
      const dLng = (radius / mPerDegLng) * Math.sin(perp);
      offsetPoints[0].push(L.latLng(pts[i].lat + dLat, pts[i].lng + dLng));
      offsetPoints[1].push(L.latLng(pts[i].lat - dLat, pts[i].lng - dLng));
    }
    const poly = L.polygon([...offsetPoints[0], ...offsetPoints[1].reverse()], {
      color: '#f0a500', fillColor: '#f0a500', fillOpacity: 0.12, weight: 1, dashArray: '4 3',
    }).addTo(map);
    return () => { poly.remove(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, radius, map, ctx.data]);

  // Main map interaction
  useEffect(() => {
    if (!active) { clearAll(); map.getContainer().style.cursor = ''; return; }
    map.getContainer().style.cursor = 'crosshair';

    const onClick = (e: L.LeafletMouseEvent) => {
      if (modeRef.current === 'ready') { clearAll(); modeRef.current = 'drawing'; map.getContainer().style.cursor = 'crosshair'; }
      modeRef.current = 'drawing';
      ptsRef.current = [...ptsRef.current, e.latlng];
      updatePoly(ptsRef.current);
    };
    const onMouseMove = (e: L.LeafletMouseEvent) => {
      if (modeRef.current !== 'drawing' || ptsRef.current.length === 0) return;
      const preview = [...ptsRef.current, e.latlng];
      if (previewRef.current) previewRef.current.setLatLngs(preview);
      else previewRef.current = L.polyline(preview, { color: '#f0a500', weight: 2, dashArray: '6 4' }).addTo(map);
    };
    const onDblClick = (e: L.LeafletMouseEvent) => {
      L.DomEvent.stop(e);
      // A double-click fires click → click → dblclick, so onClick has
      // already appended up to two extra vertices at this pixel before we
      // get here. Collapse any trailing vertices that land on the same
      // screen pixel so the finish gesture doesn't leave phantom points
      // stacked at the end.
      const DUP_PX = 5;
      while (ptsRef.current.length >= 2) {
        const n = ptsRef.current.length;
        const a = map.latLngToContainerPoint(ptsRef.current[n - 1]);
        const b = map.latLngToContainerPoint(ptsRef.current[n - 2]);
        if (a.distanceTo(b) <= DUP_PX) ptsRef.current = ptsRef.current.slice(0, -1);
        else break;
      }
      if (modeRef.current !== 'drawing' || ptsRef.current.length < 2) return;
      previewRef.current?.remove(); previewRef.current = null;
      updatePoly(ptsRef.current);
      modeRef.current = 'ready';
      map.getContainer().style.cursor = 'default';
      rebuildMarkers(ptsRef.current);
      fetchFnRef.current?.(ptsRef.current, radiusRef.current, siRef.current);
    };

    map.on('click', onClick);
    map.on('mousemove', onMouseMove);
    map.on('dblclick', onDblClick);
    map.doubleClickZoom.disable();
    return () => {
      map.off('click', onClick);
      map.off('mousemove', onMouseMove);
      map.off('dblclick', onDblClick);
      map.doubleClickZoom.enable();
      map.getContainer().style.cursor = '';
    };
  }, [active, map, clearAll]);

  return null;
}

// ── Chart panel (outside MapContainer, no Leaflet DOM) ────────────────────────
export function ProfileChart() {
  const { state } = useAppContext();
  const { active, data: profileData, loading, radius, samplingInterval,
          setActive, setRadius, setSamplingInterval, setHoverDist, clearAll } = useProfileContext();
  const chartRef = useRef<ChartJS<'line'>>(null);
  const { panelRef, panelStyle, onDragMouseDown, resizeGrip } = useDraggableResizable({
    defaultWidth: 540, defaultHeight: 280, initialRight: 20, initialBottom: 20,
    minWidth: 200, minHeight: 150,
  });

  // Drafts so typing / arrow-key nudges don't fire /profile on every keystroke.
  // Commit to context (which triggers extraction) only on Enter or blur.
  const [draftRadius, setDraftRadius] = useState(String(radius));
  const [draftSampling, setDraftSampling] = useState(String(samplingInterval));
  useEffect(() => { setDraftRadius(String(radius)); }, [radius]);
  useEffect(() => { setDraftSampling(String(samplingInterval)); }, [samplingInterval]);

  const commitRadius = () => {
    const v = Math.max(0, Number(draftRadius));
    if (!Number.isNaN(v) && v !== radius) setRadius(v);
    else setDraftRadius(String(radius));
  };
  const commitSampling = () => {
    const v = Math.max(0, Number(draftSampling));
    if (!Number.isNaN(v) && v !== samplingInterval) setSamplingInterval(v);
    else setDraftSampling(String(samplingInterval));
  };

  if (!active) return null;

  if (loading) return (
    <div ref={panelRef} style={{ ...panelStyle, position: 'fixed' }} className="profile-panel"
      onMouseDown={e => e.stopPropagation()}>
      <div className="chart-placeholder"><p>Extracting profile…</p></div>
    </div>
  );

  const textColor  = cssVar('--sb-text',   '#dde0f0');
  const mutedColor = cssVar('--sb-muted',  '#7880a8');
  const gridColor  = cssVar('--sb-border', '#2c2f4a');

  // Start→end gradient for the main profile line, matching vertex marker colors.
  // Returns a CanvasGradient spanning the plot area; on the very first render
  // the chartArea isn't laid out yet, so fall back to the end color.
  const gradientBorder = (context: any): string | CanvasGradient => {
    const { ctx: c, chartArea } = context.chart;
    if (!chartArea) return END_COLOR;
    const g = c.createLinearGradient(chartArea.left, 0, chartArea.right, 0);
    g.addColorStop(0, START_COLOR);
    g.addColorStop(1, END_COLOR);
    return g;
  };
  // Endpoint markers on the chart: green dot at the first sample, red at the
  // last, invisible elsewhere. Reinforces the direction cue when the line is
  // hidden (binned median) or nearly flat.
  const endpointColor = (start: string, end: string) => (ctx: any) => {
    const n = ctx.dataset.data?.length ?? 0;
    if (ctx.dataIndex === 0) return start;
    if (ctx.dataIndex === n - 1) return end;
    return 'transparent';
  };
  const endpointRadius = (size: number) => (ctx: any) => {
    const n = ctx.dataset.data?.length ?? 0;
    return ctx.dataIndex === 0 || ctx.dataIndex === n - 1 ? size : 0;
  };

  const hasData = profileData && (profileData.centre.length > 0 || (profileData.median && profileData.median.length > 0));
  const isBinned = !!(profileData?.binned && samplingInterval > 0);
  const datasets: any[] = [];

  if (hasData) {
    const useBuffer = radius > 0 && profileData!.median && profileData!.median.length > 0;
    if (isBinned) {
      profileData!.samples.forEach((s, i) => datasets.push({
        label: `sample ${i}`, data: s.map(p => p.value),
        borderColor: '#4d9de028', backgroundColor: 'transparent', borderWidth: 1, pointRadius: 0, fill: false, tension: 0.3,
      }));
      if (profileData!.centre.length > 0) datasets.push({
        label: 'centre', data: profileData!.centre.map(p => p.value),
        borderColor: '#4d9de066', backgroundColor: 'transparent', borderWidth: 1, borderDash: [4, 3], pointRadius: 0, fill: false, tension: 0,
      });
      if (profileData!.median) datasets.push({
        label: 'median', data: profileData!.median.map(p => p.value),
        borderColor: gradientBorder,
        backgroundColor: 'transparent',
        pointBackgroundColor: endpointColor(START_COLOR, END_COLOR),
        pointBorderColor: endpointColor(START_COLOR, END_COLOR),
        borderWidth: 2.5, showLine: true,
        pointStyle: 'circle',
        pointRadius: (ctx: any) => {
          const n = ctx.dataset.data?.length ?? 0;
          return ctx.dataIndex === 0 || ctx.dataIndex === n - 1 ? 7 : 4;
        },
        pointHoverRadius: 7, fill: false, tension: 0.2,
      });
    } else {
      if (useBuffer) profileData!.samples.forEach((s, i) => datasets.push({
        label: `sample ${i}`, data: s.map(p => p.value),
        borderColor: '#4d9de028', backgroundColor: 'transparent', borderWidth: 1, pointRadius: 0, fill: false, tension: 0.2,
      }));
      const centre = profileData!.centre;
      datasets.push({
        label: useBuffer ? 'centre' : state.currentDataset,
        data: centre.map(p => p.value),
        borderColor: useBuffer ? '#4d9de088' : gradientBorder,
        backgroundColor: useBuffer ? 'transparent' : 'rgba(77,157,224,0.15)',
        borderWidth: useBuffer ? 1 : 1.5,
        pointRadius: useBuffer ? 0 : endpointRadius(6),
        pointBackgroundColor: useBuffer ? undefined : endpointColor(START_COLOR, END_COLOR),
        pointBorderColor: useBuffer ? undefined : endpointColor(START_COLOR, END_COLOR),
        fill: !useBuffer, tension: 0.2,
      });
      if (useBuffer && profileData!.median) datasets.push({
        label: 'median', data: profileData!.median.map(p => p.value),
        borderColor: gradientBorder, backgroundColor: 'transparent',
        borderWidth: 2.5,
        pointRadius: endpointRadius(6),
        pointBackgroundColor: endpointColor(START_COLOR, END_COLOR),
        pointBorderColor: endpointColor(START_COLOR, END_COLOR),
        fill: false, tension: 0.2,
      });
    }
  }

  const xSourcePts = profileData
    ? (isBinned && profileData.median ? profileData.median
      : profileData.centre.length > 0 ? profileData.centre
      : profileData.median ?? [])
    : [];
  const xLabels = xSourcePts.map(p => p.dist.toFixed(0));
  const chartData = { labels: xLabels, datasets };

  const options = {
    responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
    onHover: (_evt: any, elements: any[]) => {
      if (elements.length > 0) {
        const dist = parseFloat(xLabels[elements[0].index]);
        setHoverDist(isNaN(dist) ? null : dist);
      } else {
        setHoverDist(null);
      }
    },
    plugins: {
      legend: { display: radius > 0 || isBinned, labels: { color: textColor, filter: (item: any) => !item.text.startsWith('sample') } },
      tooltip: { callbacks: { title: (ctx: any) => `${ctx[0]?.label ?? ''} m` } },
    },
    scales: {
      x: { title: { display: true, text: 'Distance (m) — start → end', color: mutedColor }, ticks: { color: mutedColor, maxTicksLimit: 8 }, grid: { color: gridColor } },
      y: { title: { display: true, text: state.currentDataset, color: mutedColor }, ticks: { color: mutedColor }, grid: { color: gridColor } },
    },
  };

  return (
    <div ref={panelRef} className="profile-panel" style={{ ...panelStyle, position: 'fixed' }}
      onMouseDown={e => e.stopPropagation()}>
      <div className="chart-header" onMouseDown={onDragMouseDown} style={{ cursor: 'grab' }}>
        <h4>Profile — {state.currentDataset}</h4>
        <div className="profile-radius-control">
          <label style={{ color: mutedColor, fontSize: '0.8em', marginRight: 4 }}>Sampling (m):</label>
          <input type="text" inputMode="decimal" value={draftSampling}
            onChange={e => setDraftSampling(e.target.value)}
            onBlur={commitSampling}
            onKeyDown={e => { if (e.key === 'Enter') { e.currentTarget.blur(); } }}
            className="profile-radius-input" onMouseDown={e => e.stopPropagation()} />
          <label style={{ color: mutedColor, fontSize: '0.8em', marginLeft: 8, marginRight: 4 }}>Radius (m):</label>
          <input type="text" inputMode="decimal" value={draftRadius}
            onChange={e => setDraftRadius(e.target.value)}
            onBlur={commitRadius}
            onKeyDown={e => { if (e.key === 'Enter') { e.currentTarget.blur(); } }}
            className="profile-radius-input" onMouseDown={e => e.stopPropagation()} />
        </div>
        <button className="chart-btn" title="Save as PNG (transparent background)" onClick={() => {
          const canvas = chartRef.current?.canvas;
          if (canvas) downloadChartAsPng(canvas, `profile-${state.currentDataset}-${Date.now()}.png`);
        }}>
          <i className="fa-solid fa-camera"></i>
        </button>
        <button className="chart-btn" onClick={() => { clearAll(); setActive(false); }} title="Close profile">
          <i className="fa-solid fa-xmark"></i>
        </button>
      </div>
      {hasData && (
        <div style={{ flex: 1, minHeight: 120, position: 'relative' }}
          onMouseLeave={() => setHoverDist(null)}>
          <Line ref={chartRef} data={chartData} options={options as any} />
        </div>
      )}
      {resizeGrip}
    </div>
  );
}

export default ProfileToolMap;
