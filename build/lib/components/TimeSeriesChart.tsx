import { useEffect, useState, useCallback } from 'react';
import { Chart as ChartJS, TimeScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, InteractionItem } from 'chart.js';
import { Line } from 'react-chartjs-2';
import 'chartjs-adapter-date-fns';
import { useAppContext } from '../context/AppContext';
import { useApi } from '../hooks/useApi';
import { MultiPointTimeSeriesData } from '../types';

// Register Chart.js components
ChartJS.register(TimeScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

export default function TimeSeriesChart() {
  const { state, dispatch } = useAppContext();
  const { fetchMultiPointTimeSeries } = useApi();
  const [chartData, setChartData] = useState<MultiPointTimeSeriesData | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const updateChart = useCallback(async () => {
    if (!state.showChart || !state.currentDataset || state.timeSeriesPoints.length === 0) {
      setChartData(null);
      return;
    }

    setIsLoading(true);
    const currentDatasetInfo = state.datasetInfo[state.currentDataset];

    // Filter visible points
    const visiblePoints = state.timeSeriesPoints.filter(p => p.visible);

    if (visiblePoints.length === 0) {
      setChartData(null);
      setIsLoading(false);
      return;
    }

    try {
      // Format points for API
      const apiPoints = visiblePoints.map(point => ({
        id: point.id,
        lat: point.position[0],
        lon: point.position[1],
        color: point.color,
        name: point.name,
      }));

      // Fetch multi-point data
      let refLon, refLat;
      if (currentDatasetInfo?.uses_spatial_ref) {
        [refLat, refLon] = state.refMarkerPosition;
      }

      const tsData = await fetchMultiPointTimeSeries(
        apiPoints,
        state.currentDataset,
        refLon,
        refLat,
        state.showTrends
      );

      if (tsData) {
        setChartData(tsData);

        // Update trend data in state only if trends are being calculated
        if (state.showTrends && tsData.datasets) {
          // Use setTimeout to avoid re-render loop during state updates
          setTimeout(() => {
            tsData.datasets.forEach(dataset => {
              if (dataset.trend) {
                dispatch({
                  type: 'SET_POINT_TREND_DATA',
                  payload: {
                    pointId: dataset.pointId,
                    dataset: state.currentDataset,
                    trend: {
                      slope: dataset.trend.slope,
                      intercept: dataset.trend.intercept,
                      rSquared: dataset.trend.rSquared,
                      mmPerYear: dataset.trend.mmPerYear,
                    },
                  },
                });
              }
            });
          }, 0);
        }
      }
    } catch (error) {
      console.error('Error updating chart:', error);
    } finally {
      setIsLoading(false);
    }
  }, [
    state.showChart,
    state.currentDataset,
    JSON.stringify(state.timeSeriesPoints.map(p => ({ id: p.id, position: p.position, visible: p.visible }))), // Only track relevant point changes
    state.refMarkerPosition,
    state.datasetInfo,
    state.showTrends,
    fetchMultiPointTimeSeries,
  ]);

  useEffect(() => {
    updateChart();
  }, [
    updateChart,
  ]);

  const handleChartClick = useCallback((_event: any, elements: InteractionItem[]) => {
    if (elements.length === 0 || !chartData) return;

    const element = elements[0];
    const dataIndex = element.index;

    // Update the current time index to sync with the clicked point
    if (dataIndex !== undefined && dataIndex < chartData.labels.length) {
      dispatch({ type: 'SET_TIME_INDEX', payload: dataIndex });
    }
  }, [chartData, dispatch]);

  const handleExportToCSV = useCallback(() => {
    if (!chartData || !chartData.datasets || chartData.datasets.length === 0) return;

    // Build CSV header
    const headers = ['Time', ...chartData.datasets.map(d => d.label)];

    // Build data rows
    const rows: string[][] = [];
    chartData.labels.forEach((label, idx) => {
      const row = [label];
      chartData.datasets.forEach(dataset => {
        const dataPoint = dataset.data[idx];
        row.push(dataPoint ? dataPoint.y.toString() : '');
      });
      rows.push(row);
    });

    // Add trend information if available
    const trendRows: string[][] = [];
    if (state.showTrends && chartData.datasets.some(d => d.trend)) {
      trendRows.push(['']); // Empty row separator
      trendRows.push(['Point', 'Rate (mm/year)', 'R²', 'Slope', 'Intercept']);
      chartData.datasets.forEach(dataset => {
        if (dataset.trend) {
          trendRows.push([
            dataset.label,
            dataset.trend.mmPerYear.toFixed(6),
            dataset.trend.rSquared.toFixed(6),
            dataset.trend.slope.toFixed(6),
            dataset.trend.intercept.toFixed(6),
          ]);
        }
      });
    }

    // Combine all rows and convert to CSV
    const allRows = [headers, ...rows, ...trendRows];
    const csvContent = allRows.map(row => row.join(',')).join('\n');

    // Create and trigger download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    link.setAttribute('href', url);
    link.setAttribute('download', `time-series-${state.currentDataset}-${timestamp}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [chartData, state.showTrends, state.currentDataset]);

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: {
      duration: 300,
    },
    interaction: {
      mode: 'index' as const,
      intersect: false,
    },
    plugins: {
      legend: {
        display: true,
        position: 'top' as const,
        labels: {
          usePointStyle: true,
          padding: 20,
          generateLabels: (_chart: any) => {
            if (!chartData?.datasets) return [];

            return chartData.datasets.map((dataset, index) => ({
              text: `${dataset.label}${dataset.trend && dataset.trend.mmPerYear !== undefined ? ` (${dataset.trend.mmPerYear.toFixed(1)} mm/yr)` : ''}`,
              pointStyle: 'circle' as const,
              fillStyle: dataset.borderColor,
              strokeStyle: dataset.borderColor,
              lineWidth: 2,
              datasetIndex: index,
            }));
          },
        },
      },
      tooltip: {
        callbacks: {
          title: (context: any) => {
            return `Time: ${context[0]?.label || ''}`;
          },
          label: (context: any) => {
            const dataset = chartData?.datasets?.[context.datasetIndex];
            if (!dataset) return '';

            let label = `${dataset.label}: ${context.parsed.y.toFixed(3)}`;

            if (dataset.trend && dataset.trend.mmPerYear !== undefined && state.showTrends) {
              label += ` (${dataset.trend.mmPerYear.toFixed(1)} mm/yr)`;
            }

            return label;
          },
        },
      },
    },
    scales: {
      x: {
        type: 'time' as const,
        time: {
          displayFormats: {
            month: 'MMM yyyy',
            year: 'yyyy',
          },
        },
        title: {
          display: true,
          text: 'Time',
        },
      },
      y: {
        title: {
          display: true,
          text: 'Displacement (m)',
        },
        suggestedMin: state.vmin,
        suggestedMax: state.vmax,
      },
    },
    onClick: handleChartClick,
  };

  if (!state.showChart) {
    return null;
  }

  if (state.timeSeriesPoints.length === 0) {
    return (
      <div id="chart-container">
        <div className="chart-placeholder">
          <p>No time series points selected.</p>
          <p><small>Click on the map to add points.</small></p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div id="chart-container">
        <div className="chart-placeholder">
          <p>Loading time series data...</p>
        </div>
      </div>
    );
  }

  if (!chartData || !chartData.datasets || chartData.datasets.length === 0) {
    return (
      <div id="chart-container">
        <div className="chart-placeholder">
          <p>No data available for selected points.</p>
        </div>
      </div>
    );
  }

  // Format data for Chart.js
  const formattedChartData = {
    labels: chartData.labels,
    datasets: chartData.datasets.map(dataset => ({
      label: dataset.label,
      data: dataset.data,
      borderColor: dataset.borderColor,
      backgroundColor: dataset.backgroundColor,
      borderWidth: 2,
      pointRadius: 3,
      pointHoverRadius: 5,
      tension: 0.1,
      fill: false,
    })),
  };

  return (
    <div id="chart-container">
      <div className="chart-header">
        <h4>Time Series Analysis</h4>
        <div className="chart-controls">
          <button
            className="pure-button"
            onClick={() => dispatch({ type: 'TOGGLE_TRENDS' })}
            title="Toggle trend analysis"
          >
            <i className={`fa-solid ${state.showTrends ? 'fa-chart-line' : 'fa-chart-simple'}`}></i>
            {state.showTrends ? 'Hide' : 'Show'} Trends
          </button>
          <button
            className="pure-button"
            onClick={handleExportToCSV}
            title="Export data to CSV"
          >
            <i className="fa-solid fa-download"></i>
            Export CSV
          </button>
        </div>
      </div>
      <div className="chart-content">
        <Line data={formattedChartData} options={chartOptions} />
      </div>
      <div className="chart-help">
        <small>Click on chart points to sync map time • Trends show mm/year rates</small>
      </div>
    </div>
  );
}
