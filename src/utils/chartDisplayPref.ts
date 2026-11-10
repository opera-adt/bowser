/**
 * Whether the chart's "Display options" (marker size, date range, y offsets and limits) are
 * open. Folded unless this viewer opened them; kept per browser.
 */
export const CHART_DISPLAY_KEY = 'bowser-chart-display';

export function readChartDisplayOpen(): boolean {
  try {
    return localStorage.getItem(CHART_DISPLAY_KEY) === 'open';
  } catch {
    return false;
  }
}

export function saveChartDisplayOpen(open: boolean): void {
  try {
    if (open) localStorage.setItem(CHART_DISPLAY_KEY, 'open');
    else localStorage.removeItem(CHART_DISPLAY_KEY);
  } catch { /* this session only */ }
}
