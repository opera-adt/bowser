/**
 * The GPU renderer's memory cap: uploaded chunk textures are kept up to a byte budget,
 * and above it the least useful ones are deleted first.
 *
 * Texture keys are ``level|variable|dateBlock|cy|cx|kind`` (see layer.ts). What the
 * current frame draws is never evicted. Of the rest, chunks at a position the view
 * doesn't show (panned away, another pyramid level) go first, then chunks at a shown
 * position but for other dates; within each group, the least recently used first.
 * Eviction stops at 80% of the budget, so it doesn't run again on the next upload.
 */

export interface BudgetEntry {
  state: string;
  bytes: number;
  lastUsed: number;
}

/** ``level|cy|cx`` of a texture key. */
export function positionOf(key: string): string {
  const [level, , , cy, cx] = key.split('|');
  return `${level}|${cy}|${cx}`;
}

/**
 * The keys to delete so the uploaded textures (``total`` bytes) fit ``budget``: only
 * ``ready`` entries, never one in ``keep``, those at positions outside ``inView``
 * first. Empty when ``total`` is within the budget.
 */
export function evictionPlan(
  entries: Iterable<[string, BudgetEntry]>, total: number, budget: number,
  keep: ReadonlySet<string>, inView: ReadonlySet<string>,
): string[] {
  if (total <= budget) return [];
  const target = budget * 0.8;
  const candidates = [...entries]
    .filter(([k, e]) => e.state === 'ready' && !keep.has(k))
    .map(([k, e]) => ({ k, e, away: inView.has(positionOf(k)) ? 1 : 0 }))
    .sort((a, b) => a.away - b.away || a.e.lastUsed - b.e.lastUsed);
  const out: string[] = [];
  for (const { k, e } of candidates) {
    if (total <= target) break;
    out.push(k);
    total -= e.bytes;
  }
  return out;
}

const MB = 1024 * 1024;
/** The budget when the browser doesn't say how much memory the device has. */
export const DEFAULT_BUDGET_MB = 384;
export const MIN_BUDGET_MB = 64;
export const MAX_BUDGET_MB = 2048;

/** Budget per GB of device memory, and its range. */
export const BUDGET_MB_PER_GB = 96;
export const DEVICE_BUDGET_MB = [128, 768] as const;

/**
 * Texture budget in bytes: ``override`` MB (``?gpu_mb=``) when given, else 96 MB per
 * GB of device memory (``navigator.deviceMemory``, which browsers cap at 8 GB) between
 * 128 and 768 MB, else 384 MB. Overrides are clamped to 64..2048 MB.
 *
 * 768 MB on an 8 GB device is what stage 1 kept as float32; as float16 it holds twice
 * the dates (all 269 dates of a 30 m frame at a 1100×800 view), so playing again or
 * going back draws from memory instead of decoding again.
 */
export function textureBudgetBytes(override: number | null, deviceMemoryGb: number | undefined): number {
  if (override !== null && Number.isFinite(override) && override > 0) {
    return Math.round(Math.min(MAX_BUDGET_MB, Math.max(MIN_BUDGET_MB, override)) * MB);
  }
  if (deviceMemoryGb && Number.isFinite(deviceMemoryGb) && deviceMemoryGb > 0) {
    return Math.min(DEVICE_BUDGET_MB[1], Math.max(DEVICE_BUDGET_MB[0], deviceMemoryGb * BUDGET_MB_PER_GB)) * MB;
  }
  return DEFAULT_BUDGET_MB * MB;
}

/** ``?gpu_mb=`` as a number, or null. */
export function parseBudgetOverride(search: string): number | null {
  const v = new URLSearchParams(search).get('gpu_mb');
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
