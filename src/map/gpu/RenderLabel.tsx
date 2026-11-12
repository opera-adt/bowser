import { statsText, type GpuRenderStatus } from './useGpuRender';

/**
 * The small diagnostic label (with diagnostics on: Project tab or ``?debug=1``): which renderer draws the data, and why;
 * for the GPU, its texture memory (``data-gpu-stats`` holds the numbers as JSON).
 */
export function RenderLabel({ status }: { status: GpuRenderStatus }) {
  if (!status.showLabel) return null;
  return (
    <div data-testid="render-label" data-renderer={status.renderer} title={status.reason}
      data-gpu-stats={status.stats ? JSON.stringify(status.stats) : undefined} style={{
      position: 'absolute', bottom: 28, left: '50%', transform: 'translateX(-50%)', zIndex: 3000,
      background: 'rgba(0,0,0,0.55)', color: '#fff', borderRadius: 4, padding: '2px 8px',
      fontSize: '0.68em', pointerEvents: 'none', whiteSpace: 'nowrap', maxWidth: '60%', overflow: 'hidden',
      textOverflow: 'ellipsis',
    }}>
      {status.renderer === 'gpu' ? 'GPU render' : 'Server tiles'} · {status.reason}
      {status.stats ? ` · ${statsText(status.stats)}` : ''}
    </div>
  );
}
