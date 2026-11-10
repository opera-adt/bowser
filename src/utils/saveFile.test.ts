import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataUrlToBlob, saveFile } from './saveFile';

afterEach(() => {
  delete (window as { pywebview?: unknown }).pywebview;
  vi.restoreAllMocks();
});

describe('saveFile', () => {
  it('uses the desktop app’s Save dialog when it is there, not a download link', async () => {
    const save_file = vi.fn().mockResolvedValue('/Users/me/project.json');
    window.pywebview = { api: { pick_folder: vi.fn(), save_file } };
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');

    const ok = await saveFile(new Blob(['{"a": 1}'], { type: 'application/json' }), 'project.json');

    expect(ok).toBe(true);
    expect(click).not.toHaveBeenCalled();
    expect(save_file).toHaveBeenCalledWith('project.json', btoa('{"a": 1}'));
  });

  it('reports a cancelled Save dialog', async () => {
    window.pywebview = { api: { pick_folder: vi.fn(), save_file: vi.fn().mockResolvedValue(null) } };
    expect(await saveFile(new Blob(['x']), 'x.txt')).toBe(false);
  });

  it('downloads through a link in a browser', async () => {
    URL.createObjectURL ??= () => 'blob:x';
    URL.revokeObjectURL ??= () => undefined;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('layer.geojson');
    });

    expect(await saveFile(new Blob(['{}']), 'layer.geojson')).toBe(true);
    expect(click).toHaveBeenCalledOnce();
  });

  it('accepts a data URL, as canvas screenshots give', async () => {
    const save_file = vi.fn().mockResolvedValue('/tmp/chart.png');
    window.pywebview = { api: { pick_folder: vi.fn(), save_file } };
    await saveFile(`data:image/png;base64,${btoa('PNGDATA')}`, 'chart.png');
    expect(save_file).toHaveBeenCalledWith('chart.png', btoa('PNGDATA'));
  });
});

describe('dataUrlToBlob', () => {
  it('keeps the type and bytes of a base64 data URL', async () => {
    const blob = dataUrlToBlob(`data:image/png;base64,${btoa('abc')}`);
    expect(blob.type).toBe('image/png');
    const text = await new Promise<string>(resolve => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsText(blob);
    });
    expect(text).toBe('abc');
  });
});
