import { describe, expect, it } from 'vitest';
import { chooseRenderer, evaluateCaps, gpuCaps, isSoftwareRenderer, parseRenderMode, resetGpuCapsCache, type GpuCaps } from './capability';

const good: GpuCaps = {
  webgl2: true, renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)',
  majorPerformanceCaveat: false, maxTextureSize: 16384, maxTextureUnits: 16, maxArrayLayers: 2048,
  floatTextures: true, benchMs: 0.4,
};

describe('GPU capability', () => {
  it('treats software rasterizers as no GPU', () => {
    for (const r of [
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
      'llvmpipe (LLVM 15.0.7, 256 bits)', 'Microsoft Basic Render Driver', 'softpipe', 'Google SwiftShader',
    ]) expect(isSoftwareRenderer(r)).toBe(true);
    expect(isSoftwareRenderer(good.renderer)).toBe(false);
    expect(isSoftwareRenderer('Apple M2')).toBe(false);
    expect(isSoftwareRenderer(null)).toBe(false);
  });

  it('accepts a hardware GPU and names why others are refused', () => {
    expect(evaluateCaps(good).capable).toBe(true);
    expect(evaluateCaps({ ...good, webgl2: false }).reason).toBe('no WebGL2');
    expect(evaluateCaps({ ...good, renderer: 'llvmpipe (LLVM 15)' }).reason).toMatch(/software renderer/);
    expect(evaluateCaps({ ...good, majorPerformanceCaveat: true }).reason).toMatch(/performance caveat/);
    expect(evaluateCaps({ ...good, floatTextures: false }).capable).toBe(false);
    expect(evaluateCaps({ ...good, maxTextureSize: 128 }).reason).toMatch(/MAX_TEXTURE_SIZE/);
    expect(evaluateCaps({ ...good, maxTextureUnits: 2 }).reason).toMatch(/texture units/);
    expect(evaluateCaps({ ...good, benchMs: 40 }).reason).toMatch(/slow GPU/);
  });

  it('keeps tiles unless ?render= asks otherwise', () => {
    expect(parseRenderMode('')).toBe('tiles');
    expect(parseRenderMode('?render=nonsense')).toBe('tiles');
    expect(parseRenderMode('?render=gpu')).toBe('gpu');
    expect(parseRenderMode('?x=1&render=auto')).toBe('auto');
  });

  it('auto picks the GPU only when capable; forced modes never probe', () => {
    const boom = () => { throw new Error('probed'); };
    expect(chooseRenderer('tiles', boom).renderer).toBe('tiles');
    expect(chooseRenderer('gpu', boom).renderer).toBe('gpu');
    expect(chooseRenderer('auto', () => good).renderer).toBe('gpu');
    const sw = chooseRenderer('auto', () => ({ ...good, renderer: 'SwiftShader', majorPerformanceCaveat: true }));
    expect(sw.renderer).toBe('tiles');
    expect(sw.reason).toMatch(/^auto: software renderer/);
  });

  it('probes once per browser session', () => {
    sessionStorage.clear();
    resetGpuCapsCache();
    let probes = 0;
    const probe = () => { probes++; return good; };
    expect(gpuCaps(probe)).toEqual(good);
    expect(gpuCaps(probe)).toEqual(good);
    expect(probes).toBe(1);
    // A reload (memory gone) reads the session's answer.
    resetGpuCapsCache();
    expect(gpuCaps(probe).renderer).toBe(good.renderer);
    expect(probes).toBe(1);
    sessionStorage.clear();
    resetGpuCapsCache();
  });
});
