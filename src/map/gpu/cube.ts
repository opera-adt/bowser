/**
 * The GeoZarr cube as the GPU renderer reads it from the server's ``/zarr/`` route:
 * levels, grid, CRS, and one chunk at a time. ``GpuCube`` is the page's handle on it;
 * the reading and decoding (zarrita, the compressors, CF decoding as in cf.ts) happen
 * in the decoder workers (decoderPool.ts, zarrCube.ts), off the main thread.
 */
import type { ChunkResult, DecoderPool, OpenResult, StoreRef, VariableResult } from './decoderPool';
import type { LevelGrid } from './geometry';
import { utmZoneFromEpsg, type UtmZone } from './projection';
import { createDecoderPool } from './workerPool';

export interface ChunkData {
  /** [layers, rows, cols]: float32 (NaN for nodata), or float16 bits (``format: 'f16'``). */
  data: Float32Array | Uint16Array;
  format: 'f32' | 'f16';
  layers: number;
  /** Largest float16 rounding error over the chunk (0 for float32). */
  maxError: number;
}

export interface CubeVariable {
  ndim: number;
  /** Dates per chunk (1 for 2-D variables). */
  tChunk: number;
  nTime: number;
}

export class GpuCube {
  private constructor(
    private pool: DecoderPool, private store: StoreRef, readonly levels: LevelGrid[], readonly zone: UtmZone,
  ) {}

  /**
   * Open the store at ``url`` (``${origin}/zarr/``) and read its geometry from
   * ``probeVariable``, in a decoder worker. ``datasetId`` is the catalog entry
   * (``?dataset=``), or null. ``pool`` defaults to new decoder workers.
   */
  static async open(url: string, probeVariable: string, datasetId: string | null, pool?: DecoderPool): Promise<GpuCube> {
    const workers = pool ?? createDecoderPool();
    const store = { url, datasetId };
    try {
      const { levels, epsg } = await workers.request<OpenResult>({ op: 'open', store, probe: probeVariable });
      const zone = epsg !== null ? utmZoneFromEpsg(epsg) : null;
      if (!zone) throw new Error(`the GPU path draws UTM cubes only (EPSG ${epsg ?? 'unknown'})`);
      return new GpuCube(workers, store, levels, zone);
    } catch (e) {
      workers.close();
      throw e;
    }
  }

  variable(level: number, variable: string): Promise<CubeVariable> {
    return this.pool.request<VariableResult>({ op: 'variable', store: this.store, path: `${this.levels[level].prefix}${variable}` });
  }

  /**
   * Chunk (tb, cy, cx) of ``variable`` at ``level`` as [layers, rows, cols], float16
   * when ``half`` and the values allow it (half.ts), else float32.
   */
  async chunk(level: number, variable: string, tb: number, cy: number, cx: number, half = false): Promise<ChunkData> {
    const r = await this.pool.request<ChunkResult>({
      op: 'chunk', store: this.store, path: `${this.levels[level].prefix}${variable}`, coords: [tb, cy, cx], half,
    });
    return { data: r.format === 'f16' ? new Uint16Array(r.buffer) : new Float32Array(r.buffer), format: r.format, layers: r.layers, maxError: r.maxError };
  }

  /** Called once if the decoder workers fail. */
  onFailure(fn: (reason: string) => void) { this.pool.onBroken(fn); }

  /** Stop the decoder workers. */
  close() { this.pool.close(); }
}
