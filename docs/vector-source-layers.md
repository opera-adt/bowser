# Choosing layers from a geographic file

Small multi-layer GeoPackages are read by the existing full-server converter.
Once ready, the overlay row lists each non-empty source layer and feature count.
All are initially checked. Uncheck unwanted layers, then **Add selected layers**.
Nothing from this collection is drawn, exported or used for polygon statistics
before confirmation. **None** clears the selection; adding an empty selection is
disabled. **Cancel** removes only the pending overlay, never the original file.

Chosen features retain their coordinates, holes, attributes and IDs. Original
properties named layer are not treated as provenance. Choice uses only the
converter's explicit, collision-free source-layer annotation. Incomplete or absent
annotations retain ordinary combined import behavior; no layer names are guessed.
A single source layer needs no extra confirmation. Other small converted formats
with the same annotation use this picker too.

The map, vector exports, identify and zonal tools see the same chosen collection.
Saved projects retain the choice; projects saved before confirmation retain the
pending collection with no active features. Reimport to select different layers.
Existing charts remain their selected geometry snapshots.

The original source and cached conversion remain unchanged. Selection happens
after conversion and does not reduce transfer or disk use. Large PMTiles retain
their existing path and are not native polygon-analysis inputs. This picker
changes no conversion, reprojection, missing-CRS policy, raster mask, reference
or measurement calculation.
