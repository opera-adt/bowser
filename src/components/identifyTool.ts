/**
 * The identify (pointer) tool on the MapLibre map: a click reports what is under it. A GNSS
 * station opens its east/north/up chart; features of vector layers (files, drawings, soils,
 * stations) show their attributes; geology and land cover, when on, are looked up at the point.
 */
import { useEffect, useRef } from 'react';
import type * as maplibregl from 'maplibre-gl';
import { useAppContext } from '../context/AppContext';
import { GNSS_CUSTOM_LAYER_ID, GNSS_LAYER_ID, type GnssStation } from '../map/gnss';
import {
  attributeRows, geologyItem, landCoverClass, landCoverIdentifyUrl, MACROSTRAT_POINT, overlayIdOfLayer,
  type IdentifyItem, type IdentifyResult,
} from '../map/identify';

export function useIdentify(map: maplibregl.Map | null, ready: boolean) {
  const { state, dispatch } = useAppContext();
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!ready || !map || !state.identifyEnabled) return;
    const canvas = map.getCanvas();
    canvas.style.cursor = 'default'; // a plain arrow: Identify clicks the map, it isn't help
    let seq = 0;
    const onClick = async (e: maplibregl.MapMouseEvent) => {
      const s = stateRef.current;
      const run = ++seq;
      const { lng, lat } = e.lngLat;
      const box: [maplibregl.PointLike, maplibregl.PointLike] = [[e.point.x - 5, e.point.y - 5], [e.point.x + 5, e.point.y + 5]];
      const items: IdentifyItem[] = [];
      const seen = new Set<string>();
      for (const f of map.queryRenderedFeatures(box)) {
        const id = overlayIdOfLayer(f.layer.id);
        const overlay = id ? s.overlays.find(o => o.id === id) : null;
        if (!overlay || !(overlay.type === 'vector' || overlay.pmtilesKind === 'vector') || seen.has(overlay.id)) continue;
        seen.add(overlay.id);
        if (overlay.id === GNSS_LAYER_ID || overlay.id === GNSS_CUSTOM_LAYER_ID) {
          const custom = overlay.id === GNSS_CUSTOM_LAYER_ID;
          dispatch({ type: 'OPEN_GNSS_CHART', payload: { ...f.properties, custom } as unknown as GnssStation });
          items.push({ title: `GNSS station ${f.properties?.id}`, rows: [['Chart', 'opened (east, north, up)']] });
          continue;
        }
        items.push({ title: overlay.name, rows: attributeRows(f.properties), color: overlay.color });
      }
      const geology = s.overlays.find(o => o.serviceKey === 'geology' && o.visible);
      const landCover = s.overlays.find(o => o.landCoverYear && o.visible);
      const pending = [...(geology ? ['geology'] : []), ...(landCover ? ['land cover'] : [])];
      const result: IdentifyResult = { lngLat: [lng, lat], items, pending };
      dispatch({ type: 'SET_IDENTIFY', payload: { ...result } });
      const done = (key: string, item: IdentifyItem | null) => {
        if (run !== seq) return;
        result.pending = result.pending.filter(p => p !== key);
        if (item) result.items = [...result.items, item];
        dispatch({ type: 'SET_IDENTIFY', payload: { ...result } });
      };
      if (geology) {
        fetch(`${MACROSTRAT_POINT}?${new URLSearchParams({ lat: lat.toFixed(5), lng: lng.toFixed(5) })}`)
          .then(r => (r.ok ? r.json() : null))
          .then(body => done('geology', geologyItem(body) ?? { title: 'Geology (Macrostrat)', rows: [['Unit', 'no mapped unit here']] }))
          .catch(() => done('geology', { title: 'Geology (Macrostrat)', rows: [['Unit', 'could not be looked up']] }));
      }
      if (landCover) {
        fetch(landCoverIdentifyUrl(lng, lat, landCover.landCoverYear!))
          .then(r => (r.ok ? r.json() : null))
          .then(body => {
            const c = landCoverClass(body?.value);
            done('land cover', { title: `Land cover ${landCover.landCoverYear}`, rows: [['Class', c?.name ?? 'no data']], color: c?.color });
          })
          .catch(() => done('land cover', { title: `Land cover ${landCover.landCoverYear}`, rows: [['Class', 'could not be looked up']] }));
      }
    };
    map.on('click', onClick);
    return () => {
      map.off('click', onClick);
      canvas.style.cursor = '';
    };
  }, [ready, map, state.identifyEnabled, dispatch]);
}
