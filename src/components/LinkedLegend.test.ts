import { describe, expect, it } from 'vitest';
import type { Chart as ChartJS } from 'chart.js';
import { linkedLegendPlugin } from './TimeSeriesChart';

// A stand-in for a Chart.js chart: enough for the legend click and the linked-visibility plugin.
function fakeChart() {
  const datasets = [
    { label: 'Point pt1', _baseLabel: 'Point pt1' },
    { label: 'Point pt1 trend', _baseLabel: 'Point pt1' },
    { label: 'Point pt2', _baseLabel: 'Point pt2' },
  ];
  const metas = datasets.map(() => ({ hidden: null as boolean | null }));
  const chart = {
    data: { datasets },
    options: { plugins: { legend: {} as Record<string, unknown> } },
    getDatasetMeta: (i: number) => metas[i],
    isDatasetVisible: (i: number) => metas[i].hidden !== true,
    hide: (i: number) => { metas[i].hidden = true; },
    show: (i: number) => { metas[i].hidden = false; },
    update: () => {},
  };
  const click = (i: number) => {
    const onClick = chart.options.plugins.legend.onClick as (e: unknown, item: unknown, legend: unknown) => void;
    onClick.call({ chart }, {}, { datasetIndex: i }, { chart });
  };
  return { chart, metas, click, asChart: chart as unknown as ChartJS };
}

describe('linked legend', () => {
  it("hides a point's model with the point", () => {
    const { metas, click, asChart } = fakeChart();
    linkedLegendPlugin.afterInit(asChart);
    click(0);
    expect(metas.map(m => m.hidden === true)).toEqual([true, true, false]);
    click(0);
    expect(metas.map(m => m.hidden === true)).toEqual([false, false, false]);
  });

  it('still links them after the chart gets new options', () => {
    const { chart, metas, click, asChart } = fakeChart();
    linkedLegendPlugin.afterInit(asChart);
    // react-chartjs-2 replaces the options object when the options change
    chart.options = { plugins: { legend: {} } };
    linkedLegendPlugin.beforeUpdate(asChart);
    click(0);
    expect(metas.map(m => m.hidden === true)).toEqual([true, true, false]);
  });

  it('wraps the handler only once across updates', () => {
    const { chart, asChart } = fakeChart();
    linkedLegendPlugin.afterInit(asChart);
    const first = chart.options.plugins.legend.onClick;
    linkedLegendPlugin.beforeUpdate(asChart);
    expect(chart.options.plugins.legend.onClick).toBe(first);
  });
});
