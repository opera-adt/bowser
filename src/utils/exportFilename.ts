/** Prefer the server's name: it knows the actual slice, dates, and applied masks. */
export function exportFilename(disposition: string | null, layer: string): string {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition?.match(/filename="([^"]+)"/i)?.[1]
    ?? disposition?.match(/filename=([^;]+)/i)?.[1];
  let candidate = plain;
  try {
    if (encoded) candidate = decodeURIComponent(encoded);
  } catch { /* A malformed header falls back to a safe layer name. */ }
  const sanitize = (value: string) => value.replace(/[^0-9A-Za-z._-]+/g, '-').replace(/^[._-]+/, '').slice(0, 160);
  const safe = candidate && !/[\\/\r\n]/.test(candidate) ? sanitize(candidate) : '';
  if (safe && /\.tif$/i.test(safe)) return safe;
  return `${sanitize(layer).slice(0, 80) || 'layer'}.tif`;
}
