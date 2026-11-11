import { useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { GNSS_CUSTOM_LAYER_ID, GNSS_LAYER_ID } from '../map/gnss';
import type { PointMarker } from '../map/markers';

const MARKER_GLYPH: Record<PointMarker, string> = { circle: '●', square: '■', triangle: '▲', diamond: '◆', star: '★', pin: '⚲' };

/**
 * Legends of the visible overlays that have one: land cover and soil classes, GNSS stations,
 * and geology, whose colours are per-map units, so it shows the unit the identify tool last found.
 */
export default function MapLegend() {
  const { state } = useAppContext();
  const [collapsed, setCollapsed] = useState(false);
  const shown = state.overlays.filter(o => o.visible && (o.legend || o.serviceKey === 'geology' || o.id === GNSS_LAYER_ID || o.id === GNSS_CUSTOM_LAYER_ID)).reverse();
  if (!shown.length) return null;
  const unit = state.identify?.items.find(i => i.title.startsWith('Geology'));
  return (
    <div className="map-legend" onMouseDown={e => e.stopPropagation()}>
      <button type="button" className="map-legend-head" aria-expanded={!collapsed} onClick={() => setCollapsed(c => !c)}>
        Legend
        <span className={`disclosure-chevron${collapsed ? '' : ' open'}`} aria-hidden="true" />
      </button>
      {!collapsed && shown.map(o => (
        <div key={o.id} className="map-legend-layer">
          <div className="map-legend-title">{o.name}</div>
          {o.legend && (
            <div className="ov-legend">
              {o.legend.map(([label, color]) => <span key={label}><i style={{ background: color }} />{label}</span>)}
            </div>
          )}
          {(o.id === GNSS_LAYER_ID || o.id === GNSS_CUSTOM_LAYER_ID) && (
            <div className="ov-legend"><span><b className="map-legend-glyph" style={{ color: o.color }}>{MARKER_GLYPH[o.marker ?? 'circle']}</b>{o.id === GNSS_CUSTOM_LAYER_ID ? 'GNSS station (your file)' : 'GNSS station'}</span></div>
          )}
          {o.serviceKey === 'geology' && (
            unit
              ? <div className="map-legend-unit">{unit.color && <i style={{ background: unit.color }} />}{unit.rows.map(([, v]) => v).slice(0, 2).join(' · ')}</div>
              : <div className="row-label" style={{ fontSize: '0.92em' }}>Colours are map units: turn on identify (pointer) and click to name one.</div>
          )}
        </div>
      ))}
    </div>
  );
}
