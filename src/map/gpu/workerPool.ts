/**
 * The decoder workers (decode.worker.ts), started only when the GPU path opens a cube.
 */
import { DecoderPool, poolSize } from './decoderPool';

export function createDecoderPool(): DecoderPool {
  return new DecoderPool(
    () => new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module', name: 'bowser-gpu-decoder' }),
    poolSize(typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined),
  );
}
