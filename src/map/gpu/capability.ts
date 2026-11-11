/**
 * Which renderer draws the data layer: server tiles (the default) or the experimental
 * GPU path.
 *
 * ``?render=tiles`` (the default) and ``?render=gpu`` force one; ``?render=auto`` uses
 * the GPU only when the browser has a capable, hardware GPU. The probe runs only for
 * ``auto``, once per browser session (cached in sessionStorage).
 *
 * This module is in the main bundle, so it stays small: the GPU runtime (zarrita, the
 * colormap tables, the custom layer) is loaded on demand by useGpuRender.
 */

export type RenderMode = 'tiles' | 'gpu' | 'auto';
export type Renderer = 'tiles' | 'gpu';

export interface GpuCaps {
  webgl2: boolean;
  /** UNMASKED_RENDERER_WEBGL, or the masked RENDERER string. */
  renderer: string | null;
  /** A context with ``failIfMajorPerformanceCaveat: true`` could not be created. */
  majorPerformanceCaveat: boolean;
  maxTextureSize: number;
  maxTextureUnits: number;
  maxArrayLayers: number;
  /** R32F textures can be uploaded and read with texelFetch (core WebGL2; checked). */
  floatTextures: boolean;
  /** Milliseconds for the micro-benchmark (512x512 colormap pass x5), or null. */
  benchMs: number | null;
}

export interface GpuNeeds {
  textureSize: number;
  textureUnits: number;
  arrayLayers: number;
  benchBudgetMs: number;
}

/** What the shader path uses: 256-px chunks, 4 samplers, up to 8 dates per chunk. */
export const GPU_NEEDS: GpuNeeds = { textureSize: 256, textureUnits: 4, arrayLayers: 8, benchBudgetMs: 8 };

const SOFTWARE = /swiftshader|llvmpipe|softpipe|lavapipe|microsoft basic render|software rasterizer|software adapter|mesa offscreen|apple software/i;

/** True for a software rasterizer (SwiftShader, llvmpipe, Microsoft Basic Render, ...). */
export function isSoftwareRenderer(renderer: string | null): boolean {
  return !!renderer && SOFTWARE.test(renderer);
}

export interface Decision { renderer: Renderer; reason: string }

/** Whether ``caps`` are good enough for the GPU path, and why not. */
export function evaluateCaps(caps: GpuCaps, needs: GpuNeeds = GPU_NEEDS): { capable: boolean; reason: string } {
  if (!caps.webgl2) return { capable: false, reason: 'no WebGL2' };
  if (isSoftwareRenderer(caps.renderer)) return { capable: false, reason: `software renderer (${caps.renderer})` };
  if (caps.majorPerformanceCaveat) return { capable: false, reason: 'major performance caveat (no hardware GPU)' };
  if (!caps.floatTextures) return { capable: false, reason: 'no float textures' };
  if (caps.maxTextureSize < needs.textureSize) return { capable: false, reason: `MAX_TEXTURE_SIZE ${caps.maxTextureSize} < ${needs.textureSize}` };
  if (caps.maxTextureUnits < needs.textureUnits) return { capable: false, reason: `${caps.maxTextureUnits} texture units < ${needs.textureUnits}` };
  if (caps.maxArrayLayers < needs.arrayLayers) return { capable: false, reason: `${caps.maxArrayLayers} array layers < ${needs.arrayLayers}` };
  if (caps.benchMs !== null && caps.benchMs > needs.benchBudgetMs) {
    return { capable: false, reason: `slow GPU (${caps.benchMs.toFixed(1)} ms > ${needs.benchBudgetMs} ms budget)` };
  }
  return { capable: true, reason: `capable GPU (${caps.renderer ?? 'unknown'})` };
}

/** ``?render=`` -> mode; anything else (or nothing) keeps today's tiles. */
export function parseRenderMode(search: string): RenderMode {
  const v = new URLSearchParams(search).get('render');
  return v === 'gpu' || v === 'auto' || v === 'tiles' ? v : 'tiles';
}

/** The renderer for ``mode``; ``probe`` is only called for ``auto``. */
export function chooseRenderer(mode: RenderMode, probe: () => GpuCaps): Decision {
  if (mode === 'tiles') return { renderer: 'tiles', reason: 'render=tiles (default)' };
  if (mode === 'gpu') return { renderer: 'gpu', reason: 'render=gpu (forced)' };
  const { capable, reason } = evaluateCaps(probe());
  return { renderer: capable ? 'gpu' : 'tiles', reason: `auto: ${reason}` };
}

// ── browser probe ──────────────────────────────────────────────────────────────

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `#version 300 es
precision highp float; precision highp sampler2D;
uniform sampler2D u_data; uniform sampler2D u_cmap; in vec2 uv; out vec4 o;
void main() {
  float v = texelFetch(u_data, ivec2(uv * 512.0), 0).r;
  int i = clamp(int(floor(v * 255.0)), 0, 255);
  o = texelFetch(u_cmap, ivec2(i, 0), 0);
}`;

function compile(gl: WebGL2RenderingContext): WebGLProgram | null {
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]] as const) {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) return null;
    gl.attachShader(prog, s);
  }
  gl.linkProgram(prog);
  return gl.getProgramParameter(prog, gl.LINK_STATUS) ? prog : null;
}

/** Draw a 512x512 colormap pass ``runs`` times; ms per pass (after a warm-up), or null. */
function microBenchmark(gl: WebGL2RenderingContext, runs = 5): number | null {
  const prog = compile(gl);
  if (!prog) return null;
  const size = 512;
  const data = new Float32Array(size * size);
  for (let i = 0; i < data.length; i++) data[i] = (i % 997) / 997;
  const tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, size, size, 0, gl.RED, gl.FLOAT, data);
  for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
  const cmap = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, cmap);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(1024).fill(200));
  for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
  const target = gl.createTexture();
  gl.activeTexture(gl.TEXTURE2);   // not unit 1: that would replace the colormap (feedback loop)
  gl.bindTexture(gl.TEXTURE_2D, target);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
  gl.viewport(0, 0, size, size);
  gl.useProgram(prog);
  gl.uniform1i(gl.getUniformLocation(prog, 'u_data'), 0);
  gl.uniform1i(gl.getUniformLocation(prog, 'u_cmap'), 1);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const px = new Uint8Array(4);
  const pass = () => { gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
  pass();   // warm-up: shader compile, uploads
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) pass();
  const ms = (performance.now() - t0) / runs;
  return gl.getError() === gl.NO_ERROR && px[0] === 200 ? ms : null;
}

function release(gl: WebGL2RenderingContext | null) {
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
}

/** Probe this browser's WebGL2 (fresh, not cached). */
export function probeGpuCaps(): GpuCaps {
  const caps: GpuCaps = {
    webgl2: false, renderer: null, majorPerformanceCaveat: false, maxTextureSize: 0,
    maxTextureUnits: 0, maxArrayLayers: 0, floatTextures: false, benchMs: null,
  };
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return caps;
    caps.webgl2 = true;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    caps.renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    caps.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    caps.maxTextureUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
    caps.maxArrayLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);
    caps.benchMs = microBenchmark(gl);
    caps.floatTextures = caps.benchMs !== null;   // the bench uploads and reads an R32F texture
  } catch {
    /* leave what was found */
  } finally {
    release(gl);
  }
  try {
    const strict = document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: true });
    caps.majorPerformanceCaveat = !strict;
    release(strict);
  } catch {
    caps.majorPerformanceCaveat = true;
  }
  return caps;
}

let cached: GpuCaps | null = null;
const SESSION_KEY = 'bowser.gpuCaps.v1';

/** Forget the cached probe (tests). */
export function resetGpuCapsCache() { cached = null; }

/** probeGpuCaps, once per session (memory, then sessionStorage). */
export function gpuCaps(probe: () => GpuCaps = probeGpuCaps): GpuCaps {
  if (cached) return cached;
  try {
    const s = sessionStorage.getItem(SESSION_KEY);
    if (s) return (cached = JSON.parse(s) as GpuCaps);
  } catch { /* no storage */ }
  cached = probe();
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(cached)); } catch { /* not cached */ }
  return cached;
}
