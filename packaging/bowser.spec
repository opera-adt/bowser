# PyInstaller spec for the Bowser desktop app (one folder per platform).
#   pyinstaller packaging/bowser.spec --noconfirm
# The app runs bowser-lite, so GDAL, titiler, matplotlib and the S3 stack are left out.
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = Path(SPECPATH).parent
HEAVY = [
    "rasterio", "rio_tiler", "titiler", "matplotlib", "scipy", "dask", "distributed", "bokeh",
    "s3fs", "botocore", "aiobotocore", "boto3", "opera_utils", "geopandas", "shapely", "pyarrow", "IPython",
]

datas = collect_data_files("bowser", includes=["dist/**/*", "static/**/*", "lite/*.npz", "lite/*.json"])
datas += collect_data_files("pyproj")  # PROJ's database, for UTM <-> lon/lat

a = Analysis(
    [str(ROOT / "packaging" / "bowser_app.py")],
    pathex=[str(ROOT / "src")],
    datas=datas,
    hiddenimports=collect_submodules("uvicorn") + collect_submodules("bowser.lite") + ["bowser.desktop"],
    excludes=HEAVY,
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [], exclude_binaries=True, name="Bowser",
    console=False,  # no terminal window for the user
    icon=str(ROOT / "packaging" / ("bowser.ico" if sys.platform == "win32" else "bowser.icns"))
    if (ROOT / "packaging" / ("bowser.ico" if sys.platform == "win32" else "bowser.icns")).exists() else None,
)
coll = COLLECT(exe, a.binaries, a.datas, name="Bowser")
if sys.platform == "darwin":
    app = BUNDLE(coll, name="Bowser.app", bundle_identifier="org.opera-adt.bowser",
                 info_plist={"NSHighResolutionCapable": True, "CFBundleShortVersionString": "0.0.0"})
