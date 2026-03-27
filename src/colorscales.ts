// Color scale functions for point cloud visualization.
// Each function maps a normalized t in [0, 1] to [R, G, B, A].

type RGBA = [number, number, number, number];

// Interpolate between color stops
function interpolateStops(
  t: number,
  stops: Array<[number, number, number]>,
): RGBA {
  const n = stops.length - 1;
  const idx = Math.min(Math.floor(t * n), n - 1);
  const local = (t * n) - idx;
  const a = stops[idx];
  const b = stops[idx + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * local),
    Math.round(a[1] + (b[1] - a[1]) * local),
    Math.round(a[2] + (b[2] - a[2]) * local),
    220,
  ];
}

const COLORMAP_STOPS: Record<string, Array<[number, number, number]>> = {
  rdbu_r: [
    [33, 102, 172],   // blue (low)
    [146, 197, 222],
    [247, 247, 247],  // white (mid)
    [214, 96, 77],
    [178, 24, 43],    // red (high)
  ],
  viridis: [
    [68, 1, 84],
    [59, 82, 139],
    [33, 145, 140],
    [94, 201, 98],
    [253, 231, 37],
  ],
  plasma: [
    [13, 8, 135],
    [126, 3, 168],
    [204, 71, 120],
    [248, 149, 64],
    [240, 249, 33],
  ],
  inferno: [
    [0, 0, 4],
    [87, 16, 110],
    [188, 55, 84],
    [249, 142, 9],
    [252, 255, 164],
  ],
  coolwarm: [
    [59, 76, 192],
    [141, 176, 254],
    [221, 221, 221],
    [245, 152, 105],
    [180, 4, 38],
  ],
};

export const COLORMAP_NAMES = Object.keys(COLORMAP_STOPS);

export function valueToColor(
  value: number,
  vmin: number,
  vmax: number,
  colormap: string = 'rdbu_r',
): RGBA {
  const t = Math.max(0, Math.min(1, (value - vmin) / (vmax - vmin || 1)));
  const stops = COLORMAP_STOPS[colormap] || COLORMAP_STOPS.rdbu_r;
  return interpolateStops(t, stops);
}

// Generate CSS gradient string for the colorbar
export function colormapGradientCSS(colormap: string = 'rdbu_r'): string {
  const stops = COLORMAP_STOPS[colormap] || COLORMAP_STOPS.rdbu_r;
  const cssStops = stops.map((s, i) => {
    const pct = (i / (stops.length - 1)) * 100;
    return `rgb(${s[0]},${s[1]},${s[2]}) ${pct}%`;
  });
  return `linear-gradient(to right, ${cssStops.join(', ')})`;
}
