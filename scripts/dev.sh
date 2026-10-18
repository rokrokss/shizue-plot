#!/usr/bin/env bash
# Local character-chat app: one process (apps/api/src/index.ts) serving the API at
# /api/* and the web app under `next dev` for the rest, on SHIZUE_PORT (13000) at
# both loopbacks. It keeps the database (PGlite) and the files in the app's
# folder: SHIZUE_DATA_DIR, by default apps/plot/data/app. Nothing else runs: no
# containers. The process reads apps/plot/.env itself, REMOTE_ORIGINS included.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLOT_DIR="$ROOT_DIR/apps/plot"
export SHIZUE_PORT="${SHIZUE_PORT:-13000}"

"$ROOT_DIR/scripts/dev-stop.sh"
pnpm --dir "$ROOT_DIR" --filter @shizue/contracts --filter './apps/plot/packages/*' build

stop_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do stop_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}
children=()
cleanup() {
  trap - EXIT INT TERM
  for pid in "${children[@]}"; do stop_tree "$pid"; done
}
trap cleanup EXIT INT TERM
pnpm --dir "$PLOT_DIR" --filter @shizue/api dev &
children+=("$!")
echo "[dev] open http://localhost:$SHIZUE_PORT — Ctrl-C to stop"
wait
