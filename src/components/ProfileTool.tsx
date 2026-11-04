import { useEffect, useRef, useState, useCallback, createContext, useContext } from 'react';
import { useMap } from 'react-leaflet';
import { Chart as ChartJS } from 'chart.js';
import { Line } from 'react-chartjs-2';
import L from 'leaflet';
import { useAppContext } from '../context/AppContext';
import { useDraggableResizable } from '../hooks/useDraggableResizable';
import { downloadChartAsPng } from '../utils/screenshot';
import { parseProfileResponse, profileRequest, type ProfileResponse } from '../map/profile';
import { corridorRing, dropTrailingDuplicates, pointAtDistance, type LatLng } from '../map/profileGeometry';


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

// ── Shared by both maps: fetch the profile, refetch when inputs change ──────────
/**
 * ``fetchProfile(pts)`` requests the profile for a finished line ([lat, lng] vertices)
 * and stores it in the context; the profile is refetched for the current line when the
 * time step, the corridor radius or the sampling interval changes. ``getLine`` returns
 * the finished line, or null while drawing / idle.
 */
export function useProfileFetch(getLine: () => LatLng[] | null) {
  const { state } = useAppContext();
  const { active, radius, samplingInterval, _setData, _setLoading } = useContext(ProfileContext);
  const radiusRef = useRef(radius);
  const siRef = useRef(samplingInterval);
  useEffect(() => { radiusRef.current = radius; }, [radius]);
  useEffect(() => { siRef.current = samplingInterval; }, [samplingInterval]);
  const lineRef = useRef(getLine);
  lineRef.current = getLine;

  const run = useCallback(async (pts: LatLng[], r: number, si: number) => {
    if (pts.length < 2 || !state.currentDataset) return;
    _setLoading(true);
    try {
      const req = profileRequest(pts.map(([lat, lng]) => [lng, lat]), state.currentDataset, state.currentTimeIndex, r, si);
      const res = await fetch(req.url, req.init);
      if (!res.ok) return;
      _setData(parseProfileResponse(await res.json()));
    } finally {
      _setLoading(false);
    }
  }, [state.currentDataset, state.currentTimeIndex, _setData, _setLoading]);
  const runRef = useRef(run);
  runRef.current = run;

  // Re-fetch when time index changes
  useEffect(() => {
    const line = lineRef.current();
    if (active && line && line.length >= 2) runRef.current(line, radiusRef.current, siRef.current);
  }, [state.currentTimeIndex, active]);

  // Re-fetch when radius changes
  useEffect(() => {
    const line = lineRef.current();
    if (active && line && line.length >= 2) runRef.current(line, radius, siRef.current);
  }, [radius, active]);

  // Re-fetch when samplingInterval changes
  useEffect(() => {
    const line = lineRef.current();
    if (active && line && line.length >= 2) runRef.current(line, radiusRef.current, samplingInterval);
  }, [samplingInterval, active]);

  return useCallback((pts: LatLng[]) => runRef.current(pts, radiusRef.current, siRef.current), []);
}

// ── Map-only component (inside Leaflet MapContainer, renders null) ─────────────
const toLL = (p: L.LatLng): LatLng => [p.lat, p.lng];

export function ProfileToolMap() {
  const map = useMap();
  const ctx = useContext(ProfileContext);
  const { active, radius, hoverDist, clearAll: ctxClearAll } = ctx;

  const polyRef    = useRef<L.Polyline | null>(null);
  const previewRef = useRef<L.Polyline | null>(null);
  const markersRef = useRef<L.Marker[]>([]);
  const ptsRef     = useRef<L.LatLng[]>([]);
  const modeRef    = useRef<'idle' | 'drawing' | 'ready'>('idle');
  const hoverDotRef = useRef<L.CircleMarker | null>(null);

  const fetchLine = useProfileFetch(() => (modeRef.current === 'ready' ? ptsRef.current.map(toLL) : null));

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
        fetchLine(ptsRef.current.map(toLL));
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
    const at = pointAtDistance(ptsRef.current.map(toLL), hoverDist);
    if (!at) return;
    const pos = L.latLng(at[0], at[1]);
    if (hoverDotRef.current) {
      hoverDotRef.current.setLatLng(pos);
    } else {
      hoverDotRef.current = L.circleMarker(pos, {
        radius: 7, color: 'white', weight: 2,
        fillColor: '#888888', fillOpacity: 0.9, interactive: false,
      }).addTo(map);
    }
  }, [hoverDist, map]);

  // Buffer corridor visualization
  useEffect(() => {
    if (!active || radius <= 0 || ptsRef.current.length < 2) return;
    const ring = corridorRing(ptsRef.current.map(toLL), radius);
    const poly = L.polygon(ring, {
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
      const kept = dropTrailingDuplicates(ptsRef.current.map(toLL), p => {
        const c = map.latLngToContainerPoint(L.latLng(p[0], p[1]));
        return [c.x, c.y];
      });
      ptsRef.current = ptsRef.current.slice(0, kept.length);
      if (modeRef.current !== 'drawing' || ptsRef.current.length < 2) return;
      previewRef.current?.remove(); previewRef.current = null;
      updatePoly(ptsRef.current);
      modeRef.current = 'ready';
      map.getContainer().style.cursor = 'default';
      rebuildMarkers(ptsRef.current);
      fetchLine(ptsRef.current.map(toLL));
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
  }, [active, map, clearAll, fetchLine]);

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
