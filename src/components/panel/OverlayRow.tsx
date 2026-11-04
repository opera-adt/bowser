import { useRef, useState } from 'react';
import { useAppContext } from '../../context/AppContext';
import { binColorsFor } from '../../hooks/useAddFiles';
import ColorScalePicker from './ColorScalePicker';
import { POINT_MARKERS, type PointMarker } from '../../map/markers';

const MARKER_LABEL: Record<PointMarker, string> = {
  circle: '● circle', square: '■ square', triangle: '▲ triangle', diamond: '◆ diamond', star: '★ star', pin: '⚲ pin',
};
import { MAX_CLASSES, OTHER_COLOR, SOIL_FIELDS, soilColoring, type SoilField } from '../../map/soilClasses';
import type { Overlay } from '../../types';
import { Switch } from './controls';

export type DropSide = 'above' | 'below' | null;

interface OverlayRowProps {
  overlay: Overlay;
  dropSide: DropSide;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (below: boolean) => void;
  onDragLeave: () => void;
  onDrop: () => void;
}

const TYPE_LABEL: Record<Overlay['type'], string> = { geotiff: 'GeoTIFF', wms: 'WMS', wmts: 'WMTS', vector: 'Vector', context: 'Context', pmtiles: 'PMTiles' };

/** One layer: grip to reorder, visibility, name, zoom, remove, opacity, and its style when opened. */
export default function OverlayRow({ overlay: o, dropSide, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop }: OverlayRowProps) {
  const { state, dispatch } = useAppContext();
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const update = (updates: Partial<Overlay>) => dispatch({ type: 'UPDATE_OVERLAY', payload: { id: o.id, updates } });

  return (
    <div ref={rowRef} className={`ov-row${dropSide ? ` drop-${dropSide}` : ''}`}
      onDragStart={e => { e.dataTransfer.setData('text/plain', o.id); e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragEnd={() => { if (rowRef.current) rowRef.current.draggable = false; onDragEnd(); }}
      onDragOver={e => {
        const rect = e.currentTarget.getBoundingClientRect();
        e.preventDefault();
        onDragOver(e.clientY > rect.top + rect.height / 2);
      }}
      onDragLeave={onDragLeave}
      onDrop={e => { e.preventDefault(); onDrop(); }}
    >
      <div className="ov-row-head">
        {/* Only the grip starts a reorder, so the slider and buttons keep their own drag. */}
        <span className="ov-grip" title="Drag to reorder" aria-hidden="true"
          onPointerDown={() => { if (rowRef.current) rowRef.current.draggable = true; }}
          onPointerUp={() => { if (rowRef.current) rowRef.current.draggable = false; }}>⋮⋮</span>
        <button type="button" className="ov-icon-btn" title={o.visible ? 'Hide' : 'Show'} aria-pressed={o.visible}
          onClick={() => update({ visible: !o.visible })}>
          <i className={`fa-solid ${o.visible ? 'fa-eye' : 'fa-eye-slash'}`}></i>
        </button>
        {(o.type === 'vector' || o.pmtilesKind === 'vector' || (o.type === 'context' && o.color)) && <span className="ov-swatch" style={{ background: o.color }} />}
        <span className="ov-name" title={o.name}>{o.name}</span>
        {o.bounds && (
          <button type="button" className="ov-icon-btn" title="Zoom to this layer"
            onClick={() => { const b = o.bounds!; dispatch({ type: 'APPLY_VIEW_BOUNDS', payload: [b[1], b[0], b[3], b[2]] }); }}>
            <i className="fa-solid fa-crosshairs"></i>
          </button>
        )}
        {(
          <button type="button" className="ov-icon-btn" title="Style" aria-expanded={open} onClick={() => setOpen(v => !v)}>
            <span className={`disclosure-chevron${open ? ' open' : ''}`} aria-hidden="true" />
          </button>
        )}
        <button type="button" className="ov-icon-btn danger" title="Remove" onClick={() => dispatch({ type: 'REMOVE_OVERLAY', payload: o.id })}>
          <i className="fa-solid fa-xmark"></i>
        </button>
      </div>
      <div className="ov-opacity">
        <span className="ov-type">{TYPE_LABEL[o.type]}</span>
        <input type="range" className="sidebar-range" min="0" max="1" step="0.05" value={o.opacity} aria-label={`Opacity of ${o.name}`}
          onChange={e => update({ opacity: parseFloat(e.target.value) })} />
        <span className="slider-value">{Math.round(o.opacity * 100)}%</span>
      </div>
      {open && (
        <div className="ov-style">
          {state.splitScreen && (
            <div className="toggle-row">
              <span className="row-label">Show on</span>
              <select className="sidebar-select" style={{ width: 'auto', fontSize: '0.76em' }} value={o.side ?? 'both'}
                onChange={e => update({ side: e.target.value as 'left' | 'right' | 'both' })}>
                <option value="both">Both sides</option>
                <option value="left">Left only</option>
                <option value="right">Right only</option>
              </select>
            </div>
          )}
          {o.serviceKey === 'soils' && (
            <>
              <div className="toggle-row" style={{ gap: 6 }}>
                <span className="row-label">Colour by</span>
                <select className="sidebar-select" style={{ width: 'auto', minWidth: 0, flex: 1, fontSize: '0.76em' }} aria-label="Colour soils by"
                  value={o.soilField ?? 'class'}
                  onChange={e => update({ soilField: e.target.value, ...soilColoring(o.data?.features as never ?? [], e.target.value as SoilField, o.maxClasses ?? 6) })}>
                  {SOIL_FIELDS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
              </div>
              {(o.soilField ?? 'class') !== 'class' && (
                <div className="slider-group">
                  <div className="slider-label"><span>Classes</span><span className="slider-value">{o.maxClasses ?? 6}</span></div>
                  <input type="range" className="sidebar-range" min="2" max={MAX_CLASSES} step="1" value={o.maxClasses ?? 6} aria-label="Number of classes"
                    onChange={e => { const n = Number(e.target.value); update({ maxClasses: n, ...soilColoring(o.data?.features as never ?? [], (o.soilField ?? 'class') as SoilField, n) }); }} />
                </div>
              )}
            </>
          )}
          {o.classColors && (
            <div className="ov-class-colors">
              {o.classColors.classes.map(([label, color], i) => (
                <label key={label} title={`Colour of ${label}`}>
                  <input type="color" value={color} onChange={e => {
                    const classes = o.classColors!.classes.map((c, k) => (k === i ? [c[0], e.target.value] : c) as [string, string]);
                    update({ classColors: { ...o.classColors!, classes }, legend: [...classes, ...(o.legend ?? []).slice(classes.length)] });
                  }} />
                  {label}
                </label>
              ))}
              {o.classColors.other !== undefined || o.soilField !== 'class' ? (
                <label title="Colour of everything else">
                  <input type="color" value={o.classColors.other ?? OTHER_COLOR} onChange={e => {
                    const legend = (o.legend ?? []).map((c, k, all) => (k === all.length - 1 && all.length > o.classColors!.classes.length ? [c[0], e.target.value] : c) as [string, string]);
                    update({ classColors: { ...o.classColors!, other: e.target.value }, legend });
                  }} />
                  {o.legend?.[o.classColors.classes.length]?.[0] ?? 'Other'}
                </label>
              ) : null}
            </div>
          )}
          {o.pmtilesKind && (
            <div className="row-label" style={{ fontSize: '0.7em', wordBreak: 'break-all' }}>
              {o.pmtilesKind === 'vector' ? `Vector: ${(o.sourceLayers ?? []).join(', ') || 'no layers listed'}` : 'Raster'} · {o.url}
            </div>
          )}
          {(o.type === 'vector' || o.pmtilesKind === 'vector') && !o.classColors && (
            <>
              <div className="toggle-row">
                <span className="row-label">Color</span>
                <input type="color" className="ov-color" value={o.color ?? '#5bc0be'} aria-label="Layer color" onChange={e => update({ color: e.target.value })} />
              </div>
              <div className="slider-group">
                <div className="slider-label"><span>Line width</span><span className="slider-value">{o.lineWidth ?? 2} px</span></div>
                <input type="range" className="sidebar-range" min="0.5" max="10" step="0.5" value={o.lineWidth ?? 2}
                  onChange={e => update({ lineWidth: parseFloat(e.target.value) })} />
              </div>
              <div className="toggle-row" style={{ gap: 6 }}>
                <span className="row-label">Marker</span>
                <select className="sidebar-select" style={{ width: 'auto', fontSize: '0.76em' }} aria-label="Marker shape" value={o.marker ?? 'circle'}
                  onChange={e => update({ marker: e.target.value as PointMarker })}>
                  {POINT_MARKERS.map(m => <option key={m} value={m}>{MARKER_LABEL[m]}</option>)}
                </select>
              </div>
              <div className="slider-group">
                <div className="slider-label"><span>Point size</span><span className="slider-value">{o.pointRadius ?? 5} px</span></div>
                <input type="range" className="sidebar-range" min="1" max="20" step="1" value={o.pointRadius ?? 5}
                  onChange={e => update({ pointRadius: parseFloat(e.target.value) })} />
              </div>
              {o.data && <div className="row-label">{o.data.features.length} features</div>}
            </>
          )}
          {o.type === 'context' && (
            <>
              <div className="toggle-row">
                <span className="row-label">{o.contextKey === 'roads' && !o.color ? 'Color (by road class)' : 'Color'}</span>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  {o.contextKey === 'roads' && o.color && (
                    <button type="button" className="hist-btn" style={{ flex: 'none' }} onClick={() => update({ color: '' })}>By class</button>
                  )}
                  <input type="color" className="ov-color" value={o.color || '#fde68a'} aria-label="Layer color" onChange={e => update({ color: e.target.value })} />
                </div>
              </div>
              <div className="slider-group">
                <div className="slider-label">
                  <span>{o.contextKey === 'buildings' ? 'Height' : 'Line width'}</span>
                  <span className="slider-value">×{(o.scale ?? 1).toFixed(2)}</span>
                </div>
                <input type="range" className="sidebar-range" min={o.contextKey === 'buildings' ? 0.2 : 0.25} max={o.contextKey === 'buildings' ? 5 : 6} step="0.05"
                  value={o.scale ?? 1} onChange={e => update({ scale: parseFloat(e.target.value) })} />
              </div>
              <div className="row-label" style={{ fontSize: '0.7em' }}>© OpenStreetMap contributors, via OpenFreeMap</div>
            </>
          )}
          {o.legend && !o.classColors && (
            <div className="ov-legend">
              {o.legend.map(([label, color]) => (
                <span key={label}><i style={{ background: color }} />{label}</span>
              ))}
            </div>
          )}
          {o.attribution && <div className="row-label" style={{ fontSize: '0.7em' }}>{o.attribution}</div>}
          {(o.type === 'wms' || o.type === 'wmts') && !o.landCoverYear && (
            <>
              <div style={{ fontSize: '0.7em', color: 'var(--sb-muted)', wordBreak: 'break-all' }}>{o.url}</div>
              <div className="toggle-row">
                <span className="row-label" title="Highest zoom the service has tiles for; above it, tiles are upsampled instead of disappearing">Max native zoom</span>
                <input className="sidebar-input" type="number" min={1} max={24} style={{ width: 56, fontSize: '0.76em' }}
                  value={o.maxNativeZoom ?? 18}
                  onChange={e => update({ maxNativeZoom: Math.max(1, Math.min(24, parseInt(e.target.value) || 18)) })} />
              </div>
            </>
          )}
          {o.type === 'geotiff' && ((o.bandCount ?? 1) >= 3 ? (
            <div className="row-label">RGB ({o.bandCount}-band)</div>
          ) : (
            <>
              <div className="toggle-row">
                <span className="row-label">Discrete classes</span>
                <Switch checked={!!o.discrete} label="Discrete classes" onChange={() => update({ discrete: !o.discrete })} />
              </div>
              {!o.discrete && (
                <ColorScalePicker colormap={o.cmap ?? 'viridis'} vmin={o.vmin ?? 0} vmax={o.vmax ?? 1}
                  stats={async () => o.bands?.[0] ?? null}
                  onColormap={cmap => update({ cmap })}
                  onRange={(vmin, vmax) => update({ vmin, vmax })} />
              )}
              {o.discrete && (
                <div style={{ display: 'flex', gap: 4 }}>
                  <div className="minmax-field" style={{ flex: 1 }}>
                    <label className="minmax-label">Min</label>
                    <input className="sidebar-input" type="number" value={o.vmin} onChange={e => update({ vmin: parseFloat(e.target.value) })} />
                  </div>
                  <div className="minmax-field" style={{ flex: 1 }}>
                    <label className="minmax-label">Max</label>
                    <input className="sidebar-input" type="number" value={o.vmax} onChange={e => update({ vmax: parseFloat(e.target.value) })} />
                  </div>
                  <div className="minmax-field" style={{ width: 60 }}>
                    <label className="minmax-label">Classes</label>
                    <input className="sidebar-input" type="number" min={2} max={12} value={o.nbins ?? 5}
                      onChange={e => { const n = Math.max(2, Math.min(12, parseInt(e.target.value) || 2)); update({ nbins: n, binColors: binColorsFor(n, o.binColors) }); }} />
                  </div>
                </div>
              )}
              {o.discrete && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {(o.binColors ?? []).map((c, k) => {
                    const vmin = o.vmin ?? 0, vmax = o.vmax ?? 1, nb = o.nbins ?? 1;
                    const step = (vmax - vmin) / nb;
                    const lo = vmin + k * step, hi = vmin + (k + 1) * step;
                    return (
                      <div key={k} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }} title={`${lo.toPrecision(3)} – ${hi.toPrecision(3)}`}>
                        <input type="color" value={c} style={{ width: 26, height: 18, padding: 0, border: '1px solid var(--sb-border)', borderRadius: 3, background: 'none', cursor: 'pointer' }}
                          onChange={e => { const colors = [...(o.binColors ?? [])]; colors[k] = e.target.value; update({ binColors: colors }); }} />
                        <span style={{ fontSize: '0.6em', color: 'var(--sb-muted)' }}>{hi.toPrecision(3)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ))}
        </div>
      )}
    </div>
  );
}
