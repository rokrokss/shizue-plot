#!/usr/bin/env bash
# Local character-chat stack. Next forwards /api/* to Hono.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLOT_DIR="$ROOT_DIR/apps/plot"
export API_PORT="${API_PORT:-8787}"
export SHIZUE_WEB_PORT="${SHIZUE_WEB_PORT:-13000}"
export API_ORIGIN="${API_ORIGIN:-http://localhost:$API_PORT}"
export BETTER_AUTH_URL="${BETTER_AUTH_URL:-http://localhost:$SHIZUE_WEB_PORT}"
export DATABASE_URL="${DATABASE_URL:-postgres://plot:plot@localhost:15433/plot}"
export STORAGE_DRIVER="${STORAGE_DRIVER:-s3}"
export S3_BUCKET="${S3_BUCKET:-shizue-media}"
export S3_REGION="${S3_REGION:-us-east-1}"
export S3_ENDPOINT="${S3_ENDPOINT:-http://localhost:19000}"
export S3_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID:-shizue}"
export S3_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:-shizue-secret}"
export S3_FORCE_PATH_STYLE="${S3_FORCE_PATH_STYLE:-true}"

"$ROOT_DIR/scripts/dev-stop.sh"
docker compose -f "$ROOT_DIR/docker-compose.yml" up -d
ready=false
for _ in $(seq 1 30); do
  if docker compose -f "$ROOT_DIR/docker-compose.yml" exec -T postgres pg_isready -U plot -d plot >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
$ready || { echo '[dev] postgres did not become ready' >&2; exit 1; }
pnpm --dir "$ROOT_DIR" --filter @shizue/contracts --filter './apps/plot/packages/*' build
pnpm --dir "$ROOT_DIR" db:migrate

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
echo "[dev] open $BETTER_AUTH_URL — Ctrl-C to stop; containers stay running"
wait
