import { useEffect, useRef, useState, useCallback } from 'react';
import { useMap } from 'react-leaflet';
import { Line } from 'react-chartjs-2';
import L from 'leaflet';
import { useAppContext } from '../context/AppContext';

interface CentrePoint { dist: number; value: number }

// Vertex handle — defined once at module level, not recreated on each render
const VERTEX_ICON = L.divIcon({
  className: '',
  html: '<div style="width:12px;height:12px;border-radius:50%;background:#f0a500;border:2px solid white;box-sizing:border-box;margin-left:-6px;margin-top:-6px;cursor:grab"></div>',
  iconSize: [0, 0],
});

/** Read a CSS variable from the document root. */
function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export default function ProfileTool({ active, onDeactivate: _onDeactivate }: { active: boolean; onDeactivate: () => void }) {
  const map = useMap();
  const { state } = useAppContext();

  // All mutable map state kept in refs to avoid stale closures in Leaflet handlers
  const polyRef    = useRef<L.Polyline | null>(null);
  const previewRef = useRef<L.Polyline | null>(null);
  const markersRef = useRef<L.Marker[]>([]);
  const ptsRef     = useRef<L.LatLng[]>([]);
  const modeRef    = useRef<'idle' | 'drawing' | 'ready'>('idle');

  const [profileData, setProfileData] = useState<{ centre: CentrePoint[]; median: CentrePoint[] | null; samples: CentrePoint[][] } | null>(null);
  const [loading, setLoading]         = useState(false);
  const [radius, setRadius]           = useState(0);

  // Always-current reference to fetchProfile so drag handlers never go stale
  const fetchFn = useCallback(async (pts: L.LatLng[], r: number) => {
    if (pts.length < 2 || !state.currentDataset) return;
    setLoading(true);
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
        }),
      });
      if (!res.ok) return;
      const json = await res.json();
      if (Array.isArray(json)) {
        // Legacy centre-line response
        setProfileData({ centre: json, median: null, samples: [] });
      } else {
        setProfileData({
          centre: json.centre ?? [],
          median: json.median ?? null,
          samples: json.samples ?? [],
        });
      }
    } finally {
      setLoading(false);
    }
  }, [state.currentDataset, state.currentTimeIndex]);

  const fetchRef = useRef(fetchFn);
  useEffect(() => { fetchRef.current = fetchFn; }, [fetchFn]);

  const radiusRef = useRef(radius);
  useEffect(() => { radiusRef.current = radius; }, [radius]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const updatePoly = (pts: L.LatLng[]) => {
    if (polyRef.current) {
      polyRef.current.setLatLngs(pts);
    } else {
      polyRef.current = L.polyline(pts, { color: '#f0a500', weight: 2.5 }).addTo(map);
    }
  };

  const rebuildMarkers = (pts: L.LatLng[]) => {
    markersRef.current.forEach(m => m.remove());
    markersRef.current = pts.map((pt, idx) => {
      const m = L.marker(pt, { icon: VERTEX_ICON, draggable: true }).addTo(map);
      m.on('drag', () => {
        ptsRef.current[idx] = m.getLatLng();
        updatePoly(ptsRef.current);
      });
      m.on('dragend', () => {
        ptsRef.current[idx] = m.getLatLng();
        fetchRef.current(ptsRef.current, radiusRef.current);
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
    setProfileData(null);
  }, []);

  // Re-fetch when time index changes while a profile is drawn
  useEffect(() => {
    if (active && modeRef.current === 'ready' && ptsRef.current.length >= 2) {
      fetchRef.current(ptsRef.current, radiusRef.current);
    }
  }, [state.currentTimeIndex, active]);

  // Re-fetch when radius changes while a profile is ready
  useEffect(() => {
    if (active && modeRef.current === 'ready' && ptsRef.current.length >= 2) {
      fetchRef.current(ptsRef.current, radius);
    }
  }, [radius, active]);

  // ── Buffer corridor visualization ──────────────────────────────────────────
  useEffect(() => {
    if (!active || radius <= 0 || ptsRef.current.length < 2) return;

    // Build a polygon corridor around the polyline using L.circle at each vertex
    // as a simple approach: draw two offset polylines forming a band.
    // We use L.geodesicPolygon-style by computing perpendicular offsets via
    // Leaflet's CRS projection.
    const pts = ptsRef.current;
    const offsetPoints: L.LatLng[][] = [[], []]; // [left side, right side]

    for (let i = 0; i < pts.length; i++) {
      // Bearing from prev or next segment
      let bearingRad: number;
      if (i < pts.length - 1) {
        const dx = pts[i + 1].lng - pts[i].lng;
        const dy = pts[i + 1].lat - pts[i].lat;
        bearingRad = Math.atan2(dx, dy);
      } else {
        const dx = pts[i].lng - pts[i - 1].lng;
        const dy = pts[i].lat - pts[i - 1].lat;
        bearingRad = Math.atan2(dx, dy);
      }

      // Approximate degrees offset for the given radius in metres at this latitude
      const lat = pts[i].lat;
      const metersPerDegLat = 111320;
      const metersPerDegLng = 111320 * Math.cos((lat * Math.PI) / 180);
      const perpBearing = bearingRad + Math.PI / 2;
      const dLat = (radius / metersPerDegLat) * Math.cos(perpBearing);
      const dLng = (radius / metersPerDegLng) * Math.sin(perpBearing);

      offsetPoints[0].push(L.latLng(pts[i].lat + dLat, pts[i].lng + dLng));
      offsetPoints[1].push(L.latLng(pts[i].lat - dLat, pts[i].lng - dLng));
    }

    // Polygon: left side forward + right side reversed
    const poly = L.polygon([...offsetPoints[0], ...offsetPoints[1].reverse()], {
      color: '#f0a500',
      fillColor: '#f0a500',
      fillOpacity: 0.12,
      weight: 1,
      dashArray: '4 3',
    }).addTo(map);

    return () => { poly.remove(); };
  }, [active, radius, map,
    // re-run when pts change (after drawing / dragging)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    profileData,
  ]);

  // ── Main map event effect ──────────────────────────────────────────────────
  useEffect(() => {
    if (!active) {
      clearAll();
      map.getContainer().style.cursor = '';
      return;
    }

    map.getContainer().style.cursor = 'crosshair';

    const onClick = (e: L.LeafletMouseEvent) => {
      if (modeRef.current === 'ready') {
        clearAll();
        modeRef.current = 'drawing';
        map.getContainer().style.cursor = 'crosshair';
      }
      modeRef.current = 'drawing';
      ptsRef.current = [...ptsRef.current, e.latlng];
      updatePoly(ptsRef.current);
    };

    const onMouseMove = (e: L.LeafletMouseEvent) => {
      if (modeRef.current !== 'drawing' || ptsRef.current.length === 0) return;
      const preview = [...ptsRef.current, e.latlng];
      if (previewRef.current) {
        previewRef.current.setLatLngs(preview);
      } else {
        previewRef.current = L.polyline(preview, {
          color: '#f0a500', weight: 2, dashArray: '6 4',
        }).addTo(map);
      }
    };

    const onDblClick = (e: L.LeafletMouseEvent) => {
      L.DomEvent.stop(e);
      if (modeRef.current !== 'drawing' || ptsRef.current.length < 2) return;
      previewRef.current?.remove(); previewRef.current = null;
      updatePoly(ptsRef.current);
      modeRef.current = 'ready';
      map.getContainer().style.cursor = 'default';
      rebuildMarkers(ptsRef.current);
      fetchRef.current(ptsRef.current, radiusRef.current);
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

  // ── Chart panel ────────────────────────────────────────────────────────────
  if (!active) return null;

  if (loading) {
    return (
      <div className="profile-panel">
        <div className="chart-placeholder"><p>Extracting profile…</p></div>
      </div>
    );
  }

  const textColor  = cssVar('--sb-text',   '#dde0f0');
  const mutedColor = cssVar('--sb-muted',  '#7880a8');
  const gridColor  = cssVar('--sb-border', '#2c2f4a');

  const hasData = profileData && (profileData.centre.length > 0 || (profileData.median && profileData.median.length > 0));

  const datasets: any[] = [];

  if (hasData) {
    const useBuffer = radius > 0 && profileData!.median && profileData!.median.length > 0;

    // Random sample lines — thin, semi-transparent, behind everything
    if (useBuffer) {
      profileData!.samples.forEach((s, i) => {
        datasets.push({
          label: `sample ${i}`,
          data: s.map(p => p.value),
          labels: s.map(p => p.dist.toFixed(0)),
          borderColor: '#4d9de028',
          backgroundColor: 'transparent',
          borderWidth: 1,
          pointRadius: 0,
          fill: false,
          tension: 0.2,
        });
      });
    }

    // Centre line
    const centre = profileData!.centre;
    datasets.push({
      label: useBuffer ? 'centre' : state.currentDataset,
      data: centre.map(p => p.value),
      borderColor: useBuffer ? '#4d9de088' : '#4d9de0',
      backgroundColor: useBuffer ? 'transparent' : 'rgba(77,157,224,0.15)',
      borderWidth: useBuffer ? 1 : 1.5,
      pointRadius: 0,
      fill: !useBuffer,
      tension: 0.2,
    });

    // Median line — prominent
    if (useBuffer && profileData!.median) {
      datasets.push({
        label: 'median',
        data: profileData!.median.map(p => p.value),
        borderColor: '#4d9de0',
        backgroundColor: 'transparent',
        borderWidth: 2.5,
        pointRadius: 0,
        fill: false,
        tension: 0.2,
      });
    }
  }

  // Use centre (or median) for x-axis labels
  const xLabels = profileData
    ? (profileData.centre.length > 0 ? profileData.centre : profileData.median ?? []).map(p => p.dist.toFixed(0))
    : [];

  const chartData = { labels: xLabels, datasets };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 0 },
    plugins: {
      legend: {
        display: radius > 0,
        labels: {
          color: textColor,
          filter: (item: any) => !item.text.startsWith('sample'),
        },
      },
    },
    scales: {
      x: {
        title: { display: true, text: 'Distance (m)', color: mutedColor },
        ticks: { color: mutedColor, maxTicksLimit: 8 },
        grid: { color: gridColor },
      },
      y: {
        title: { display: true, text: state.currentDataset, color: mutedColor },
        ticks: { color: mutedColor },
        grid: { color: gridColor },
      },
    },
  };

  return (
    <div className="profile-panel">
      <div className="chart-header">
        <h4>Profile — {state.currentDataset}</h4>
        <div className="profile-radius-control">
          <label htmlFor="profile-radius" style={{ color: mutedColor, fontSize: '0.8em', marginRight: 4 }}>
            Radius (m):
          </label>
          <input
            id="profile-radius"
            type="number"
            min={0}
            step={100}
            value={radius}
            onChange={e => setRadius(Math.max(0, Number(e.target.value)))}
            className="profile-radius-input"
          />
        </div>
        <button className="chart-btn" onClick={clearAll} title="Clear profile">
          <i className="fa-solid fa-xmark"></i>
        </button>
      </div>
      {hasData && (
        <div style={{ height: 180, position: 'relative' }}>
          <Line data={chartData} options={options as any} />
        </div>
      )}
    </div>
  );
}
