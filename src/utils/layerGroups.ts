/**
 * Groups for the layer pickers. Cubes and COG configs name the same layer
 * differently (``temporal_coherence``, "Temporal Coherence", ``coherenceMagnitude``),
 * so names are normalised before matching. Rules run in order: ``estimated_phase_quality``
 * is a quality layer, not a phase layer.
 */
export const LAYER_GROUPS = ['Displacement', 'Quality', 'Amplitude', 'Corrections', 'Radar geometry', 'Masks', 'Other'] as const;
export type LayerGroup = (typeof LAYER_GROUPS)[number];

const RULES: [RegExp, LayerGroup][] = [
  [/mask/, 'Masks'],
  [/ionos|troposph|solid_earth|tide/, 'Corrections'],
  [/baseline|incidence|azimuth|line_of_sight|(^|_)los(_|$)|layover|shadow|heading/, 'Radar geometry'],
  [/coheren|similarity|quality|connected_component|residual|shp|crlb|dispersion|correlation|uncertainty/, 'Quality'],
  [/amplitude/, 'Amplitude'],
  [/displacement|velocity|phase|interferogram|offset/, 'Displacement'],
];

function normalise(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

export function layerGroup(name: string): LayerGroup {
  const key = normalise(name);
  return RULES.find(([pattern]) => pattern.test(key))?.[1] ?? 'Other';
}

/** The non-empty groups in display order, each with its names in the order given. */
export function groupLayers(names: string[]): { group: LayerGroup; names: string[] }[] {
  return LAYER_GROUPS
    .map(group => ({ group, names: names.filter(name => layerGroup(name) === group) }))
    .filter(g => g.names.length > 0);
}
