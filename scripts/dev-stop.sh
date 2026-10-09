#!/usr/bin/env bash
# Stop app watchers and listeners whose working directory belongs to this checkout.
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

in_checkout() {
  [ "$1" != "$$" ] && [ "$1" != "$PPID" ] || return 1
  local cwd
  cwd="$(lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  case "$cwd" in "$ROOT_DIR"|"$ROOT_DIR"/*) return 0 ;; *) return 1 ;; esac
}

stop_tree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null || true); do stop_tree "$child"; done
  kill "$1" 2>/dev/null || true
}

# Killing only tsx's API child leaves its watcher alive; the next edit restarts it.
while read -r pid; do
  [ -n "$pid" ] && in_checkout "$pid" || continue
  echo "[dev-stop] stopping app watcher (pid $pid)"
  stop_tree "$pid"
done < <(pgrep -f 'tsx.* watch src/index[.]ts|next dev' 2>/dev/null)

for port in "${API_PORT:-8787}" "${SHIZUE_WEB_PORT:-13000}"; do
  while read -r pid; do
    [ -n "$pid" ] && in_checkout "$pid" || continue
    echo "[dev-stop] stopping listener on $port (pid $pid)"
    stop_tree "$pid"
  done < <(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | sort -u)
done
