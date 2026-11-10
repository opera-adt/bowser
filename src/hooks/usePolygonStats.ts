import { useEffect, useState } from 'react';

/** Why area statistics are off on bowser-lite (its /config says polygon_stats: false). */
export const AREA_NEEDS_SERVER = 'Area statistics need the full Bowser server';

/** False once /config says this server can't summarise polygons (bowser-lite); true until then. */
export function usePolygonStats(): boolean {
  const [supported, setSupported] = useState(true);
  useEffect(() => {
    let live = true;
    fetch('/config')
      .then(r => (r.ok ? r.json() : null))
      .then(cfg => { if (live && cfg?.polygon_stats === false) setSupported(false); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  return supported;
}
