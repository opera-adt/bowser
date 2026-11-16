/** Imported IDs are namespaced by an explicitly declared source layer, never guessed
 * from an ordinary attribute called "layer". Ambiguous IDs retain index identity.
 */
import type { FeatureSource, OverlayFeatures } from '../types';

export function validFeatureId(id: unknown): id is string | number {
  return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

export function featureSources(overlayId: string, layer: string, data: OverlayFeatures, useIds = true): FeatureSource[] {
  if (!useIds) return data.features.map((_, index) => ({ overlayId, layer, index }));
  const field = data.bowser_source_layer_property;
  const identities = data.features.map(feature => {
    const f = feature as { id?: unknown; properties?: Record<string, unknown> | null } | null;
    const id = f?.id;
    const sourceLayer = typeof field === 'string' && typeof f?.properties?.[field] === 'string'
      ? f.properties[field] as string : undefined;
    const featureId = validFeatureId(id) ? id : undefined;
    // JSON tuples distinguish number/string IDs, source layers and delimiter characters.
    const token = featureId === undefined ? undefined : `id:${JSON.stringify([sourceLayer ?? null, featureId])}`;
    return { featureId, sourceLayer, token };
  });
  const counts = new Map<string, number>();
  for (const { token } of identities) if (token !== undefined) counts.set(token, (counts.get(token) ?? 0) + 1);
  return identities.map(({ featureId, sourceLayer, token }, index) => ({
    overlayId, layer, index,
    ...(featureId !== undefined ? { featureId } : {}),
    ...(sourceLayer !== undefined ? { sourceLayer } : {}),
    ...(token !== undefined && counts.get(token) === 1 ? { featureKey: token } : {}),
  }));
}

/** Selection identity inside this overlay. Legacy projects keep their recorded index. */
export function featureSourceKey(source: Pick<FeatureSource, 'overlayId' | 'index' | 'featureKey'>): string {
  return `${source.overlayId}:${source.featureKey ?? source.index}`;
}
