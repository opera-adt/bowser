"""Server utilities for running Bowser FastAPI app programmatically."""

import logging
import os
import socket
import threading
import time
from contextlib import contextmanager
from typing import Optional

import uvicorn

logger = logging.getLogger(__name__)


def _find_available_port(start_port: int = 8000) -> int:
    """Find an available port starting from start_port."""
    port = start_port - 1
    while True:
        port += 1
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            result = s.connect_ex(("127.0.0.1", port))
            if result != 0:
                return port


def _setup_gdal_env(ignore_sidecar_files: bool = False):
    """Set up GDAL environment variables for optimal performance."""
    cfg = {
        "GDAL_HTTP_MULTIPLEX": "YES",
        "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": "YES",
        "GDAL_CACHEMAX": "800",
        "CPL_VSIL_CURL_CACHE_SIZE": "800",
        "VSI_CACHE": "TRUE",
        "VSI_CACHE_SIZE": "5000000",
    }
    for k, v in cfg.items():
        os.environ[k] = v
    if ignore_sidecar_files:
        os.environ["GDAL_DISABLE_READDIR_ON_OPEN"] = "EMPTY_DIR"


class BowserServer:
    """A Bowser server that can be started/stopped programmatically."""

    def __init__(
        self,
        stack_file: Optional[str] = None,
        rasters_file: Optional[str] = None,
        port: int = 0,
        ignore_sidecar_files: bool = False,
        no_spatial_reference: bool = False,
        no_recommended_mask: bool = False,
    ):
        self.stack_file = stack_file
        self.rasters_file = rasters_file or "bowser_rasters.json"
        self.port = port or _find_available_port(8000)
        self.ignore_sidecar_files = ignore_sidecar_files
        self.no_spatial_reference = no_spatial_reference
        self.no_recommended_mask = no_recommended_mask

        self._server: uvicorn.Server | None = None
        self._thread: threading.Thread | None = None
        self._should_exit = threading.Event()

    @property
    def url(self) -> str:
        """Get the server URL."""
        return f"http://127.0.0.1:{self.port}"

    def start(self) -> None:
        """Start the server in a background thread."""
        if self._server is not None:
            raise RuntimeError("Server is already running")

        # Set up environment
        _setup_gdal_env(self.ignore_sidecar_files)

        if self.stack_file:
            os.environ["BOWSER_STACK_DATA_FILE"] = self.stack_file
        else:
            os.environ["BOWSER_DATASET_CONFIG_FILE"] = self.rasters_file

        os.environ["BOWSER_SPATIAL_REFERENCE_DISP"] = (
            "NO" if self.no_spatial_reference else "YES"
        )
        os.environ["BOWSER_USE_RECOMMENDED_MASK"] = (
            "NO" if self.no_recommended_mask else "YES"
        )

        # If port was 0, find an available one
        if self.port == 0:
            self.port = _find_available_port(8000)

        logger.info(f"Starting Bowser server on {self.url}")

        # Create uvicorn config
        config = uvicorn.Config(
            "bowser.main:app",
            host="127.0.0.1",
            port=self.port,
            log_level="warning",
        )

        self._server = uvicorn.Server(config)

        # Start server in background thread
        self._thread = threading.Thread(target=self._run_server, daemon=True)
        assert self._thread is not None
        self._thread.start()

        # Wait for server to start
        timeout = 60
        start_time = time.time()
        while not self._server_is_ready() and time.time() - start_time < timeout:
            time.sleep(0.1)

        if not self._server_is_ready():
            raise RuntimeError(f"Server failed to start within {timeout} seconds")

    def _run_server(self):
        """Run the uvicorn server."""
        try:
            self._server.run()
        except Exception as e:
            logger.error(f"Server error: {e}")

    def _server_is_ready(self) -> bool:
        """Check if server is ready to accept connections."""
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(1)
                result = s.connect_ex(("127.0.0.1", self.port))
                return result == 0
        except Exception:
            return False

    def stop(self) -> None:
        """Stop the server."""
        if self._server is not None:
            logger.info("Stopping Bowser server")
            self._should_exit.set()
            self._server.should_exit = True
            if self._thread and self._thread.is_alive():
                self._thread.join(timeout=5)
            self._server = None
            self._thread = None


@contextmanager
def running(
    stack_file: Optional[str] = None,
    rasters_file: Optional[str] = None,
    port: int = 0,
    ignore_sidecar_files: bool = False,
    no_spatial_reference: bool = False,
    no_recommended_mask: bool = False,
):
    """Context manager for running a Bowser server.

    Args:
    ----
        stack_file: Path to zarr/netcdf stack file
        rasters_file: Path to JSON file with raster configurations
        port: Port to run on (0 for automatic)
        ignore_sidecar_files: Ignore GDAL sidecar files
        no_spatial_reference: Don't use spatial reference for displacement
        no_recommended_mask: Don't use recommended mask

    Yields:
    ------
        BowserServer: The running server instance
    """
    server = BowserServer(
        stack_file=stack_file,
        rasters_file=rasters_file,
        port=port,
        ignore_sidecar_files=ignore_sidecar_files,
        no_spatial_reference=no_spatial_reference,
        no_recommended_mask=no_recommended_mask,
    )
    try:
        server.start()
        yield server
    finally:
        server.stop()


def create_app():
    """Create the FastAPI app instance.

    This is a factory function that can be imported and used
    independently of the CLI.
    """
    from .main import app

    return app
