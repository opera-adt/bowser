import { useCallback } from 'react';
import { MultiPointTimeSeriesData } from '../types';

export function useApi() {
  const fetchDatasets = useCallback(async () => {
    const response = await fetch('/datasets');
    return await response.json();
  }, []);

  const fetchDataMode = useCallback(async () => {
    const response = await fetch('/mode');
    const data = await response.json();
    return data.mode;
  }, []);

  const fetchPointTimeSeries = useCallback(async (lon: number, lat: number, datasetName: string) => {
    const params = new URLSearchParams({
      dataset_name: datasetName,
      lon: lon.toString(),
      lat: lat.toString(),
    });

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

    const urlParams = new URLSearchParams(params);

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
    calculateTrends: boolean = false
  ): Promise<MultiPointTimeSeriesData | undefined> => {
    const payload = {
      points,
      dataset_name: datasetName,
      ref_lon: refLon,
      ref_lat: refLat,
      calculate_trends: calculateTrends,
    };

    try {
      const response = await fetch('/multi_point', {
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

    const urlParams = new URLSearchParams(params);

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
      const response = await fetch(`/datasets/${datasetName}/time_bounds`);
      return await response.json();
    } catch (error) {
      console.error('Error fetching time bounds:', error);
      return undefined;
    }
  }, []);

  return {
    fetchDatasets,
    fetchDataMode,
    fetchPointTimeSeries,
    fetchChartTimeSeries,
    fetchMultiPointTimeSeries,
    fetchTrendAnalysis,
    fetchTimeBounds,
  };
}
