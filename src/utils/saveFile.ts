/**
 * Save a file the user asked for: a CSV, a project, a GeoTIFF, a layer, a PNG.
 *
 * In a browser this is a download link. Inside the desktop app, the window
 * (pywebview) cannot follow download links: Windows ignored them, and macOS
 * replaced the page with the file, with no way back. There the app's native
 * Save dialog writes the file instead (`window.pywebview.api.save_file`).
 */

/** Read a Blob as base64, without the `data:...;base64,` prefix. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Turn a `data:` URL (e.g. from canvas.toDataURL) into a Blob. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(',', 2);
  const type = /data:([^;,]+)/.exec(head)?.[1] ?? 'application/octet-stream';
  if (!head.includes(';base64')) return new Blob([decodeURIComponent(body)], { type });
  const bytes = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  return new Blob([bytes], { type });
}

/**
 * Save `data` as `filename`. Resolves to false if the user cancelled the
 * app's Save dialog; a browser download always resolves to true.
 */
export async function saveFile(data: Blob | string, filename: string): Promise<boolean> {
  const blob = typeof data === 'string' ? dataUrlToBlob(data) : data;
  const api = window.pywebview?.api;
  if (api?.save_file) {
    const path = await api.save_file(filename, await blobToBase64(blob));
    return path != null;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return true;
}
