/**
 * Screenshot utilities — export panels/charts as transparent-background PNGs.
 *
 * Chart.js canvases are exported directly (fast, pixel-perfect).
 * All other HTML panels use html-to-image which captures the live DOM
 * including CSS transforms, variables, and images.
 */
import { toPng } from 'html-to-image';

function triggerDownload(dataUrl: string, filename: string) {
  const link = document.createElement('a');
  link.download = filename;
  link.href = dataUrl;
  link.click();
}

/** Export a Chart.js canvas as a transparent-background PNG. */
export function downloadChartAsPng(canvas: HTMLCanvasElement, filename: string): void {
  triggerDownload(canvas.toDataURL('image/png'), filename);
}

/**
 * Capture any HTML element exactly as rendered (CSS vars, transforms, images)
 * and download as a transparent-background PNG at 2× pixel ratio.
 *
 * Skips elements matching `skipSelector` (e.g. the drag-handle header with buttons).
 * Pass `fontColor` to render text as 'white' or 'black' instead of the current theme color.
 *
 * Why CSS-variable injection instead of style override:
 *   html-to-image bakes getComputedStyle() into every cloned element's cssText, resolving all
 *   CSS variables before the clone is built. The `style` option only patches the root element,
 *   so child elements keep their resolved dark-theme colors regardless.
 *   Setting CSS variables on the live element BEFORE calling toPng makes getComputedStyle()
 *   return the overridden values for all descendants. We hide the element to prevent a flash.
 */
export async function downloadElementAsPng(
  el: HTMLElement,
  filename: string,
  opts?: { skipSelector?: string; scale?: number; fontColor?: 'white' | 'black' },
): Promise<void> {
  const { skipSelector, scale = 2, fontColor } = opts ?? {};

  const filter = skipSelector
    ? (node: Node) => !(node instanceof Element && node.matches(skipSelector))
    : undefined;

  const { width, height } = el.getBoundingClientRect();

  // Override CSS variables on the live element so all descendants resolve them
  // to the capture values. --sb-border: transparent removes all panel borders.
  const overrideVars: [string, string][] = [
    ['--sb-surface',  'transparent'],
    ['--sb-surface2', 'transparent'],
    ['--sb-border',   'transparent'],
  ];
  if (fontColor === 'white') {
    overrideVars.push(['--sb-text', '#ffffff'], ['--sb-muted', 'rgba(255,255,255,0.6)']);
  } else if (fontColor === 'black') {
    overrideVars.push(['--sb-text', '#111111'], ['--sb-muted', 'rgba(0,0,0,0.55)']);
  }

  // Briefly make live element invisible (opacity, not visibility — visibility:hidden
  // is inherited so getComputedStyle bakes it into every child's cssText, blanking the PNG).
  const savedOpacity = el.style.opacity;
  el.style.opacity = '0';
  overrideVars.forEach(([k, v]) => el.style.setProperty(k, v));

  try {
    const dataUrl = await toPng(el, {
      backgroundColor: undefined,
      pixelRatio: scale,
      filter,
      skipAutoScale: false,
      skipFonts: true,
      width,
      height,
      style: {
        // position:fixed puts the element outside the SVG foreignObject capture area.
        position: 'relative', left: '0', top: '0', right: 'auto', bottom: 'auto',
        opacity: '1',            // restore in clone — live element is opacity:0 to prevent flash
        boxShadow: 'none',
        backdropFilter: 'none',  // html-to-image cannot render backdrop-filter
      },
    });
    triggerDownload(dataUrl, filename);
  } catch (err) {
    console.error('[screenshot] toPng failed:', err);
    alert(`Screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    overrideVars.forEach(([k]) => el.style.removeProperty(k));
    el.style.opacity = savedOpacity;
  }
}
