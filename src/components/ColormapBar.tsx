import { useState, useRef, useEffect } from 'react';
import { useAppContext } from '../context/AppContext';
import { useDraggableResizable } from '../hooks/useDraggableResizable';
import { downloadElementAsPng } from '../utils/screenshot';

export default function ColormapBar() {
  const { state, dispatch } = useAppContext();
  const [horizontal, setHorizontal] = useState(false);
  const [barFrac, setBarFrac] = useState(0.4);
  const [showBarSlider, setShowBarSlider] = useState(false);
  const [customLabel, setCustomLabel] = useState<string | null>(null);
  const [customUnit, setCustomUnit] = useState<string | null>(null);
  const [fontColor, setFontColor] = useState<'white' | 'black'>('white');

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);

  const { panelRef, panelStyle, size, onDragMouseDown, resizeGrip } = useDraggableResizable({
    defaultWidth:  300,
    defaultHeight: 160,
    initialRight: 70,
    initialBottom: 40,
    minWidth: 100,
    minHeight: 80,
  });

  // Redraw the vertical colorbar on the canvas whenever colormap, orientation, or panel size changes.
  // Canvas approach: html-to-image captures canvas via toDataURL — no CSS-transform artifacts.
  // size.width/height in deps ensures the effect re-runs on first show when the panel has known dimensions.
  useEffect(() => {
    if (horizontal) return;
    const wrap = canvasWrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    let cancelled = false;
    const draw = () => {
      const cw = wrap.clientWidth;
      const ch = wrap.clientHeight;
      if (!cw || !ch) return;
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const img = new Image();
      img.onload = () => {
        if (cancelled || canvas.width !== cw || canvas.height !== ch) return;
        ctx.clearRect(0, 0, cw, ch);
        ctx.save();
        ctx.translate(cw / 2, ch / 2);
        ctx.rotate(-Math.PI / 2); // CCW: left→bottom, right→top (vmax at top)
        ctx.drawImage(img, -ch / 2, -cw / 2, ch, cw);
        ctx.restore();
      };
      img.src = `/colorbar/${state.colormap}`;
    };

    const raf = requestAnimationFrame(draw);
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => { cancelled = true; cancelAnimationFrame(raf); ro.disconnect(); };
  }, [state.colormap, horizontal, size.width, size.height, state.showColorbar]);

  if (!state.showColorbar) return null;

  const dsInfo = state.currentDataset ? state.datasetInfo[state.currentDataset] : null;
  const autoUnit  = dsInfo?.unit  ?? '';
  const unit = customUnit ?? autoUnit;
  const autoLabel = dsInfo?.label ?? state.currentDataset ?? '';
  const label = customLabel ?? autoLabel;

  const fmt = (v: number) => {
    const abs = Math.abs(v);
    if (abs === 0) return '0';
    if (abs >= 10000 || (abs < 0.01 && abs > 0)) return v.toExponential(2);
    return parseFloat(v.toPrecision(4)).toString();
  };

  const mid = (state.vmin + state.vmax) / 2;

  const HEADER_H = 26;

  // Adaptive padding: 2–6% of smaller dimension, clamped
  const PAD = Math.max(4, Math.min(10, Math.round(Math.min(size.width, size.height) * 0.04)));

  // Available body dimensions
  const bodyW = size.width  - PAD * 2;
  const bodyH = size.height - HEADER_H - PAD * 2;

  // Adaptive font size: scale with panel size
  const baseFontPx = Math.max(9, Math.min(14, Math.round(Math.min(bodyW, bodyH) * 0.09)));
  const numStyle: React.CSSProperties = {
    fontSize: baseFontPx,
    color: 'var(--sb-text)',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    flexShrink: 0,
    lineHeight: 1.3,
  };
  const midStyle: React.CSSProperties = {
    ...numStyle,
    fontSize: baseFontPx * 0.88,
  };
  const unitStyle: React.CSSProperties = {
    ...numStyle,
    fontSize: baseFontPx * 0.8,
    color: 'var(--sb-muted)',
  };

  // bar thickness as px derived from fraction and available space
  const barThickH = Math.max(8, Math.round(bodyH * barFrac));
  const barThickV = Math.max(8, Math.round(bodyW * barFrac));

  return (
    <div
      ref={panelRef}
      style={{
        ...panelStyle,
        position: 'fixed',
        background: 'var(--sb-surface)',
        border: '1px solid var(--sb-border)',
        borderRadius: 10,
        boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
        backdropFilter: 'blur(8px)',
        zIndex: 3200,
        display: 'flex',
        flexDirection: 'column',
        userSelect: 'none',
        minWidth: 100,
        minHeight: 80,
      }}
      onMouseDown={e => e.stopPropagation()}
    >
      {/* ── Header ── */}
      <div
        data-screenshot-skip
        onMouseDown={onDragMouseDown}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '4px 8px', height: HEADER_H, cursor: 'grab',
          borderBottom: '1px solid var(--sb-border)', flexShrink: 0, gap: 4,
          boxSizing: 'border-box',
        }}
      >
        <span style={{ flex: 1, minWidth: 0, fontSize: '0.7em', color: 'var(--sb-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          colorbar
        </span>
        <div style={{ display: 'flex', gap: 3, alignItems: 'center', flexShrink: 0 }}>
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={() => setHorizontal(h => !h)}
            title={horizontal ? 'Switch to vertical' : 'Switch to horizontal'}
            style={{ background: 'none', border: '1px solid var(--sb-border)', borderRadius: 4, color: 'var(--sb-text)', cursor: 'pointer', padding: '1px 6px', fontSize: '0.75em', lineHeight: 1.4 }}
          >
            {horizontal ? '⇕' : '⇔'}
          </button>
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={() => setFontColor(c => c === 'white' ? 'black' : 'white')}
            title={`Screenshot font: ${fontColor} — click to toggle`}
            style={{
              background: 'none', border: '1px solid var(--sb-border)', borderRadius: 3,
              cursor: 'pointer', padding: '0px 5px', fontSize: '0.75em', lineHeight: 1.5,
              color: fontColor === 'white' ? '#fff' : '#111',
              backgroundColor: fontColor === 'white' ? '#333' : '#ddd',
            }}
          >A</button>
          <button
            onMouseDown={e => e.stopPropagation()}
            title="Save as PNG (transparent background)"
            onClick={() => panelRef.current && downloadElementAsPng(
              panelRef.current,
              `colorbar-${state.colormap}-${Date.now()}.png`,
              { skipSelector: '[data-screenshot-skip]', fontColor },
            )}
            style={{ background: 'none', border: 'none', color: 'var(--sb-muted)', cursor: 'pointer', padding: '1px 5px', fontSize: '0.85em', lineHeight: 1 }}
          ><i className="fa-solid fa-camera"></i></button>
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={() => dispatch({ type: 'TOGGLE_COLORBAR' })}
            title="Close colorbar"
            style={{ background: 'none', border: 'none', color: 'var(--sb-muted)', cursor: 'pointer', padding: '1px 5px', fontSize: '0.85em', lineHeight: 1 }}
          >✕</button>
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ flex: 1, padding: PAD, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: PAD * 0.5, overflow: 'hidden' }}>

        {/* Editable label + unit row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <input
            value={label}
            onMouseDown={e => e.stopPropagation()}
            onChange={e => setCustomLabel(e.target.value)}
            onBlur={e => { if (!e.target.value.trim()) setCustomLabel(null); }}
            title="Click to edit label"
            style={{
              flex: 1, minWidth: 0, background: 'none', border: 'none', outline: 'none',
              fontSize: baseFontPx * 0.85, color: 'var(--sb-muted)', cursor: 'text',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          />
          <input
            value={unit}
            onMouseDown={e => e.stopPropagation()}
            onChange={e => setCustomUnit(e.target.value)}
            onBlur={e => { if (e.target.value === autoUnit) setCustomUnit(null); }}
            placeholder="unit"
            title="Click to edit unit"
            style={{
              width: 32, flexShrink: 0, background: 'none', border: 'none', outline: 'none',
              fontSize: baseFontPx * 0.85, color: 'var(--sb-muted)', cursor: 'text', textAlign: 'right',
            }}
          />
        </div>

        {horizontal ? (
          <>
            <img
              src={`/colorbar/${state.colormap}`}
              alt="colorbar"
              style={{
                width: '100%',
                height: barThickH,
                objectFit: 'fill',
                borderRadius: 3,
                imageRendering: 'pixelated',
                display: 'block',
                flexShrink: 0,
              }}
            />
            {/* Labels: vmin left | mid+unit stacked center | vmax right */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <span style={numStyle}>{fmt(state.vmin)}</span>
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                <span style={midStyle}>{fmt(mid)}</span>
                {unit && <span style={unitStyle}>{unit}</span>}
              </span>
              <span style={numStyle}>{fmt(state.vmax)}</span>
            </div>
            {/* Bar height slider — collapsible */}
            <div style={{ marginTop: 'auto', flexShrink: 0 }}>
              <button onMouseDown={e => e.stopPropagation()} onClick={() => setShowBarSlider(s => !s)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--sb-muted)', fontSize: baseFontPx * 0.8, display: 'flex', alignItems: 'center', gap: 3 }}>
                <i className={`fa-solid fa-chevron-${showBarSlider ? 'up' : 'down'}`} style={{ fontSize: '0.7em' }} />
                bar height
              </button>
              {showBarSlider && (
                <input type="range" min={0.1} max={0.9} step={0.02} value={barFrac}
                  style={{ width: '100%', marginTop: 2 }}
                  onMouseDown={e => e.stopPropagation()}
                  onChange={e => setBarFrac(Number(e.target.value))}
                />
              )}
            </div>
          </>
        ) : (
          <>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'row', gap: PAD, minHeight: 0 }}>
              {/* Wrapper controls size; canvas fills it and is drawn programmatically */}
              <div
                ref={canvasWrapRef}
                style={{ width: barThickV, flexShrink: 0, alignSelf: 'stretch',
                         borderRadius: 3, overflow: 'hidden', position: 'relative' }}
              >
                <canvas
                  ref={canvasRef}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                           imageRendering: 'pixelated' }}
                />
              </div>
              {/* Labels column: vmax top, mid rotated at center, unit (not rotated) at center right, vmin bottom */}
              <div style={{
                position: 'relative',
                alignSelf: 'stretch',
                minWidth: 0,
                flex: 1,
              }}>
                <span style={{ ...numStyle, position: 'absolute', top: 0, left: 0 }}>{fmt(state.vmax)}</span>
                {/* mid value: aligned with vmin/vmax, not rotated */}
                <span style={{
                  ...midStyle,
                  position: 'absolute', top: '50%', left: 0,
                  transform: 'translateY(-50%)',
                  whiteSpace: 'nowrap',
                }}>{fmt(mid)}</span>
                {/* unit: rotated -90deg, centered in the column */}
                {unit && <span style={{
                  ...unitStyle,
                  position: 'absolute', top: '50%', right: 0,
                  transform: 'translateY(-50%) rotate(-90deg)',
                  whiteSpace: 'nowrap',
                  display: 'inline-block',
                }}>{unit}</span>}
                <span style={{ ...numStyle, position: 'absolute', bottom: 0, left: 0 }}>{fmt(state.vmin)}</span>
              </div>
            </div>
            {/* Bar width slider — collapsible */}
            <div style={{ flexShrink: 0 }}>
              <button onMouseDown={e => e.stopPropagation()} onClick={() => setShowBarSlider(s => !s)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--sb-muted)', fontSize: baseFontPx * 0.8, display: 'flex', alignItems: 'center', gap: 3 }}>
                <i className={`fa-solid fa-chevron-${showBarSlider ? 'up' : 'down'}`} style={{ fontSize: '0.7em' }} />
                bar width
              </button>
              {showBarSlider && (
                <input type="range" min={0.1} max={0.9} step={0.02} value={barFrac}
                  style={{ width: '100%', marginTop: 2 }}
                  onMouseDown={e => e.stopPropagation()}
                  onChange={e => setBarFrac(Number(e.target.value))}
                />
              )}
            </div>
          </>
        )}
      </div>

      {resizeGrip}
    </div>
  );
}
