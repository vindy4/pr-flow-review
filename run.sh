#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -f dist/index.html ]; then
  echo "Build the browser app first: npm install && npm run build" >&2
  exit 1
fi
exec env UV_CACHE_DIR="$PWD/.cache/uv" uv run python -m backend.server "$@"
