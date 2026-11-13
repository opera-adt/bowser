# Updating a GNSS comparison

The InSAR curve at a selected GNSS station follows the current comparison layer,
named quality masks, reference enabled/disabled state, reference position and
reference radius. Changing those settings requests a fresh InSAR history. It
clears the earlier curve while waiting, reports an unavailable comparison on
failure, and ignores replies belonging to earlier settings.

The station's GNSS observations load separately. Changing InSAR settings does
not reload that record; selecting a different station or replacing a custom
station still loads the appropriate record. A request with no usable InSAR
observations can still display the GNSS history alone.

This repair changes request lifecycle and chart freshness only. It does not
change LOS projection, units, temporal alignment, reference offsets, sample
selection, or GNSS/remote-sensing measurements. It does not add support for
configured/uploaded masks or resolve the separate full/lite quality-mask issues.
