/**
 * Which map to draw: MapLibre by default, Leaflet with ``?map=leaflet`` or when the
 * browser can't start WebGL2 (old GPU driver, remote desktop, some web views).
 */
export type MapKind = 'maplibre' | 'leaflet';

export function chooseMap(search: string, hasWebGL2: () => boolean): MapKind {
  const asked = new URLSearchParams(search).get('map');
  if (asked === 'leaflet') return 'leaflet';
  return hasWebGL2() ? 'maplibre' : 'leaflet';
}

export function browserHasWebGL2(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();   // only probing: give the context back
    return !!gl;
  } catch {
    return false;
  }
}
