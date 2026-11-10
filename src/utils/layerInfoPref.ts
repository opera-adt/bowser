/**
 * Whether the Layers section shows each layer's description note (the (i) button
 * beside "Layers"). Shown unless this viewer hid it; kept per browser.
 */
export const LAYER_INFO_KEY = 'bowser-layer-info';

export function readLayerInfoShown(): boolean {
  try {
    return localStorage.getItem(LAYER_INFO_KEY) !== 'hidden';
  } catch {
    return true;
  }
}

export function saveLayerInfoShown(shown: boolean): void {
  try {
    if (shown) localStorage.removeItem(LAYER_INFO_KEY);
    else localStorage.setItem(LAYER_INFO_KEY, 'hidden');
  } catch { /* this session only */ }
}
