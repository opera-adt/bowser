/**
 * The 256-entry RGBA colormap tables the servers colour tiles with (rio-tiler's, via
 * bowser-lite's colormaps.npz; regenerate with scripts/build_gpu_colormaps.py), as the
 * bytes of a 256x1 RGBA8 texture.
 */
import luts from './colormapLuts.json';

const TABLES = luts as Record<string, string>;

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const cache = new Map<string, Uint8Array>();

/** The 1024 RGBA bytes of ``name`` (case-insensitive, ``_r`` allowed), or null. */
export function colormapTexture(name: string): Uint8Array | null {
  const key = name.toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;
  const b64 = TABLES[key];
  if (!b64) return null;
  const bytes = decodeBase64(b64);
  if (bytes.length !== 256 * 4) return null;
  cache.set(key, bytes);
  return bytes;
}

export function hasColormap(name: string): boolean {
  return TABLES[name.toLowerCase()] !== undefined;
}
