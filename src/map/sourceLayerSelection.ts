/** Use only converter-declared provenance; ordinary properties named layer are user data. */
import type { OverlayFeatures } from '../types';

export interface SourceLayerChoice { name: string; count: number }
export function sourceLayerChoices(data: OverlayFeatures): SourceLayerChoice[] {
  const field = data.bowser_source_layer_property;
  if (typeof field !== 'string' || !field.length) return [];
  const counts = new Map<string, number>();
  for (const item of data.features) {
    const f = item as { properties?: Record<string, unknown> | null } | null;
    const name = f?.properties?.[field];
    // Incomplete provenance cannot safely divide a collection. Keep its ordinary import path.
    if (typeof name !== 'string') return [];
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count }));
}
export function selectSourceLayers(data: OverlayFeatures, selected: string[]): OverlayFeatures {
  const choices = sourceLayerChoices(data);
  const names = new Set(selected);
  if (!names.size || !choices.length || [...names].some(n => !choices.some(c => c.name === n))) {
    throw new Error('Select at least one available source layer.');
  }
  const field = data.bowser_source_layer_property!;
  return { ...data, features: data.features.filter(f => names.has((f as { properties: Record<string, string> }).properties[field])) };
}
