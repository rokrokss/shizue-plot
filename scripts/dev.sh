#!/usr/bin/env bash
# Local character-chat stack. Next forwards /api/* to Hono, which keeps the
# database (PGlite) and the files in the app's folder: SHIZUE_DATA_DIR, by default
# apps/plot/data/app. Nothing else runs: no containers.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLOT_DIR="$ROOT_DIR/apps/plot"
export API_PORT="${API_PORT:-8787}"
export SHIZUE_WEB_PORT="${SHIZUE_WEB_PORT:-13000}"
export API_ORIGIN="${API_ORIGIN:-http://localhost:$API_PORT}"
export BETTER_AUTH_URL="${BETTER_AUTH_URL:-http://localhost:$SHIZUE_WEB_PORT}"
# The API reads apps/plot/.env itself; `next dev` does not, and refuses a tunnel's
# host unless next.config.ts allows it: the settings page's own tunnels always, a
# tunnel the reader runs once it is in REMOTE_ORIGINS.
if [ -z "${REMOTE_ORIGINS:-}" ] && [ -f "$PLOT_DIR/.env" ]; then
  export REMOTE_ORIGINS="$(sed -n 's/^REMOTE_ORIGINS=//p' "$PLOT_DIR/.env" | tail -n 1)"
fi

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
pnpm --dir "$PLOT_DIR/apps/web" exec next dev --hostname 127.0.0.1 --port "$SHIZUE_WEB_PORT" &
children+=("$!")
echo "[dev] open $BETTER_AUTH_URL — Ctrl-C to stop"
wait
