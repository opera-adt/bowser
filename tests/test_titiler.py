"""Tests for bowser.titiler date formatting and reference date detection."""

from datetime import datetime

import pytest


class TestRasterGroupReferenceDate:
    """Test reference_date via the integration test data.

    Uses the displacement COG files in tests/data/geotiffs/ which have
    filenames like displacement_20160708_20160801.tif (shared ref date).
    """

    @pytest.fixture()
    def raster_group_shared_ref(self):
        """RasterGroup with a shared reference date across all files."""
        from pathlib import Path

        from bowser.titiler import RasterGroup

        data_dir = Path(__file__).parent / "data/geotiffs"
        disp_files = sorted(data_dir.glob("displacement_*.tif"))
        assert len(disp_files) > 1, "Need displacement test files"

        rg = RasterGroup(
            name="test_displacement",
            file_list=[str(f) for f in disp_files],
            file_date_fmt="%Y%m%d",
        )
        return rg

    @pytest.fixture()
    def raster_group_no_dates(self):
        """RasterGroup with date parsing disabled."""
        from pathlib import Path

        from bowser.titiler import RasterGroup

        data_dir = Path(__file__).parent / "data/geotiffs"
        disp_file = sorted(data_dir.glob("displacement_*.tif"))[0]

        rg = RasterGroup(
            name="test_no_dates",
            file_list=[str(disp_file)],
            file_date_fmt=None,
        )
        return rg

    def test_x_values_are_iso_dates(self, raster_group_shared_ref):
        x = raster_group_shared_ref.x_values
        assert all(isinstance(v, str) for v in x)
        # Should be ISO format like "2016-08-01"
        assert all("-" in v for v in x)
        assert x[0] == "2016-08-01"

    def test_reference_date_detected(self, raster_group_shared_ref):
        assert raster_group_shared_ref.reference_date == "2016-07-08"

    def test_no_dates_falls_back_to_indexes(self, raster_group_no_dates):
        x = raster_group_no_dates.x_values
        assert x == [0]

    def test_no_dates_reference_date_is_none(self, raster_group_no_dates):
        assert raster_group_no_dates.reference_date is None


class TestDuplicateSecondaryDates:
    """Test that varying reference dates with duplicate secondary dates fall back."""

    def test_duplicate_secondary_dates_fall_back_to_indices(self):
        """Interferograms with different reference dates can share secondary dates.

        E.g., unwrapped_20160101_20160201.tif and unwrapped_20160115_20160201.tif
        both have secondary date 2016-02-01. Using only the secondary date as
        x_value produces duplicates, so we should fall back to integer indices.
        """
        from unittest.mock import PropertyMock, patch

        from bowser.titiler import RasterGroup

        # Simulate 4 interferograms: 2 reference dates x 2 secondary dates
        # ref1_sec1, ref2_sec1, ref1_sec2, ref2_sec2
        fake_dates = [
            (datetime(2016, 1, 1), datetime(2016, 2, 1)),
            (datetime(2016, 1, 15), datetime(2016, 2, 1)),  # dup secondary
            (datetime(2016, 1, 1), datetime(2016, 2, 15)),
            (datetime(2016, 1, 15), datetime(2016, 2, 15)),  # dup secondary
        ]
        from pathlib import Path

        data_dir = Path(__file__).parent / "data/geotiffs"
        disp_files = sorted(data_dir.glob("displacement_*.tif"))[:4]

        rg = RasterGroup(
            name="test_varying_ref",
            file_list=[str(f) for f in disp_files],
            file_date_fmt="%Y%m%d",
        )
        # Patch the reader's dates to simulate varying reference dates
        with patch.object(
            type(rg._reader),
            "dates",
            new_callable=PropertyMock,
            return_value=fake_dates,
        ):
            x = rg.x_values
            # Should use full "ref_secondary" date pair labels
            assert x == [
                "2016-01-01_2016-02-01",
                "2016-01-15_2016-02-01",
                "2016-01-01_2016-02-15",
                "2016-01-15_2016-02-15",
            ]
            # reference_date should be None (varying first dates)
            assert rg.reference_date is None

    def test_unique_secondary_dates_use_dates(self):
        """When secondary dates are all unique, they should be used as x_values."""
        from unittest.mock import PropertyMock, patch

        from bowser.titiler import RasterGroup

        fake_dates = [
            (datetime(2016, 1, 1), datetime(2016, 2, 1)),
            (datetime(2016, 1, 1), datetime(2016, 2, 15)),
            (datetime(2016, 1, 1), datetime(2016, 3, 1)),
        ]
        from pathlib import Path

        data_dir = Path(__file__).parent / "data/geotiffs"
        disp_files = sorted(data_dir.glob("displacement_*.tif"))[:3]

        rg = RasterGroup(
            name="test_unique_sec",
            file_list=[str(f) for f in disp_files],
            file_date_fmt="%Y%m%d",
        )
        with patch.object(
            type(rg._reader),
            "dates",
            new_callable=PropertyMock,
            return_value=fake_dates,
        ):
            x = rg.x_values
            assert x == ["2016-02-01", "2016-02-15", "2016-03-01"]
