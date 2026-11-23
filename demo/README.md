# Bowser demo: Hawaii

A small cube to try Bowser without installing anything: OPERA L3 DISP-S1 surface displacement over
the Island of Hawaiʻi (frame 23211, descending, July 2016 to March 2026), at 240 m with every sixth
date (70 dates, about 95 MB). It shows Kīlauea's 2018 summit collapse and recovery, its south flank
and rift zones, and Mauna Loa's 2022 eruption.

Data: OPERA L3 DISP-S1, NASA/JPL-Caltech, distributed by the Alaska Satellite Facility.

## Where it runs

- **GitHub Codespaces:** the README's *Open in GitHub Codespaces* button uses
  [`.devcontainer/demo/devcontainer.json`](../.devcontainer/demo/devcontainer.json): the published
  Docker image, then [`run_demo.sh`](run_demo.sh), which downloads the cube once and serves it. The
  page opens on the forwarded port 8080.
- **Hugging Face Space:** [`.github/workflows/demo-space.yml`](../.github/workflows/demo-space.yml)
  uploads [`space/`](space) and `run_demo.sh` to a Docker Space on each release (or by hand), with the
  cube built into the Space's image. It needs the repository secret `HF_TOKEN` (a Hugging Face
  write token) and the variable `HF_SPACE` (the Space's name, e.g. `opera-adt/bowser-demo`); without
  `HF_SPACE` the workflow does nothing.
- **Your computer:** `PORT=8080 bash demo/run_demo.sh` with Bowser installed, or with Docker:
  `docker run --rm -p 8080:8080 -v "$PWD/demo:/demo" ghcr.io/opera-adt/bowser:latest bash /demo/run_demo.sh`

The demo serves read-only: opening server files and the Assistant are off, and uploads are limited to
25 MB and kept for an hour.

## The cube

It lives as `hawaii_demo.zarr.tar` on the repository's `demo-data` release. To make it again from a
multiscale OPERA DISP-S1 GeoZarr cube (as written by opera-utils) and replace the file:

```bash
python demo/make_demo_cube.py F23211_desc.zarr hawaii_demo.zarr --level 3 --step 6
tar -cf hawaii_demo.zarr.tar hawaii_demo.zarr
gh release upload demo-data hawaii_demo.zarr.tar --clobber
```
