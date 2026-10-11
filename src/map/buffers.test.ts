import { describe, expect, it } from 'vitest';
import { bufferFeatures, circleRing } from './buffers';
import { distanceM } from './profileGeometry';

const pt = (id: string, visible: boolean, color: string) =>
  ({ id, name: id, position: [33.96, -117.67] as [number, number], color, visible, data: [] }) as any;
const base = { bufferEnabled: true, bufferRadius: 200, refEnabled: true, refBufferEnabled: true, refBufferRadius: 500,
  refMarkerPosition: [33.95, -117.66] as [number, number], timeSeriesPoints: [pt('a', true, '#111111'), pt('b', false, '#222222')] };

describe('buffer circles', () => {
  it('every ring point is `radius` metres from the centre, and the ring is closed', () => {
    const ring = circleRing([33.96, -117.67], 250);
    expect(ring).toHaveLength(65);
    expect(ring[0]).toEqual(ring[64]);
    for (const [lng, lat] of ring) expect(distanceM([33.96, -117.67], [lat, lng])).toBeCloseTo(250, 6);
  });

  it('one circle per visible point, plus the reference buffer when re-referencing is on', () => {
    expect(bufferFeatures(base).features.map(f => f.properties.color)).toEqual(['#111111', '#e05d6a']);
    expect(bufferFeatures({ ...base, refEnabled: false }).features).toHaveLength(1);
    expect(bufferFeatures({ ...base, bufferEnabled: false, refBufferRadius: 0 }).features).toHaveLength(0);
  });
});
