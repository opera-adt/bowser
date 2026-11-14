/**
 * The GPU renderer's MapLibre custom layer: zarr chunks as R16F or R32F texture arrays
 * (all dates of a chunk in one texture; float16 where the values allow it, see half.ts),
 * coloured in a fragment shader with the reference date, the spatial-reference shift,
 * one threshold mask, vmin/vmax and a colormap (the maths of params.ts's
 * ``displayedValue`` and ``colormapIndex``).
 *
 * Changing date within a chunk's dates, the colormap or the range is a uniform change:
 * no network, no upload. Chunks are fetched and decoded by the decoder workers
 * (decoderPool.ts); the main thread only uploads them, inside render() (MapLibre marks
 * its GL state cache dirty after a custom layer renders). Uploaded textures are kept
 * within a byte budget (textureBudget.ts).
 */
import type * as maplibregl from 'maplibre-gl';
import { colormapTexture } from './colormap';
import { GpuCube, type CubeVariable } from './cube';
import { chunkMesh, chunksForView, pickLevel, rasterTileZoom, translateMatrix } from './geometry';
import type { GpuParams } from './params';
import { evictionPlan, parseBudgetOverride, textureBudgetBytes } from './textureBudget';

const VS = `#version 300 es
uniform mat4 u_matrix;
in vec2 a_pos;
in vec2 a_px;
out vec2 v_px;
void main() {
  v_px = a_px;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
uniform sampler2DArray u_data;
uniform sampler2DArray u_ref;
uniform sampler2DArray u_mask;
uniform sampler2D u_cmap;
uniform int u_layer;
uniform int u_refLayer;      // -1: no reference date
uniform int u_maskLayer;
uniform int u_maskMode;      // 0 none, 1 keep >= thr, 2 keep <= thr
uniform float u_maskThr;
uniform float u_shift;
uniform float u_vmin;
uniform float u_vmax;
uniform float u_opacity;
uniform ivec2 u_size;
in vec2 v_px;
out vec4 fragColor;
void main() {
  ivec2 p = clamp(ivec2(floor(v_px)), ivec2(0), u_size - 1);
  float v = texelFetch(u_data, ivec3(p, u_layer), 0).r;
  if (u_refLayer >= 0) v -= texelFetch(u_ref, ivec3(p, u_refLayer), 0).r;
  if (isnan(v)) discard;
  if (u_maskMode > 0) {
    float m = texelFetch(u_mask, ivec3(p, u_maskLayer), 0).r;
    if (isnan(m) || isinf(m)) discard;
    bool keep = u_maskMode == 1 ? m >= u_maskThr : m <= u_maskThr;
    if (!keep) discard;      // NaN compares false: masked, as xarray's where()
  }
  v -= u_shift;
  float t = (clamp(v, u_vmin, u_vmax) - u_vmin) / (u_vmax - u_vmin);
  int idx = clamp(int(floor(t * 255.0)), 0, 255);
  vec4 c = texelFetch(u_cmap, ivec2(idx, 0), 0);
  fragColor = vec4(c.rgb * c.a, c.a) * u_opacity;
}`;

interface TexEntry {
  state: 'queued' | 'loading' | 'decoded' | 'ready' | 'error';
  tex: WebGLTexture | null;
  data: Float32Array | Uint16Array | null;
  format: 'f32' | 'f16';
  layers: number;
  bytes: number;
  lastUsed: number;
  priority: number;
}

interface MeshEntry { vao: WebGLVertexArrayObject; buffers: WebGLBuffer[]; count: number; origin: [number, number]; size: [number, number] }

interface DrawItem { level: number; cy: number; cx: number; data: string; layer: number; ref: string | null; refLayer: number; mask: string | null; maskLayer: number }

export interface GpuLayerOptions {
  /** Called once when the layer can't go on (shader, context loss, repeated errors/slow frames). */
  onFailure: (reason: string) => void;
  /** Watch for slow frames (auto mode only: forced GPU keeps going on slow GPUs). */
  watchSlowFrames: boolean;
  /**
   * Texture memory budget in bytes. Default: ``?gpu_mb=`` from the address, else from
   * the device's memory (textureBudget.ts).
   */
  budgetBytes?: number;
}

/** What the layer holds (for the debug label and the tests). */
export interface GpuLayerStats {
  /** Bytes of uploaded chunk textures now, and the most there ever were. */
  textureBytes: number;
  peakTextureBytes: number;
  budgetBytes: number;
  /** Uploaded chunk textures by format. */
  f16: number;
  f32: number;
  /** Textures deleted to stay within the budget, and requests dropped as no longer needed. */
  evicted: number;
  dropped: number;
  /** Largest float16 rounding error of the uploaded chunks (data units). */
  maxHalfError: number;
  /**
   * Milliseconds from the last change of what to draw (a date, a colour range, ...)
   * to the first frame that drew all of it in view, or null before one.
   */
  drawMs: number | null;
}

const MAX_INFLIGHT = 6;
const UPLOADS_PER_FRAME = 4;
const SLOW_FRAME_MS = 250;
const SLOW_FRAMES_IN_A_ROW = 5;

export class GpuCubeLayer implements maplibregl.CustomLayerInterface {
  readonly id = 'gpu-data';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private map: maplibregl.Map | null = null;
  private program: WebGLProgram | null = null;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private cmapTex: WebGLTexture | null = null;
  private cmapName = '';
  private dummyTex: WebGLTexture | null = null;
  private textures = new Map<string, TexEntry>();
  private meshes = new Map<string, MeshEntry>();
  private vars = new Map<string, CubeVariable | 'loading' | 'error'>();
  private displayed = new Map<string, DrawItem>();
  private inflight = 0;
  private errors = 0;
  private slow = 0;
  private failed = false;
  private params: GpuParams | null = null;
  private opacity = 1;
  private useCounter = 0;
  private textureBytes = 0;
  private counts = { peak: 0, f16: 0, f32: 0, evicted: 0, dropped: 0, maxHalfError: 0 };
  private readonly budget: number;
  private changedAt: number | null = null;
  private drawMs: number | null = null;

  constructor(readonly cube: GpuCube, private opts: GpuLayerOptions) {
    this.budget = opts.budgetBytes ?? textureBudgetBytes(
      parseBudgetOverride(typeof location !== 'undefined' ? location.search : ''),
      typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined);
    // The decoder workers failing means no more chunks: tiles instead.
    cube.onFailure?.(reason => this.fail(reason));
  }

  stats(): GpuLayerStats {
    const c = this.counts;
    return {
      textureBytes: this.textureBytes, peakTextureBytes: c.peak, budgetBytes: this.budget, f16: c.f16, f32: c.f32,
      evicted: c.evicted, dropped: c.dropped, maxHalfError: c.maxHalfError,
      drawMs: this.drawMs === null ? null : Math.round(this.drawMs),
    };
  }

  /** Stop the decoder workers (the layer is not used again). */
  close() { this.cube.close?.(); }

  /** What to draw (null: nothing, while the map shows tiles for a view the GPU can't draw). */
  setParams(p: GpuParams | null, opacity: number) {
    this.params = p;
    this.changedAt = performance.now();
    this.opacity = opacity;
    this.map?.triggerRepaint();
  }

  onAdd(map: maplibregl.Map, gl: WebGL2RenderingContext) {
    this.map = map;
    try {
      this.program = this.compile(gl);
    } catch (e) {
      this.fail(`shader: ${(e as Error).message}`);
      return;
    }
    for (const n of ['u_matrix', 'u_data', 'u_ref', 'u_mask', 'u_cmap', 'u_layer', 'u_refLayer', 'u_maskLayer',
      'u_maskMode', 'u_maskThr', 'u_shift', 'u_vmin', 'u_vmax', 'u_opacity', 'u_size']) {
      this.loc[n] = gl.getUniformLocation(this.program, n);
    }
    this.cmapTex = gl.createTexture();
    this.dummyTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.dummyTex);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R32F, 1, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array([0]));
    this.nearest(gl, gl.TEXTURE_2D_ARRAY);
    map.on('webglcontextlost', this.onContextLost);
  }

  onRemove(_map: maplibregl.Map, gl: WebGL2RenderingContext) {
    this.map?.off('webglcontextlost', this.onContextLost);
    // On context loss MapLibre destroys the style (removing this layer) before it fires
    // webglcontextlost, so the loss is noticed here.
    if (gl.isContextLost()) { this.fail('WebGL context lost'); this.map = null; return; }
    for (const e of this.textures.values()) if (e.tex) gl.deleteTexture(e.tex);
    for (const m of this.meshes.values()) { gl.deleteVertexArray(m.vao); m.buffers.forEach(b => gl.deleteBuffer(b)); }
    if (this.program) gl.deleteProgram(this.program);
    if (this.cmapTex) gl.deleteTexture(this.cmapTex);
    if (this.dummyTex) gl.deleteTexture(this.dummyTex);
    this.textures.clear();
    this.meshes.clear();
    this.displayed.clear();
    this.textureBytes = 0;
    this.counts.f16 = this.counts.f32 = 0;
    this.map = null;
  }

  private onContextLost = () => this.fail('WebGL context lost');

  private fail(reason: string) {
    if (this.failed) return;
    this.failed = true;
    this.opts.onFailure(reason);
  }

  private compile(gl: WebGL2RenderingContext): WebGLProgram {
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]] as const) {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'compile failed');
      gl.attachShader(prog, s);
    }
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.bindAttribLocation(prog, 1, 'a_px');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link failed');
    return prog;
  }

  private nearest(gl: WebGL2RenderingContext, target: number) {
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  // ── chunk loading ─────────────────────────────────────────────────────────

  private variableInfo(level: number, name: string): CubeVariable | null {
    const key = `${level}|${name}`;
    const v = this.vars.get(key);
    if (v && v !== 'loading' && v !== 'error') return v;
    if (v === 'error') return null;
    if (!v) {
      this.vars.set(key, 'loading');
      this.cube.variable(level, name).then(
        info => { this.vars.set(key, info); this.map?.triggerRepaint(); },
        // Without the variable nothing can be drawn: tiles instead.
        () => { this.vars.set(key, 'error'); this.fail(`layer ${name} not readable at /zarr/`); },
      );
    }
    return null;
  }

  private countError(reason: string) {
    this.errors++;
    if (this.errors >= 3) this.fail(`repeated chunk errors (${reason})`);
  }

  /**
   * The texture entry for a chunk, queued for loading if new. ``exact`` chunks (masks,
   * compared with a threshold as the server does) are always float32; others may be
   * float16 (half.ts).
   */
  private want(level: number, variable: string, tb: number, cy: number, cx: number, priority: number, exact = false): string {
    const key = `${level}|${variable}|${tb}|${cy}|${cx}|${exact ? 'x' : 'h'}`;
    let e = this.textures.get(key);
    if (!e) {
      e = { state: 'queued', tex: null, data: null, format: 'f32', layers: 0, bytes: 0, lastUsed: 0, priority };
      this.textures.set(key, e);
    }
    e.priority = Math.min(e.priority, priority);
    e.lastUsed = ++this.useCounter;
    return key;
  }

  private pump() {
    if (this.inflight >= MAX_INFLIGHT) return;
    const queued = [...this.textures.entries()].filter(([, e]) => e.state === 'queued')
      .sort((a, b) => a[1].priority - b[1].priority || b[1].lastUsed - a[1].lastUsed);
    for (const [key, e] of queued) {
      if (this.inflight >= MAX_INFLIGHT) break;
      const [level, variable, tb, cy, cx, kind] = key.split('|');
      e.state = 'loading';
      this.inflight++;
      this.cube.chunk(Number(level), variable, Number(tb), Number(cy), Number(cx), kind === 'h').then(c => {
        this.errors = 0;
        if (this.textures.get(key) !== e) return;   // dropped meanwhile
        e.data = c.data;
        e.format = c.format;
        e.layers = c.layers;
        e.state = 'decoded';
        if (c.format === 'f16') this.counts.maxHalfError = Math.max(this.counts.maxHalfError, c.maxError ?? 0);
      }, err => {
        if (this.failed || this.textures.get(key) !== e) return;
        e.state = 'error';
        this.countError(String(err));
      }).finally(() => {
        this.inflight--;
        this.map?.triggerRepaint();
      });
    }
  }

  private upload(gl: WebGL2RenderingContext, e: TexEntry, chunk: [number, number]) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    const half = e.format === 'f16';
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, half ? 2 : 4);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, half ? gl.R16F : gl.R32F, chunk[1], chunk[0], e.layers, 0, gl.RED,
      half ? gl.HALF_FLOAT : gl.FLOAT, e.data);
    this.nearest(gl, gl.TEXTURE_2D_ARRAY);
    e.tex = tex;
    e.bytes = chunk[0] * chunk[1] * e.layers * (half ? 2 : 4);
    e.data = null;
    e.state = 'ready';
    this.textureBytes += e.bytes;
    this.counts.peak = Math.max(this.counts.peak, this.textureBytes);
    this.counts[e.format]++;
  }

  private chunkShape(key: string): [number, number] {
    return this.cube.levels[Number(key.split('|')[0])].chunk;
  }

  /** Delete textures above the budget: away from the view first, then other dates (textureBudget.ts). */
  private evict(gl: WebGL2RenderingContext, keep: Set<string>, inView: Set<string>) {
    for (const k of evictionPlan(this.textures, this.textureBytes, this.budget, keep, inView)) {
      const e = this.textures.get(k)!;
      gl.deleteTexture(e.tex);
      this.textureBytes -= e.bytes;
      this.counts[e.format]--;
      this.counts.evicted++;
      this.textures.delete(k);
    }
  }

  /**
   * Forget queued chunks this frame no longer asks for (dates played past, places
   * panned away from), so the network doesn't go to them. Chunks already fetched or
   * being fetched are still uploaded (one per frame, after the view's own), so coming
   * back to them needs no second fetch; the budget evicts them like any other.
   */
  private dropStale(since: number) {
    for (const [k, e] of this.textures) {
      if (e.state === 'queued' && e.lastUsed <= since) {
        this.textures.delete(k);
        this.counts.dropped++;
      }
    }
  }

  private mesh(gl: WebGL2RenderingContext, level: number, cy: number, cx: number): MeshEntry {
    const key = `${level}|${cy}|${cx}`;
    let m = this.meshes.get(key);
    if (m) return m;
    const lv = this.cube.levels[level];
    const geo = chunkMesh(lv, this.cube.zone, cy, cx);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, geo.vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geo.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    m = { vao, buffers: [vbo, ibo], count: geo.indices.length, origin: geo.origin, size: lv.chunk };
    this.meshes.set(key, m);
    return m;
  }

  // ── drawing ───────────────────────────────────────────────────────────────

  render(gl: WebGL2RenderingContext, options: maplibregl.CustomRenderMethodInput) {
    if (this.failed || !this.program || !this.map || !this.params) return;
    const t0 = performance.now();
    try {
      this.draw(gl, options);
    } catch (e) {
      this.fail(`render: ${(e as Error).message}`);
      return;
    }
    const ms = performance.now() - t0;
    if (this.opts.watchSlowFrames) {
      this.slow = ms > SLOW_FRAME_MS ? this.slow + 1 : 0;
      if (this.slow >= SLOW_FRAMES_IN_A_ROW) this.fail(`${SLOW_FRAMES_IN_A_ROW} frames over ${SLOW_FRAME_MS} ms`);
    }
  }

  private draw(gl: WebGL2RenderingContext, options: maplibregl.CustomRenderMethodInput) {
    const map = this.map!;
    const p = this.params!;
    const level = pickLevel(this.cube.levels, rasterTileZoom(map.getZoom()));
    const lv = this.cube.levels[level];
    const info = this.variableInfo(level, p.variable);
    const maskInfo = p.mask ? this.variableInfo(level, p.mask.dataset) : null;
    if (!info || (p.mask && !maskInfo)) { this.pump(); return; }

    const b = map.getBounds();
    const range = chunksForView(lv, this.cube.zone, b.getWest(), b.getSouth(), b.getEast(), b.getNorth());
    const t = Math.max(0, Math.min(p.timeIdx, info.nTime - 1));
    const tb = Math.floor(t / info.tChunk);
    const tr = p.refTimeIdx !== null && info.ndim === 3 ? Math.max(0, Math.min(p.refTimeIdx, info.nTime - 1)) : null;
    if (maskInfo?.ndim === 3 && (info.ndim !== 3 || maskInfo.nTime !== info.nTime))
      throw new Error('Mask axis does not match the data; use a compatible static summary');
    const mt = maskInfo?.ndim === 3 ? t : 0;

    const want: DrawItem[] = [];
    let complete = true;
    const keep = new Set<string>();
    const inView = new Set<string>();
    const frameStart = this.useCounter;
    if (range) {
      for (let cy = range.cy0; cy <= range.cy1; cy++) {
        for (let cx = range.cx0; cx <= range.cx1; cx++) {
          const item: DrawItem = {
            level, cy, cx,
            data: this.want(level, p.variable, tb, cy, cx, 0), layer: t % info.tChunk,
            ref: tr !== null ? this.want(level, p.variable, Math.floor(tr / info.tChunk), cy, cx, 0) : null,
            refLayer: tr !== null ? tr % info.tChunk : -1,
            mask: maskInfo && p.mask ? this.want(level, p.mask.dataset, Math.floor(mt / maskInfo.tChunk), cy, cx, 0, true) : null,
            maskLayer: maskInfo ? mt % maskInfo.tChunk : 0,
          };
          [item.data, item.ref, item.mask].forEach(k => k && keep.add(k));
          inView.add(`${level}|${cy}|${cx}`);
          want.push(item);
        }
      }
    }

    // Upload a few decoded chunks per frame (needed ones first), so a frame stays short.
    let uploads = 0;
    for (const k of keep) {
      const e = this.textures.get(k)!;
      if (e.state === 'decoded' && uploads < UPLOADS_PER_FRAME) { this.upload(gl, e, this.chunkShape(k)); uploads++; }
    }
    // Then prefetched chunks, one per frame.
    if (uploads === 0) {
      for (const [k, e] of this.textures) {
        if (e.state === 'decoded') { this.upload(gl, e, this.chunkShape(k)); break; }
      }
    }
    const ready = (k: string | null) => k === null || this.textures.get(k)?.state === 'ready';
    const items: DrawItem[] = [];
    for (const it of want) {
      const pos = `${it.level}|${it.cy}|${it.cx}`;
      if (ready(it.data) && ready(it.ref) && ready(it.mask)) {
        this.displayed.set(pos, it);
        items.push(it);
      } else {
        complete = false;
        const prev = this.displayed.get(pos);
        if (prev && ready(prev.data) && ready(prev.ref) && ready(prev.mask)) items.push(prev);   // stale until new
      }
    }
    if (complete && this.changedAt !== null) { this.drawMs = performance.now() - this.changedAt; this.changedAt = null; }
    // Other levels' chunks stay underneath until this level has fully drawn.
    const under: DrawItem[] = [];
    for (const [pos, it] of this.displayed) {
      if (it.level === level) continue;
      if (complete) this.displayed.delete(pos);
      else if (ready(it.data) && ready(it.ref) && ready(it.mask)) under.push(it);
    }

    if (range && tb + 1 < Math.ceil(info.nTime / info.tChunk)) {
      // Prefetch the next block of dates once the view is drawn; keep what is on its way.
      for (const it of want) {
        if (complete) this.want(level, p.variable, tb + 1, it.cy, it.cx, 1);
        else {
          const e = this.textures.get(`${level}|${p.variable}|${tb + 1}|${it.cy}|${it.cx}|h`);
          if (e) e.lastUsed = ++this.useCounter;
        }
      }
    }
    for (const k of keep) { const e = this.textures.get(k); if (e) e.lastUsed = ++this.useCounter; }
    this.dropStale(frameStart);
    this.pump();
    const pending = [...this.textures.values()].some(e => e.state !== 'ready' && e.state !== 'error');
    // What this frame draws is not evicted under it: besides the view's own chunks (keep),
    // that is the previous date still shown while the new one loads, and other levels
    // underneath. Evicting one of those left the draw below with no texture to bind.
    const drawn = new Set(keep);
    for (const it of [...under, ...items]) [it.data, it.ref, it.mask].forEach(k => k && drawn.add(k));
    this.evict(gl, drawn, inView);

    this.ensureColormap(gl, p.colormap);
    gl.useProgram(this.program);
    gl.uniform1i(this.loc.u_data, 0);
    gl.uniform1i(this.loc.u_ref, 1);
    gl.uniform1i(this.loc.u_mask, 2);
    gl.uniform1i(this.loc.u_cmap, 3);
    gl.uniform1f(this.loc.u_shift, p.shift);
    gl.uniform1f(this.loc.u_vmin, p.vmin);
    gl.uniform1f(this.loc.u_vmax, p.vmax);
    gl.uniform1f(this.loc.u_opacity, this.opacity);
    gl.uniform1i(this.loc.u_maskMode, p.mask ? (p.mask.mode === 'max' ? 2 : 1) : 0);
    gl.uniform1f(this.loc.u_maskThr, p.mask?.threshold ?? 0);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.cmapTex);
    const main = (options.defaultProjectionData?.mainMatrix ?? options.modelViewProjectionMatrix) as ArrayLike<number>;
    for (const it of [...under, ...items]) {
      const data = this.textures.get(it.data)?.tex;
      const ref = it.ref ? this.textures.get(it.ref)?.tex : this.dummyTex;
      const mask = it.mask ? this.textures.get(it.mask)?.tex : this.dummyTex;
      if (!data || !ref || !mask) continue;   // gone since the list was made: skip, never throw
      const m = this.mesh(gl, it.level, it.cy, it.cx);
      gl.uniformMatrix4fv(this.loc.u_matrix, false, translateMatrix(main, m.origin[0], m.origin[1]));
      gl.uniform2i(this.loc.u_size, m.size[1], m.size[0]);
      gl.uniform1i(this.loc.u_layer, it.layer);
      gl.uniform1i(this.loc.u_refLayer, it.ref ? it.refLayer : -1);
      gl.uniform1i(this.loc.u_maskLayer, it.maskLayer);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, data);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, ref);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, mask);
      gl.bindVertexArray(m.vao);
      gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_SHORT, 0);
    }
    gl.bindVertexArray(null);

    if (!complete || pending) map.triggerRepaint();
  }

  private ensureColormap(gl: WebGL2RenderingContext, name: string) {
    if (name === this.cmapName) return;
    const bytes = colormapTexture(name);
    // useGpuRender sends only colormaps with a table; never draw another one's colours.
    if (!bytes) throw new Error(`no colormap table for ${name}`);
    gl.bindTexture(gl.TEXTURE_2D, this.cmapTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    this.nearest(gl, gl.TEXTURE_2D);
    this.cmapName = name;
  }
}
