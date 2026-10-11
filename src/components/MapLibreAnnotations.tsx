/**
 * Annotation labels on the MapLibre map (as on the Leaflet map): a label per annotation,
 * click it to edit or delete. The label and forms come from map/annotationForms; new
 * annotations are created from the map click handler (openAnnotationCreate).
 */
import { useEffect } from 'react';
import * as maplibregl from 'maplibre-gl';
import { useAppContext } from '../context/AppContext';
import { annotationCreateForm, annotationEditForm, annotationLabelHtml } from '../map/annotationForms';
import type { AppAction } from '../types';

/** The "new annotation" form in a popup at the clicked point. */
export function openAnnotationCreate(map: maplibregl.Map, [lat, lng]: [number, number], dispatch: (a: AppAction) => void) {
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
  const form = annotationCreateForm([lat, lng], { dispatch, close: () => popup.remove() });
  popup.setLngLat([lng, lat]).setDOMContent(form.el).addTo(map);
  setTimeout(() => form.focus(), 50);
}

export default function MapLibreAnnotations({ map, ready }: { map: maplibregl.Map | null; ready: boolean }) {
  const { state, dispatch } = useAppContext();

  useEffect(() => {
    if (!ready || !map) return;
    let popup: maplibregl.Popup | null = null;
    const markers = state.annotations.map(ann => {
      const el = document.createElement('div');
      el.className = 'bowser-annotation';
      el.innerHTML = annotationLabelHtml(ann);
      el.addEventListener('click', ev => {
        ev.stopPropagation();
        popup?.remove();
        const p = new maplibregl.Popup({ closeButton: true, offset: [0, -4], maxWidth: 'none' });
        const form = annotationEditForm(ann, { dispatch, close: () => p.remove() });
        p.setLngLat([ann.position[1], ann.position[0]]).setDOMContent(form.el).addTo(map);
        popup = p;
        setTimeout(() => form.focus(), 50);
      });
      return new maplibregl.Marker({ element: el, anchor: 'top-left' })
        .setLngLat([ann.position[1], ann.position[0]]).addTo(map);
    });
    return () => { markers.forEach(m => m.remove()); popup?.remove(); };
  }, [ready, map, state.annotations, dispatch]);

  return null;
}
