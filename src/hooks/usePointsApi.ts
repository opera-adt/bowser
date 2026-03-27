import { useCallback } from 'react';
import { tableFromIPC } from 'apache-arrow';

export interface PointLayerInfo {
  default_color_by: string;
  default_colormap: string;
  default_vmin: number | null;
  default_vmax: number | null;
}

export interface PointAttributes {
  layer: string;
  attributes: Record<string, {
    type: string;
    min?: number;
    max?: number;
    mean?: number;
    count?: number;
  }>;
}

export interface PointTimeSeriesEntry {
  date: string;
  displacement: number;
}

export interface PointData {
  point_id: number[];
  lon: number[];
  lat: number[];
  colorValues: number[];
  count: number;
}

export function usePointsApi() {
  const fetchPointLayers = useCallback(async (): Promise<Record<string, PointLayerInfo>> => {
    const response = await fetch('/points/layers');
    if (!response.ok) throw new Error(`${response.status}`);
    return await response.json();
  }, []);

  const fetchPointAttributes = useCallback(async (layerName: string): Promise<PointAttributes> => {
    const response = await fetch(`/points/${layerName}/attributes`);
    if (!response.ok) throw new Error(`${response.status}`);
    return await response.json();
  }, []);

  const fetchPoints = useCallback(async (
    layerName: string,
    opts: {
      bbox?: [number, number, number, number];
      colorBy?: string;
      filter?: string;
      maxPoints?: number;
    } = {}
  ): Promise<PointData> => {
    const params = new URLSearchParams();
    if (opts.bbox) {
      params.set('bbox', opts.bbox.join(','));
    }
    if (opts.colorBy) {
      params.set('color_by', opts.colorBy);
    }
    if (opts.filter) {
      params.set('filter', opts.filter);
    }
    if (opts.maxPoints) {
      params.set('max_points', opts.maxPoints.toString());
    }

    const response = await fetch(`/points/${layerName}?${params}`);
    if (!response.ok) throw new Error(`${response.status}`);
    const buffer = await response.arrayBuffer();
    const table = tableFromIPC(new Uint8Array(buffer));

    const pointIds = table.getChild('point_id')!;
    const lons = table.getChild('lon')!;
    const lats = table.getChild('lat')!;
    // The 4th column is the color_by attribute
    const colorCol = table.schema.fields[3];
    const colorValues = table.getChild(colorCol.name)!;

    return {
      point_id: Array.from(pointIds),
      lon: Array.from(lons),
      lat: Array.from(lats),
      colorValues: Array.from(colorValues),
      count: table.numRows,
    };
  }, []);

  const fetchPointTimeseries = useCallback(async (
    layerName: string,
    pointId: number,
  ): Promise<PointTimeSeriesEntry[]> => {
    const response = await fetch(`/points/${layerName}/${pointId}/timeseries`);
    return await response.json();
  }, []);

  const fetchMultiPointTimeseries = useCallback(async (
    layerName: string,
    pointIds: number[],
  ): Promise<Record<string, PointTimeSeriesEntry[]>> => {
    const response = await fetch(`/points/${layerName}/timeseries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ point_ids: pointIds }),
    });
    const data = await response.json();
    return data.series;
  }, []);

  const fetchPointStats = useCallback(async (
    layerName: string,
    bbox?: [number, number, number, number],
  ): Promise<Record<string, number>> => {
    const params = new URLSearchParams();
    if (bbox) {
      params.set('bbox', bbox.join(','));
    }
    const response = await fetch(`/points/${layerName}/stats?${params}`);
    return await response.json();
  }, []);

  return {
    fetchPointLayers,
    fetchPointAttributes,
    fetchPoints,
    fetchPointTimeseries,
    fetchMultiPointTimeseries,
    fetchPointStats,
  };
}
