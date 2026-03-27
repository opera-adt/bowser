#!/usr/bin/env python
"""Visual screenshot test for Bowser UI.

Starts a Bowser server with synthetic data, drives Playwright through
key UI states, and saves screenshots to a timestamped directory.

Usage:
    # Default: headless, 5k points
    pixi run python tests/visual_test.py

    # With visible browser
    pixi run python tests/visual_test.py --headed

    # More points for realistic density
    pixi run python tests/visual_test.py --n-points 50000

    # Custom output directory
    pixi run python tests/visual_test.py --output-dir screenshots/

Screenshots are saved as numbered PNGs with descriptive names, making it
easy to review the UI state at each step. Share the directory for review.
"""

from __future__ import annotations

import argparse
import os
import socket
import subprocess
import sys
import time
from pathlib import Path


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description="Visual screenshot test for Bowser")
    parser.add_argument("--headed", action="store_true", help="Show browser window")
    parser.add_argument("--n-points", type=int, default=5000)
    parser.add_argument("--n-dates", type=int, default=10)
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Directory for screenshots (default: screenshots/<timestamp>)",
    )
    args = parser.parse_args()

    # Output directory
    if args.output_dir:
        out_dir = Path(args.output_dir)
    else:
        ts = time.strftime("%Y%m%d_%H%M%S")
        out_dir = Path("screenshots") / ts
    out_dir.mkdir(parents=True, exist_ok=True)

    # Generate test data
    import tempfile

    tmpdir = Path(tempfile.mkdtemp(prefix="bowser_visual_"))
    print(f"Generating {args.n_points:,} points x {args.n_dates} dates...")
    from bowser._generate_testdata import generate_testdata

    manifest_path = generate_testdata(
        output_dir=tmpdir,
        n_points=args.n_points,
        n_dates=args.n_dates,
        seed=42,
    )

    # Start server
    port = _find_free_port()
    env = os.environ.copy()
    env["BOWSER_MANIFEST_FILE"] = str(manifest_path)

    repo_root = Path(__file__).parent.parent
    pixi_python = repo_root / ".pixi" / "envs" / "default" / "bin" / "python"
    python_exe = str(pixi_python) if pixi_python.exists() else sys.executable

    print(f"Starting server on port {port}...")
    proc = subprocess.Popen(
        [
            python_exe,
            "-m",
            "uvicorn",
            "bowser.main:app",
            "--port",
            str(port),
            "--log-level",
            "warning",
        ],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(repo_root),
    )

    base_url = f"http://localhost:{port}"

    # Wait for server
    import urllib.request

    for _ in range(60):
        try:
            urllib.request.urlopen(f"{base_url}/points/layers", timeout=1)
            break
        except Exception:
            time.sleep(0.5)
    else:
        proc.kill()
        stdout, stderr = proc.communicate()
        print(f"Server failed to start!\nstderr: {stderr.decode()}")
        sys.exit(1)

    print(f"Server ready at {base_url}")

    step = 0

    def screenshot(page, name: str):
        nonlocal step
        step += 1
        filename = f"{step:02d}_{name}.png"
        filepath = out_dir / filename
        page.screenshot(path=str(filepath))
        print(f"  [{step:02d}] {name}")

    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=not args.headed)
            page = browser.new_page(viewport={"width": 1400, "height": 900})

            # 1. Initial load
            page.goto(base_url)
            page.wait_for_selector("canvas", timeout=15_000)
            # Wait for points to load
            page.locator("text=points").first.wait_for(timeout=20_000)
            page.wait_for_timeout(2_000)  # let deck.gl render
            screenshot(page, "initial_load")

            # 2. Switch basemap to OSM
            page.locator("button", has_text="OpenStreetMap").click()
            page.wait_for_timeout(1_500)
            screenshot(page, "basemap_osm")

            # 3. Switch basemap to Dark
            page.locator("button", has_text="Dark").click()
            page.wait_for_timeout(1_500)
            screenshot(page, "basemap_dark")

            # 4. Switch back to Satellite
            page.locator("button", has_text="Satellite").click()
            page.wait_for_timeout(1_000)

            # 5. Change colormap to viridis
            colormap_selects = page.locator("select").all()
            for sel in colormap_selects:
                options = sel.locator("option").all()
                for opt in options:
                    if opt.get_attribute("value") == "viridis":
                        sel.select_option("viridis")
                        break
            page.wait_for_timeout(1_000)
            screenshot(page, "colormap_viridis")

            # 6. Add a filter
            filter_input = page.locator("input[placeholder='val']")
            if filter_input.count() > 0:
                filter_input.fill("0.6")
                page.locator("button", has_text="+").click()
                page.wait_for_timeout(2_000)
                screenshot(page, "filter_applied")
                # Clear
                clear_btn = page.locator("text=Clear all filters")
                if clear_btn.count() > 0:
                    clear_btn.click()
                    page.wait_for_timeout(1_500)

            # 7. Click center of map (try to hit a point)
            canvas = page.locator("canvas").first
            box = canvas.bounding_box()
            assert box is not None
            cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
            page.mouse.click(cx, cy)
            page.wait_for_timeout(3_000)
            screenshot(page, "after_click")

            # 8. Check if chart appeared, take screenshot
            chart_visible = page.locator("text=Displacement").count() > 0
            if chart_visible:
                screenshot(page, "timeseries_chart")

                # 9. Click trend button
                trend_btn = page.locator("button", has_text="Trend")
                if trend_btn.count() > 0:
                    trend_btn.click()
                    page.wait_for_timeout(1_000)
                    screenshot(page, "trend_enabled")

                # 10. Shift+click another point for multi-select
                page.mouse.click(cx + 50, cy + 30, modifiers=["Shift"])
                page.wait_for_timeout(2_000)
                screenshot(page, "multi_select")
            else:
                print("  (no point was hit — clicking empty area)")
                screenshot(page, "no_point_hit")

            # 11. Full page at final state
            screenshot(page, "final_state")

            browser.close()

    finally:
        proc.terminate()
        proc.wait(timeout=5)
        proc.stdout.close()
        proc.stderr.close()

    print(f"\nScreenshots saved to {out_dir}/")
    print(f"  {step} screenshots captured")


if __name__ == "__main__":
    main()
