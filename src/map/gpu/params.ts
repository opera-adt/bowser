/**
 * What the GPU draws, taken from the very query the tile path would send
 * (``buildTileRequest``), so both renderers read the same state the same way. A query
 * the GPU path can't draw yet gives a reason, and the map draws server tiles instead.
 *
 * ``displayedValue`` and ``colormapIndex`` are the shader's per-pixel maths in JS: the
 * specification its unit tests pin (layer.ts's fragment shader follows them).
 */

export interface GpuMask { dataset: string; threshold: number; mode: 'min' | 'max' }

export interface GpuParams {
  variable: string;
  timeIdx: number;
  /** Shown relative to this step (value(t) - value(t_ref)), or null. */
  refTimeIdx: number | null;
  /** The spatial reference point's value, subtracted after the reference date. */
  shift: number;
  vmin: number;
  vmax: number;
  colormap: string;
  mask: GpuMask | null;
}

/**
 * ``ok``: draw these. Otherwise the reason, and ``wait`` when the state is not complete
 * yet (no dataset, no colour range): the GPU path then draws nothing for a moment
 * rather than switching to tiles and back.
 */
export type ParamsResult = { ok: true; params: GpuParams } | { ok: false; reason: string; wait?: boolean };

/**
 * GpuParams from the tile query parameters, or why the GPU path can't draw them yet
 * (those cases stay on server tiles).
 */
export function gpuParamsFromTileQuery(params: Record<string, string>, dataMode: string | null): ParamsResult {
  if (!dataMode) return { ok: false, reason: 'no data mode yet', wait: true };
  if (dataMode !== 'md') return { ok: false, reason: 'COG mode (not a zarr cube)' };
  if (params.algorithm && params.algorithm !== 'shift') return { ok: false, reason: `algorithm "${params.algorithm}" (rewrap, phase or amplitude) not on the GPU path yet` };
  if (params.custom_mask_path) return { ok: false, reason: 'uploaded custom mask not on the GPU path yet' };
  const [vmin, vmax] = (params.rescale ?? '').split(',').map(Number);
  if (!Number.isFinite(vmin) || !Number.isFinite(vmax)) return { ok: false, reason: 'no rescale range' };
  if (!(vmax > vmin)) return { ok: false, reason: 'no colour range yet (vmin >= vmax)', wait: true };
  let shift = 0;
  if (params.algorithm_params) {
    const ap = JSON.parse(params.algorithm_params) as Record<string, number>;
    if (ap.wrap_range !== undefined) return { ok: false, reason: 'rewrap not on the GPU path yet' };
    // As the tiler's Shift(nan_to_zero=True).
    shift = Number.isFinite(ap.shift) ? ap.shift : 0;
  }
  let mask: GpuMask | null = null;
  if (params.layer_masks) {
    const masks = JSON.parse(params.layer_masks) as { dataset: string; threshold?: number; mode?: string }[];
    if (masks.length > 1) return { ok: false, reason: 'more than one layer mask not on the GPU path yet' };
    if (masks.length === 1) {
      const m = masks[0];
      mask = { dataset: m.dataset, threshold: Number(m.threshold ?? 0.5), mode: m.mode === 'max' ? 'max' : 'min' };
    }
  }
  return {
    ok: true,
    params: {
      variable: params.variable,
      timeIdx: Number(params.time_idx ?? 0),
      refTimeIdx: params.ref_time_idx !== undefined ? Number(params.ref_time_idx) : null,
      shift,
      vmin,
      vmax,
      colormap: params.colormap_name,
      mask,
    },
  };
}

/**
 * The displayed value of one pixel, as the shader computes it (float32 steps):
 * value(t) - value(t_ref), masked, minus the reference-point shift. NaN = transparent.
 */
export function displayedValue(
  value: number, refValue: number | null, shift: number,
  mask: { value: number; threshold: number; mode: 'min' | 'max' } | null = null,
): number {
  const f = Math.fround;
  let v = f(value);
  if (refValue !== null) v = f(v - f(refValue));
  if (Number.isNaN(v)) return NaN;
  if (mask) {
    const m = f(mask.value);
    const keep = mask.mode === 'max' ? m <= f(mask.threshold) : m >= f(mask.threshold);
    if (!keep) return NaN;
  }
  return f(v - f(shift));
}

/**
 * Colormap index 0..255 for a displayed value, as rio-tiler's ``linear_rescale`` then
 * the uint8 cast (truncation); null for NaN (alpha 0).
 */
export function colormapIndex(v: number, vmin: number, vmax: number): number | null {
  if (Number.isNaN(v)) return null;
  const t = (Math.min(Math.max(v, vmin), vmax) - vmin) / (vmax - vmin);
  return Math.min(255, Math.max(0, Math.floor(t * 255)));
}
