#!/usr/bin/env bash
# Start the Bowser demo: the Hawaii cube (OPERA L3 DISP-S1, frame 23211, descending),
# downloaded once, served read-only. Used by the Codespaces demo and the Hugging Face Space.
#
#   BOWSER_DEMO_URL   where the cube's tar file is (default: this repository's demo-data release)
#   BOWSER_DEMO_DIR   where to keep it (default: ~/.cache/bowser-demo)
#   PORT              the port to serve on (default: 8080)
set -euo pipefail

URL="${BOWSER_DEMO_URL:-https://github.com/opera-adt/bowser/releases/download/demo-data/hawaii_demo.zarr.tar}"
DIR="${BOWSER_DEMO_DIR:-${HOME:-/tmp}/.cache/bowser-demo}"
PORT="${PORT:-8080}"
CUBE="$DIR/hawaii_demo.zarr"

# The Docker image keeps Bowser's environment behind /activate.sh (its entrypoint sources it).
if ! command -v bowser > /dev/null && [ -f /activate.sh ]; then
  # shellcheck disable=SC1091
  source /activate.sh
fi

if [ ! -f "$CUBE/zarr.json" ]; then
  echo "Downloading the demo cube (about 95 MB) from $URL"
  mkdir -p "$DIR"
  curl -fL --retry 3 "$URL" | tar -x -C "$DIR"
fi

# A public demo: no opening of server files, no Assistant, small short-lived uploads.
export BOWSER_MAX_UPLOAD_MB="${BOWSER_MAX_UPLOAD_MB:-25}"
export BOWSER_UPLOAD_RETENTION_H="${BOWSER_UPLOAD_RETENTION_H:-1}"
exec bowser run --stack-file "$CUBE" --host 0.0.0.0 --port "$PORT" \
  --no-allow-open --no-assistant --title "Bowser demo: Hawaii (OPERA DISP-S1)"
