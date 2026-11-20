import { useEffect, useState } from 'react';

type Support = 'enabled' | 'disabled' | 'unknown';

/** Whether this server reads uploaded GeoTIFF masks (bowser-lite's /config says it does not). */
export function uploadedMaskSupport(): Promise<Support> {
  return fetch('/config').then(async response => {
    if (!response.ok) throw new Error('Configuration unavailable');
    return response.json();
  }).then(config => (config.geotiff_upload === false ? 'disabled' : 'enabled') as Support)
    .catch(() => 'unknown' as const);
}

/** Imported full-server projects must not break charts on a lightweight server. */
export function useUploadedChartMaskSupport(active: boolean) {
  const [status, setStatus] = useState<'checking' | Support>('checking');
  useEffect(() => {
    if (!active) { setStatus('checking'); return; }
    let live = true;
    void uploadedMaskSupport().then(support => { if (live) setStatus(support); });
    return () => { live = false; };
  }, [active]);
  return {
    ready: !active || status !== 'checking',
    enabled: !active || status === 'enabled',
    warning: !active || status === 'enabled' || status === 'checking' ? null
      : status === 'disabled'
        ? 'Uploaded mask not applied: this server cannot read GeoTIFF masks. Charts use the remaining quality masks.'
        : 'Uploaded mask not applied: server support could not be checked. Charts use the remaining quality masks.',
  };
}
