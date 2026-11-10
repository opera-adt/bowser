import { useEffect, useRef, useState } from 'react';
import { clampTimeIndex, PLAY_SPEEDS, readPlaySpeed, savePlaySpeed } from '../../utils/timeStep';

/** Two clicks on the same arrow within this many milliseconds start playing. */
export const DOUBLE_CLICK_MS = 400;

type Direction = -1 | 0 | 1;

interface TimeStepperProps {
  value: number;
  count: number;
  onChange: (index: number) => void;
}

/**
 * The time step slider with ‹ and › beside it. A click steps one date; a second click on the same
 * arrow straight after plays in that direction until the last (or first) date. While playing,
 * that arrow stops and the other one turns round. Right-click either arrow for the speed.
 */
export default function TimeStepper({ value, count, onChange }: TimeStepperProps) {
  const [playing, setPlaying] = useState<Direction>(0);
  const [speed, setSpeed] = useState(readPlaySpeed);
  const [menu, setMenu] = useState(false);
  const lastClick = useRef<{ dir: Direction; at: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const i = clampTimeIndex(value, count);
  // The interval reads the latest step and callback without restarting on every step.
  const now = useRef({ i, onChange });
  now.current = { i, onChange };

  useEffect(() => {
    if (playing === 0) return;
    const id = setInterval(() => {
      const { i: cur, onChange: change } = now.current;
      const next = clampTimeIndex(cur + playing, count);
      if (next !== cur) {
        now.current.i = next;  // before the next render, should two ticks come first
        change(next);
      }
      // Stop at the end rather than wrapping round.
      if (clampTimeIndex(next + playing, count) === next) setPlaying(0);
    }, 1000 / speed);
    return () => clearInterval(id);
  }, [playing, speed, count]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setMenu(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menu]);

  const click = (dir: Direction) => {
    if (playing !== 0) {
      setPlaying(playing === dir ? 0 : dir);
      lastClick.current = null;
      return;
    }
    const at = Date.now();
    const again = lastClick.current?.dir === dir && at - lastClick.current.at < DOUBLE_CLICK_MS;
    lastClick.current = again ? null : { dir, at };
    if (again) setPlaying(dir);
    else onChange(clampTimeIndex(i + dir, count));
  };

  const arrow = (dir: Direction, label: string, glyph: string, atEnd: boolean) => (
    <button type="button" className={`date-badge-step time-step-btn${playing === dir ? ' playing' : ''}`}
      data-command={dir === 1 ? 'time.next' : 'time.previous'}
      aria-label={label} aria-pressed={playing === dir} disabled={atEnd && playing !== dir}
      title={playing === dir ? 'Stop playing' : `${label} (click twice to play, right-click for speed)`}
      onClick={() => click(dir)}
      onContextMenu={e => { e.preventDefault(); setMenu(m => !m); }}>
      {glyph}
    </button>
  );

  return (
    <div className="time-stepper" ref={rootRef}>
      <div className="time-step-row">
        {arrow(-1, 'Previous date', '‹', i === 0)}
        <input type="range" className="sidebar-range" aria-label="Time step"
          min="0" max={count - 1} step="1" value={i}
          onChange={e => { setPlaying(0); onChange(parseInt(e.target.value)); }} />
        {arrow(1, 'Next date', '›', i === count - 1)}
      </div>
      {menu && (
        <div className="cscale-pop time-speed-pop" role="group" aria-label="Play speed">
          <span className="row-label">Play speed (dates per second)</span>
          <div className="cscale-actions">
            {PLAY_SPEEDS.map(s => (
              <button key={s} type="button" className="hist-btn" aria-pressed={s === speed}
                onClick={() => { setSpeed(s); savePlaySpeed(s); setMenu(false); }}>{s}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
