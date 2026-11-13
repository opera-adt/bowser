/**
 * The colormaps the picker offers. Tiles are coloured on the server, so every name
 * must exist in rio-tiler (tiles, with its ``_r`` form) and matplotlib (``/colorbar/``).
 */
export interface ColormapOption {
  value: string;
  label: string;
}

const option = (label: string, value = label.toLowerCase()): ColormapOption => ({ value, label });

export const COLORMAP_GROUPS: [string, ColormapOption[]][] = [
  ['Diverging', ['RdBu', 'BrBG', 'RdYlBu', 'PuOr', 'PiYG', 'Spectral', 'Coolwarm'].map(l => option(l))],
  ['Sequential', ['Viridis', 'Plasma', 'Inferno', 'Magma', 'Cividis', 'Gray', 'Blues', 'Greens', 'Reds', 'Oranges', 'Purples', 'YlOrRd', 'YlGnBu', 'YlGn', 'PuBu', 'RdPu', 'BuGn'].map(l => option(l))],
  ['Cyclic', ['Twilight', 'HSV'].map(l => option(l))],
  ['Scientific diverging', [option('Vik · Crameri', 'cmc_vik'), option('Roma · Crameri', 'cmc_roma'), option('Broc · Crameri', 'cmc_broc'), option('Berlin · Crameri', 'cmc_berlin'), option('Bam · Crameri', 'cmc_bam')]],
  ['Scientific sequential', [option('Batlow · Crameri', 'cmc_batlow'), option('Oslo · Crameri', 'cmc_oslo'), option('La Jolla · Crameri', 'cmc_lajolla')]],
  ['Scientific cyclic', [option('Roma (cyclic) · Crameri', 'cmc_romao')]],
  ['Rainbow', ['Turbo', 'Jet'].map(l => option(l))],
  ['Terrain', [option('Earth', 'gist_earth'), option('Ocean'), option('Terrain'), option('CFastie'), option('RPlumbo'), option('Schwarzwald')]],
];

export const COLORMAP_OPTIONS: ColormapOption[] = COLORMAP_GROUPS.flatMap(([, options]) => options);

export const isInverted = (colormap: string): boolean => colormap.endsWith('_r');

export const baseColormap = (colormap: string): string => (isInverted(colormap) ? colormap.slice(0, -2) : colormap);

export const withInvert = (colormap: string, invert: boolean): string => `${baseColormap(colormap)}${invert ? '_r' : ''}`;

export function colormapLabel(colormap: string): string {
  const base = baseColormap(colormap);
  return COLORMAP_OPTIONS.find(o => o.value === base)?.label ?? base;
}
