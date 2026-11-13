# Scientific color palettes

The color-scale picker includes nine additional Scientific colour maps by
Fabio Crameri, with an **Invert** option for each:

- **Sequential:** Batlow, Oslo and La Jolla, for ordered values such as elevation,
  motion magnitude or quality scores.
- **Diverging:** Vik, Roma, Broc, Berlin and Bam, for signed quantities. Choose a
  meaningful range and midpoint when comparing positive and negative values.
- **Cyclic:** Roma (cyclic), for values whose endpoints meet, such as aspect or
  wrapped phase. The color choice does not change a layer's range or wrap it.

These are optional display choices. Existing palettes and initial defaults stay
unchanged. Changing or reversing a palette does not alter displacement, units,
reference points, quality masks, velocity estimates or exported numeric rasters.

## Shared colors and attribution

Full-server tiles, lightweight tiles and the experimental GPU renderer use the
same rounded 256-entry RGBA tables. Reversed palettes are the exact reversed
bytes. The internal names have a `cmc_` prefix, such as `cmc_vik` and
`cmc_vik_r`, to avoid replacing another package's palettes. Colorbar previews
use those tables too; the full server retains its existing matplotlib/WebP
preview rendering, while lite returns PNG. Encoded preview images are not
expected to have identical bytes across those existing rendering paths.

The original RGB text tables are bundled under `bowser/palettes/crameri`, from
[cmcrameri](https://github.com/callumrollo/cmcrameri) revision
`87197e141a2c451691ec53fadc6da4d017f79a4c`. `SOURCES.json` records the exact
source URLs and SHA-256 checksums; tables are verified before conversion to
uint8 by nearest-integer rounding. No runtime download or cmcrameri installation
is required. The original MIT license and copyrights are included alongside the
tables. Credit: [Fabio Crameri's Scientific colour maps](https://www.fabiocrameri.ch/colourmaps/).

The original lite `colormaps.npz` is unchanged; the licensed tables extend its
catalog. After changing the picker or these tables, regenerate browser textures:

```bash
PYTHONPATH=src python scripts/build_gpu_colormaps.py
```

Palette tests compare every full/lite/GPU lookup-table byte, native PNG tile
colors and nodata alpha, reversal, source checksums and unchanged quantitative
exports. They also retain lightweight dependency isolation. Palettes improve
display choices; they do not establish whether a motion measurement is reliable.
