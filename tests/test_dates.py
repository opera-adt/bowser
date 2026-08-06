"""Tests for filename date parsing."""

from datetime import datetime

import pytest

from bowser._dates import get_dates


class TestGetDates:
    def test_single_date(self):
        assert get_dates("/path/to/20191231.slc.tif") == [datetime(2019, 12, 31)]

    def test_date_pair(self):
        assert get_dates("unwrapped_20160708_20160801.tif") == [
            datetime(2016, 7, 8),
            datetime(2016, 8, 1),
        ]

    def test_no_dates(self):
        assert get_dates("/not/a/date_named_file.tif") == []

    def test_directory_dates_are_ignored(self):
        """A stack under /data/20240101/ must not inherit the directory date."""
        assert get_dates("/data/20240101/velocity.tif") == []

    @pytest.mark.parametrize(
        ("name", "fmt", "expected"),
        [
            ("20240626T150051.tif", "%Y%m%dT%H%M%S", datetime(2024, 6, 26, 15, 0, 51)),
            ("2024-06-26.tif", "%Y-%m-%d", datetime(2024, 6, 26)),
            ("240626.tif", "%y%m%d", datetime(2024, 6, 26)),
        ],
    )
    def test_custom_formats(self, name, fmt, expected):
        assert get_dates(name, fmt=fmt) == [expected]

    def test_opera_disp_product_name(self):
        name = (
            "OPERA_L3_DISP-S1_IW_F11116_VV_20240101T000000Z_20240113T000000Z"
            "_v1.0_20240315T120000Z.nc"
        )
        assert get_dates(name) == [
            datetime(2024, 1, 1),
            datetime(2024, 1, 13),
            datetime(2024, 3, 15),
        ]

    @pytest.mark.parametrize(
        "name",
        [
            'NETCDF:"/data/stack_20240101.nc":displacement',
            "DERIVED_SUBDATASET:AMPLITUDE:/data/stack_20240101.tif",
        ],
    )
    def test_gdal_subdataset_strings_are_unwrapped(self, name):
        assert get_dates(name) == [datetime(2024, 1, 1)]

    def test_s3_url(self):
        assert get_dates("s3://bucket/prefix/disp_20240101.tif") == [
            datetime(2024, 1, 1)
        ]

    def test_impossible_date_raises(self):
        """Silently skipping would mis-align a stack against its time coord."""
        with pytest.raises(ValueError):
            get_dates("displacement_20241332.tif")
