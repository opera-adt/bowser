import { useCallback } from 'react';
import { MultiPointTimeSeriesData, LayerMask, ChartArea } from '../types';
import { polygonErrorMessage, polygonRequestBody, type PolygonTimeSeries } from '../utils/polygonSeries';

/**
 * Read `?dataset=<id>` from the current URL.
 *
 * Used to route all API calls at the catalog-registered dataset the user
 * picked (or the default when absent). Two clients on two datasets never
 * share server-side state because the dataset id travels on every request.
 */
function currentDatasetId(): string | null {
  return new URLSearchParams(window.location.search).get('dataset');
}

/**
 * Append `dataset=<id>` to an URLSearchParams when one is set.
 */
export function withDataset(params: URLSearchParams): URLSearchParams {
  const id = currentDatasetId();
  if (id) params.set('dataset', id);
  return params;
}

/** URL for a dataset's value range (colour limits, mask sliders), routed like every call. */
export function datasetRangeUrl(datasetName: string): string {
  const qs = withDataset(new URLSearchParams()).toString();
  const base = `/dataset_range/${encodeURIComponent(datasetName)}`;
  return qs ? `${base}?${qs}` : base;
}

export function useApi() {
  const fetchDatasets = useCallback(async () => {
    const url = `/datasets?${withDataset(new URLSearchParams())}`;
    const response = await fetch(url);
    return await response.json();
  }, []);

  const fetchDataMode = useCallback(async () => {
    const response = await fetch('/mode');
    const data = await response.json();
    return data.mode;
  }, []);

  const fetchConfig = useCallback(async (): Promise<{ title: string; opera_logo?: boolean; assistant?: { page_channel?: boolean }; overlay_files?: string[] }> => {
    const response = await fetch('/config');
    return await response.json();
  }, []);

  const fetchPointTimeSeries = useCallback(async (lon: number, lat: number, datasetName: string) => {
    const params = withDataset(new URLSearchParams({
      dataset_name: datasetName,
      lon: lon.toString(),
      lat: lat.toString(),
    }));

    try {
      const response = await fetch(`/point?${params}`);
      return await response.json();
    } catch (error) {
      console.error('Error fetching point time series:', error);
      return undefined;
    }
  }, []);

  const fetchChartTimeSeries = useCallback(async (
    lon: number,
    lat: number,
    datasetName: string,
    refLon?: number,
    refLat?: number
  ) => {
    const params: Record<string, string> = {
      lon: lon.toString(),
      lat: lat.toString(),
      dataset_name: datasetName,
    };

    if (refLon !== undefined && refLat !== undefined) {
      params.ref_lat = refLat.toString();
      params.ref_lon = refLon.toString();
    }

    const urlParams = withDataset(new URLSearchParams(params));

    try {
      const response = await fetch(`/chart_point?${urlParams}`);
      return await response.json();
    } catch (error) {
      console.error('Error fetching chart time series:', error);
      return undefined;
    }
  }, []);

  const fetchMultiPointTimeSeries = useCallback(async (
    points: Array<{ id: string; lat: number; lon: number; color: string; name: string }>,
    datasetName: string,
    refLon?: number,
    refLat?: number,
    calculateTrends: boolean = false,
    layerMasks: LayerMask[] = [],
    refBufferM: number = 0,
  ): Promise<MultiPointTimeSeriesData | undefined> => {
    const payload = {
      points,
      dataset_name: datasetName,
      ref_lon: refLon,
      ref_lat: refLat,
      calculate_trends: calculateTrends,
      layer_masks: layerMasks.map(m => ({ dataset: m.dataset, threshold: m.threshold, mode: m.mode })),
      ref_buffer_m: refBufferM,
    };

    try {
      const id = currentDatasetId();
      const url = id ? `/multi_point?dataset=${encodeURIComponent(id)}` : '/multi_point';
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      return await response.json();
    } catch (error) {
      console.error('Error fetching multi-point time series:', error);
      return undefined;
    }
  }, []);

  const fetchTrendAnalysis = useCallback(async (
    lon: number,
    lat: number,
    datasetName: string,
    refLon?: number,
    refLat?: number
  ) => {
    const params: Record<string, string> = {
      lon: lon.toString(),
      lat: lat.toString(),
    };

    if (refLon !== undefined && refLat !== undefined) {
      params.ref_lat = refLat.toString();
      params.ref_lon = refLon.toString();
    }

    const urlParams = withDataset(new URLSearchParams(params));

    try {
      const response = await fetch(`/trend_analysis/${datasetName}?${urlParams}`);
      return await response.json();
    } catch (error) {
      console.error('Error fetching trend analysis:', error);
      return undefined;
    }
  }, []);

  const fetchTimeBounds = useCallback(async (datasetName: string) => {
    try {
      const params = withDataset(new URLSearchParams());
      const qs = params.toString();
      const url = qs ? `/datasets/${datasetName}/time_bounds?${qs}` : `/datasets/${datasetName}/time_bounds`;
      const response = await fetch(url);
      return await response.json();
    } catch (error) {
      console.error('Error fetching time bounds:', error);
      return undefined;
    }
  }, []);

  const fetchBufferTimeSeries = useCallback(async (
    lon: number,
    lat: number,
    datasetName: string,
    bufferM: number,
    nSamples: number,
    refLon?: number,
    refLat?: number,
    layerMasks: LayerMask[] = [],
    refBufferM: number = 0,
  ) => {
    try {
      const id = currentDatasetId();
      const url = id ? `/buffer_timeseries?dataset=${encodeURIComponent(id)}` : '/buffer_timeseries';
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lon, lat,
          dataset_name: datasetName,
          buffer_m: bufferM,
          n_samples: nSamples,
          ref_lon: refLon ?? null,
          ref_lat: refLat ?? null,
          layer_masks: layerMasks.map(m => ({ dataset: m.dataset, threshold: m.threshold, mode: m.mode })),
          ref_buffer_m: refBufferM,
        }),
      });
      if (!response.ok) return undefined;
      return await response.json();
    } catch (error) {
      console.error('Error fetching buffer time series:', error);
      return undefined;
    }
  }, []);

  /** Statistics of a layer inside a polygon; an error is a short message. */
  const fetchPolygonTimeSeries = useCallback(async (
    datasetName: string,
    geometry: ChartArea['geometry'],
  ): Promise<{ data: PolygonTimeSeries } | { error: string }> => {
    try {
      const qs = withDataset(new URLSearchParams()).toString();
      const response = await fetch(qs ? `/polygon_timeseries?${qs}` : '/polygon_timeseries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(polygonRequestBody(datasetName, geometry)),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) return { error: polygonErrorMessage(response.status, body) };
      return { data: body as PolygonTimeSeries };
    } catch (error) {
      console.error('Error fetching polygon statistics:', error);
      return { error: 'could not reach the server' };
    }
  }, []);

  return {
    fetchDatasets,
    fetchDataMode,
    fetchConfig,
    fetchPointTimeSeries,
    fetchChartTimeSeries,
    fetchMultiPointTimeSeries,
    fetchTrendAnalysis,
    fetchTimeBounds,
    fetchBufferTimeSeries,
    fetchPolygonTimeSeries,
    currentDatasetId,
  };
}
