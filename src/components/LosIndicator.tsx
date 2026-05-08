import { useMemo, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { useDraggableResizable } from '../hooks/useDraggableResizable';
import { LosMetadata } from '../types';
import { downloadElementAsPng } from '../utils/screenshot';

type Direction = 'ascending' | 'descending';
type Looking = 'right' | 'left';

const DEG = Math.PI / 180;

const LOOK_COLOR = '#2E7FE8';   // blue — satellite look arrow + label
const FLIGHT_COLOR = '#F39C12'; // orange — flight direction arrow + label

// Canonical Sentinel-1 look vectors used only when the user picks manual mode.
// Kept for right/left-looking asc/desc; not used as a silent fallback.
const ENU_ASC = { east: -0.615, north: -0.117 };
const ENU_DESC = { east: 0.615, north: -0.117 };

interface Geometry {
  /** Flight bearing, deg clockwise from north */
  heading: number;
  /** Look bearing (satellite -> ground, ground-projected), deg clockwise from north */
  look: number;
  /** Center-swath incidence angle. */
  incidence: number;
  /** Near-range incidence. Optional — absent for the legacy scalar schema. */
  incidenceNear?: number;
  /** Far-range incidence. */
  incidenceFar?: number;
  direction: Direction;
  looking: Looking;
}

function bearing(east: number, north: number): number {
  return ((Math.atan2(east, north) / DEG) + 360) % 360;
}

function deriveDirection(heading: number): Direction {
  return Math.cos(heading * DEG) > 0 ? 'ascending' : 'descending';
}

function deriveLooking(heading: number, lookEast: number, lookNorth: number): Looking {
  const fE = Math.sin(heading * DEG);
  const fN = Math.cos(heading * DEG);
  const cross = fE * lookNorth - fN * lookEast;
  return cross > 0 ? 'left' : 'right';
}

function geometryFromMetadata(m: LosMetadata): Geometry {
  const heading = m.heading_deg;
  const direction = deriveDirection(heading);
  // ENU is required to say anything about the look vector; without it we refuse
  // to guess (prior behavior silently assumed right-looking).
  const los = m.los_enu_ground_to_sat;
  if (!los) {
    throw new Error('LosMetadata without los_enu_ground_to_sat is unsupported');
  }
  const lookE = -los.east;
  const lookN = -los.north;
  return {
    heading,
    incidence: m.incidence_deg,
    incidenceNear: m.incidence_deg_near,
    incidenceFar: m.incidence_deg_far,
    direction,
    look: bearing(lookE, lookN),
    looking: deriveLooking(heading, lookE, lookN),
  };
}

function geometryFromManual(direction: Direction, looking: Looking, incidence: number): Geometry {
  const base = direction === 'ascending' ? ENU_ASC : ENU_DESC;
  const east = looking === 'right' ? base.east : -base.east;
  const look = bearing(-east, -base.north);
  const heading = (look + (looking === 'right' ? -90 : 90) + 360) % 360;
  return { heading, look, incidence, direction, looking };
}

/** Satellite glyph: body + two solar panels. Points "up" (north) at rotation=0. */
function SatelliteGlyph({
  cx, cy, scale = 1, rotation = 0, color = 'currentColor',
}: { cx: number; cy: number; scale?: number; rotation?: number; color?: string }) {
  const bodyW = 5 * scale;
  const bodyH = 8 * scale;
  const panelW = 6 * scale;
  const panelH = 3 * scale;
  const gap = 0.5 * scale;
  return (
    <g transform={`translate(${cx} ${cy}) rotate(${rotation})`}>
      <rect x={-bodyW / 2 - panelW - gap} y={-panelH / 2} width={panelW} height={panelH}
        fill={color} stroke={color} strokeWidth={0.3} />
      <rect x={bodyW / 2 + gap} y={-panelH / 2} width={panelW} height={panelH}
        fill={color} stroke={color} strokeWidth={0.3} />
      <line x1={-bodyW / 2 - panelW / 2 - gap} y1={-panelH / 2}
        x2={-bodyW / 2 - panelW / 2 - gap} y2={panelH / 2}
        stroke="white" strokeWidth={0.5} />
      <line x1={bodyW / 2 + panelW / 2 + gap} y1={-panelH / 2}
        x2={bodyW / 2 + panelW / 2 + gap} y2={panelH / 2}
        stroke="white" strokeWidth={0.5} />
      <rect x={-bodyW / 2} y={-bodyH / 2} width={bodyW} height={bodyH} fill={color} />
    </g>
  );
}

/** Flight-direction compass: bearing ticks, satellite, flight + look arrows. */
function FlightCompass({ geom }: { geom: Geometry }) {
  const size = 110;
  const cx = size / 2;
  const cy = size / 2;
  const r = 36;
  const arrowLen = r * 0.82;
  // Look arrow tip
  const lookX = cx + arrowLen * Math.sin(geom.look * DEG);
  const lookY = cy - arrowLen * Math.cos(geom.look * DEG);
  // Flight arrow tip
  const flightX = cx + arrowLen * Math.sin(geom.heading * DEG);
  const flightY = cy - arrowLen * Math.cos(geom.heading * DEG);

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <defs>
        <marker id="losArrowLook" viewBox="0 0 10 10" refX="8" refY="5"
          markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill={LOOK_COLOR} />
        </marker>
        <marker id="losArrowFlight" viewBox="0 0 10 10" refX="8" refY="5"
          markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill={FLIGHT_COLOR} />
        </marker>
      </defs>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="currentColor" strokeWidth={1.2} />
      <line x1={cx} y1={cy - r} x2={cx} y2={cy - r + 4} stroke="currentColor" strokeWidth={1} />
      <line x1={cx} y1={cy + r} x2={cx} y2={cy + r - 4} stroke="currentColor" strokeWidth={1} />
      <line x1={cx - r} y1={cy} x2={cx - r + 4} y2={cy} stroke="currentColor" strokeWidth={1} />
      <line x1={cx + r} y1={cy} x2={cx + r - 4} y2={cy} stroke="currentColor" strokeWidth={1} />
      <text x={cx} y={cy - r - 3} textAnchor="middle" fontSize={8} fill="currentColor">0</text>
      <text x={cx + r + 3} y={cy + 3} textAnchor="start" fontSize={8} fill="currentColor">90</text>
      <text x={cx} y={cy + r + 9} textAnchor="middle" fontSize={8} fill="currentColor">180</text>
      <text x={cx - r - 3} y={cy + 3} textAnchor="end" fontSize={8} fill="currentColor">270</text>
      {/* Flight arrow drawn under the satellite so the body covers the tail. */}
      <line x1={cx} y1={cy} x2={flightX} y2={flightY}
        stroke={FLIGHT_COLOR} strokeWidth={1.8} markerEnd="url(#losArrowFlight)" />
      <SatelliteGlyph cx={cx} cy={cy} scale={1.1} rotation={geom.heading} />
      <line x1={cx} y1={cy} x2={lookX} y2={lookY}
        stroke={LOOK_COLOR} strokeWidth={1.8} markerEnd="url(#losArrowLook)" />
    </svg>
  );
}

/**
 * Side-view incidence diagram. Draws the swath (near + far slants) when the
 * metadata carries near/far incidence values; falls back to the single center
 * slant otherwise.
 *
 * The incidence-angle arc is drawn at the *ground* end of the center slant —
 * geometrically, incidence is the angle at the target between local vertical
 * and the line back to the satellite. Under a flat-earth assumption this
 * equals the look angle at the sensor, which is what we draw with.
 */
function SideView({ geom, showPolarity }: { geom: Geometry; showPolarity: boolean }) {
  const w = 150;
  const h = 100;
  const satX = w / 2;
  const groundY = h - 18;
  // Shrink altitude when incidence is steep so the ground tip always leaves
  // room for the arc label near the viewBox edge. Under a flat-earth diagram
  // the horizontal reach is H·tan(inc) — cap it to keep the label readable.
  // The satellite visually sits lower for grazing angles, which matches the
  // physical intuition too.
  const reachBudget = w / 2 - 18;
  const maxInc = Math.max(geom.incidence, geom.incidenceFar ?? 0);
  const H = Math.min(60, reachBudget / Math.tan(maxInc * DEG));
  const satY = groundY - H;
  // Side the look points to: +1 = east half of compass, -1 = west half.
  const sign = Math.sin(geom.look * DEG) >= 0 ? 1 : -1;

  const tipFor = (incDeg: number) => satX + sign * H * Math.tan(incDeg * DEG);
  const centerTipX = tipFor(geom.incidence);
  const nearTipX = geom.incidenceNear !== undefined ? tipFor(geom.incidenceNear) : null;
  const farTipX = geom.incidenceFar !== undefined ? tipFor(geom.incidenceFar) : null;

  const extentX = Math.max(
    Math.abs(centerTipX - satX),
    nearTipX !== null ? Math.abs(nearTipX - satX) : 0,
    farTipX !== null ? Math.abs(farTipX - satX) : 0,
  );
  const gHalf = Math.max(40, extentX + 18);
  const gLeft = satX - gHalf;
  const gRight = satX + gHalf;

  // Incidence arc at the ground end of the center slant.
  // Local vertical at ground = "up" in SVG (math angle 90° → -y). The slant
  // back to the satellite sits at math angle 90° + sign*incidence.
  const arcR = 12;
  const inc = geom.incidence;
  const arcStart = 90 * DEG;                         // local up
  const arcEnd = (90 + sign * inc) * DEG;            // toward satellite
  const gax1 = centerTipX + arcR * Math.cos(arcStart);
  const gay1 = groundY - arcR * Math.sin(arcStart);
  const gax2 = centerTipX + arcR * Math.cos(arcEnd);
  const gay2 = groundY - arcR * Math.sin(arcEnd);
  // Sweep picks the short arc that stays *inside* the angle (between local up
  // and the slant). In SVG user units (y-down): sign=+1 → tip right of sat →
  // toward-sat is at ~10 o'clock of tip → CCW short arc → sweep=0.
  // sign=-1 → toward-sat at ~2 o'clock → CW short arc → sweep=1.
  const sweep = sign > 0 ? 0 : 1;
  const arcPath = `M ${gax1} ${gay1} A ${arcR} ${arcR} 0 0 ${sweep} ${gax2} ${gay2}`;
  const midA = (90 + sign * inc / 2) * DEG;
  const labR = arcR + 7;
  const labX = centerTipX + labR * Math.cos(midA);
  const labY = groundY - labR * Math.sin(midA) + 3;

  // Keep the in-SVG arc label compact (center value only). The swath range
  // goes in the caption below the icon.
  const incLabel = `${Math.round(inc)}°`;

  // +/- along the center slant: + near satellite (toward), − near ground (away).
  const slantDx = centerTipX - satX;
  const slantDy = groundY - satY;
  const slantLen = Math.hypot(slantDx, slantDy);
  const nx = -slantDy / slantLen;
  const ny = slantDx / slantLen;
  const off = 8;
  const plusX = satX + 0.3 * slantDx + sign * off * nx;
  const plusY = satY + 0.3 * slantDy + sign * off * ny;
  const minusX = satX + 0.75 * slantDx + sign * off * nx;
  const minusY = satY + 0.75 * slantDy + sign * off * ny;

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      {/* ground */}
      <line x1={gLeft} y1={groundY} x2={gRight} y2={groundY}
        stroke="currentColor" strokeWidth={1.2} />
      {/* nadir dashed */}
      <line x1={satX} y1={satY} x2={satX} y2={groundY}
        stroke="currentColor" strokeWidth={0.8} strokeDasharray="2 2" />
      {/* swath edges (lighter) */}
      {nearTipX !== null && (
        <line x1={satX} y1={satY} x2={nearTipX} y2={groundY}
          stroke={LOOK_COLOR} strokeOpacity={0.55} strokeWidth={1} />
      )}
      {farTipX !== null && (
        <line x1={satX} y1={satY} x2={farTipX} y2={groundY}
          stroke={LOOK_COLOR} strokeOpacity={0.55} strokeWidth={1} />
      )}
      {/* center slant */}
      <line x1={satX} y1={satY} x2={centerTipX} y2={groundY}
        stroke={LOOK_COLOR} strokeWidth={1.4} />
      {/* satellite */}
      <SatelliteGlyph cx={satX} cy={satY} scale={1.2} rotation={90} />
      {/* incidence arc at ground + label */}
      <path d={arcPath} fill="none" stroke="currentColor" strokeWidth={0.8} />
      <text x={labX} y={labY} textAnchor="middle" fontSize={9} fill="currentColor">
        {incLabel}
      </text>
      {showPolarity && (
        <>
          <text x={plusX} y={plusY} textAnchor="middle" fontSize={11}
            fontWeight="bold" fill={LOOK_COLOR}>+</text>
          <text x={minusX} y={minusY} textAnchor="middle" fontSize={11}
            fontWeight="bold" fill={LOOK_COLOR}>−</text>
        </>
      )}
    </svg>
  );
}

export default function LosIndicator() {
  const { state, dispatch } = useAppContext();
  const [manualOn, setManualOn] = useState(false);
  const [direction, setDirection] = useState<Direction>('ascending');
  const [looking, setLooking] = useState<Looking>('right');
  const [incidence, setIncidence] = useState(37);
  const [fontColor, setFontColor] = useState<'white' | 'black'>('white');

  const { panelRef, panelStyle, onDragMouseDown, resizeGrip } = useDraggableResizable({
    defaultWidth: 280,
    defaultHeight: 210,
    initialRight: 400,
    initialBottom: 40,
    minWidth: 240,
    minHeight: 180,
  });

  const dsInfo = state.currentDataset ? state.datasetInfo[state.currentDataset] : undefined;
  const meta = dsInfo?.los_metadata;

  const geom = useMemo<Geometry | null>(() => {
    if (meta) return geometryFromMetadata(meta);
    if (manualOn) return geometryFromManual(direction, looking, incidence);
    return null;
  }, [meta, manualOn, direction, looking, incidence]);

  // Polarity annotation only makes sense for signed LOS data (displacement,
  // velocity). Coherence/amplitude have no toward/away meaning.
  const showPolarity = !!dsInfo?.uses_spatial_ref;

  if (!state.showLosIndicator) return null;

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
        color: 'var(--sb-text)',
      }}
      onMouseDown={e => e.stopPropagation()}
    >
      <div
        data-screenshot-skip
        onMouseDown={onDragMouseDown}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '4px 8px', height: 26, cursor: 'grab',
          borderBottom: '1px solid var(--sb-border)', boxSizing: 'border-box',
        }}
      >
        <span style={{ fontSize: '0.72em', color: 'var(--sb-muted)' }}>LOS geometry</span>
        <div style={{ display: 'flex', gap: 2 }}>
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
            onClick={() => panelRef.current && downloadElementAsPng(panelRef.current, `los-geometry-${Date.now()}.png`, { skipSelector: '[data-screenshot-skip]', fontColor })}
            title="Save as PNG (transparent background)"
            style={{ background: 'none', border: 'none', color: 'var(--sb-muted)', cursor: 'pointer', padding: '1px 5px', fontSize: '0.85em' }}
          ><i className="fa-solid fa-camera"></i></button>
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={() => dispatch({ type: 'TOGGLE_LOS_INDICATOR' })}
            title="Close"
            style={{ background: 'none', border: 'none', color: 'var(--sb-muted)', cursor: 'pointer', padding: '1px 5px', fontSize: '0.85em' }}
          >✕</button>
        </div>
      </div>

      <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {geom ? (
          <>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-around', alignItems: 'center' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <FlightCompass geom={geom} />
                <div style={{ fontSize: '0.7em', marginTop: 2 }}>
                  <span style={{ color: LOOK_COLOR }}>Look</span>
                  <span style={{ color: 'var(--sb-muted)' }}> {geom.look.toFixed(1)}°</span>
                  <span style={{ color: 'var(--sb-muted)' }}> · </span>
                  <span style={{ color: FLIGHT_COLOR }}>Flight</span>
                  <span style={{ color: 'var(--sb-muted)' }}> {geom.heading.toFixed(1)}°</span>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <SideView geom={geom} showPolarity={showPolarity} />
                <div style={{ fontSize: '0.7em', color: 'var(--sb-muted)', marginTop: 2 }}>
                  Incidence {(geom.incidenceNear !== undefined && geom.incidenceFar !== undefined)
                    ? `${geom.incidenceNear.toFixed(1)}°–${geom.incidenceFar.toFixed(1)}°`
                    : `${geom.incidence.toFixed(1)}°`}
                </div>
              </div>
            </div>
            <div style={{
              fontSize: '0.72em', textAlign: 'center',
              borderTop: '1px solid var(--sb-border)', paddingTop: 4,
              textTransform: 'capitalize',
            }}>
              {geom.direction} · {geom.looking}-looking
            </div>
          </>
        ) : (
          <div style={{ textAlign: 'center', padding: '8px 4px' }}>
            <div style={{ fontSize: '0.78em', color: 'var(--sb-muted)', marginBottom: 8 }}>
              No LOS metadata for this dataset.
            </div>
            <button
              className="toggle-pill"
              style={{ fontSize: '0.75em' }}
              onClick={() => setManualOn(true)}
            >Enter manually</button>
          </div>
        )}

        {manualOn && !meta && (
          <div style={{ borderTop: '1px solid var(--sb-border)', paddingTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                className={`toggle-pill${direction === 'ascending' ? ' active' : ''}`}
                style={{ flex: 1, justifyContent: 'center', fontSize: '0.75em' }}
                onClick={() => setDirection('ascending')}
              >Ascending</button>
              <button
                className={`toggle-pill${direction === 'descending' ? ' active' : ''}`}
                style={{ flex: 1, justifyContent: 'center', fontSize: '0.75em' }}
                onClick={() => setDirection('descending')}
              >Descending</button>
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                className={`toggle-pill${looking === 'right' ? ' active' : ''}`}
                style={{ flex: 1, justifyContent: 'center', fontSize: '0.75em' }}
                onClick={() => setLooking('right')}
              >Right-looking</button>
              <button
                className={`toggle-pill${looking === 'left' ? ' active' : ''}`}
                style={{ flex: 1, justifyContent: 'center', fontSize: '0.75em' }}
                onClick={() => setLooking('left')}
              >Left-looking</button>
            </div>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72em', color: 'var(--sb-muted)' }}>
                <span>Incidence</span><span>{incidence}°</span>
              </div>
              <input type="range" min={15} max={60} step={1} value={incidence}
                className="sidebar-range"
                onChange={e => setIncidence(parseInt(e.target.value))}
                onMouseDown={e => e.stopPropagation()} />
            </div>
          </div>
        )}
      </div>

      {resizeGrip}
    </div>
  );
}
