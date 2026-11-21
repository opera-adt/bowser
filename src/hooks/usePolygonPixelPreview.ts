import { useEffect, useMemo, useState } from 'react';
import type { ChartArea, LayerMask, RasterGroup } from '../types';
import { useUploadedChartMaskSupport } from './useUploadedChartMaskSupport';
import { useApi } from './useApi';
import { useSpacedEffect, REQUEST_GAP_MS } from './useSpacedEffect';
import { chartMaskOptions, type ChartMaskOptions } from '../utils/chartMasks';
import { applicableMasks } from '../utils/maskCompatibility';
import { checkedPixelPreview, type PixelPreview, type PixelPreviewOptions } from '../utils/polygonPixelPreview';

export interface PixelPreviewSelection extends PixelPreviewOptions { areaId: string; dataset: string }
interface Props { areas: ChartArea[]; layers: string[]; layerMasks: LayerMask[];
  datasetInfo: Record<string, RasterGroup>; revision: number; enabled: boolean; areaSupport?: 'auto' | 'common' | 'per_date'; customMaskPath: string | null; dataMode: string }
interface Reply { key: string; data?: PixelPreview; error?: string }

/** One opt-in preview per window. References/display dates reuse stored values, never refetch. */
export function usePolygonPixelPreview(p: Props) {
  const [selection, setSelection] = useState<PixelPreviewSelection | null>(null);
  const [reply, setReply] = useState<Reply | null>(null);
  const { fetchPolygonTimeSeries } = useApi();
  const uploadedMask = useUploadedChartMaskSupport(!!p.customMaskPath);
  const area = p.areas.find(a => a.id === selection?.areaId);
  const validSelection = area && selection && p.layers.includes(selection.dataset) ? selection : null;
  const key = p.enabled && uploadedMask.ready && validSelection ? JSON.stringify({
    ...validSelection, support: p.areaSupport === 'common' || p.areaSupport === 'per_date' ? p.areaSupport : undefined, external: chartMaskOptions(p, validSelection.dataset, uploadedMask.enabled), geometry: area!.geometry, revision: p.revision,
    masks: applicableMasks(p.datasetInfo[validSelection.dataset], p.layerMasks),
  }) : '';
  const request = useMemo(() => key ? JSON.parse(key) as PixelPreviewSelection & { geometry: ChartArea['geometry']; masks: LayerMask[]; external: ChartMaskOptions } : null, [key]);
  useEffect(() => { if (selection && !validSelection) setSelection(null); }, [selection, validSelection]);
  useSpacedEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    let live = true;
    const options = { ...request.external, ...(request.support ? { support: request.support } : {}), curve_mode: request.curve_mode, sample_count: request.sample_count };
    if (!Number.isInteger(options.sample_count) || options.sample_count < 1 || options.sample_count > 500) {
      setReply({ key, error: 'Choose a sample size from 1 to 500.' });
      return;
    }
    void fetchPolygonTimeSeries(request.dataset, request.geometry, request.masks, controller.signal, options).then(res => {
      if (!live) return;
      try {
        if ('error' in res) setReply({ key, error: res.error });
        else setReply({ key, data: checkedPixelPreview(res.data, options) });
      } catch (e) { setReply({ key, error: e instanceof Error ? e.message : 'Pixel histories unavailable.' }); }
    }).catch(() => { if (live) setReply({ key, error: 'Could not load pixel histories.' }); });
    return () => { live = false; controller.abort(); };
  }, [request, key, fetchPolygonTimeSeries], REQUEST_GAP_MS);
  const current = key && reply?.key === key ? reply : null;
  return { selection: validSelection, setSelection, data: current?.data,
    error: current?.error, pending: !!request && !current };
}
