import { useState } from 'react';
import { useDebugMessages } from '../../utils/debug';
import { statsText, type GpuRenderStatus } from './useGpuRender';

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false });

/**
 * The small diagnostic label (with diagnostics on: Project tab or ``?debug=1``): which renderer draws the data, and why;
 * for the GPU, its texture memory (``data-gpu-stats`` holds the numbers as JSON). A click opens every diagnostic
 * message so far above it, in full (the label itself is one line, cut short).
 */
export function RenderLabel({ status }: { status: GpuRenderStatus }) {
  const [open, setOpen] = useState(false);
  const messages = useDebugMessages();
  if (!status.showLabel) return null;
  const line = `${status.renderer === 'gpu' ? 'GPU render' : 'Server tiles'} · ${status.reason}`
    + (status.stats ? ` · ${statsText(status.stats)}` : '');
  const box = { background: 'rgba(0,0,0,0.72)', color: '#fff', borderRadius: 4, fontSize: '0.68em' } as const;
  return (
    <div style={{
      position: 'absolute', bottom: 28, left: '50%', transform: 'translateX(-50%)', zIndex: 3000,
      maxWidth: '60%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, pointerEvents: 'none',
    }}>
      {open && (
        <div data-testid="render-messages" role="log" aria-label="Diagnostic messages" style={{
          ...box, padding: '6px 10px', maxHeight: 220, overflowY: 'auto', pointerEvents: 'auto',
          whiteSpace: 'normal', overflowWrap: 'anywhere', textAlign: 'left', width: '100%', boxSizing: 'border-box',
        }}>
          <div style={{ marginBottom: 4 }}>{line}</div>
          {messages.length === 0
            ? <div style={{ opacity: 0.8 }}>No messages yet.</div>
            : messages.map((m, i) => (
              <div key={i} style={m.warn ? { color: '#ffd27a' } : undefined}>
                <span style={{ opacity: 0.7 }}>{time(m.at)}</span> {m.text}
              </div>
            ))}
        </div>
      )}
      <button type="button" data-testid="render-label" data-renderer={status.renderer}
        data-gpu-stats={status.stats ? JSON.stringify(status.stats) : undefined}
        aria-expanded={open} onClick={() => setOpen(o => !o)}
        title={open ? 'Hide the diagnostic messages' : `${status.reason} (click for every diagnostic message)`}
        style={{
          ...box, background: 'rgba(0,0,0,0.55)', border: 'none', font: 'inherit', fontSize: '0.68em', padding: '2px 8px',
          cursor: 'pointer', pointerEvents: 'auto', whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
        {line}
      </button>
    </div>
  );
}
