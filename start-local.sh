#!/usr/bin/env bash
#
# WorkPulse — local production-like build & run
# Usage:  ./start-local.sh          (build + start)
#         ./start-local.sh --skip-build   (start only, reuse last build)
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CLIENT="$ROOT/client"
SERVER="$ROOT/server"

# ── colours ──
GREEN='\033[0;32m'  YELLOW='\033[1;33m'  RED='\033[0;31m'  NC='\033[0m'

log()  { printf "${GREEN}[build]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[warn]${NC}  %s\n" "$*"; }
err()  { printf "${RED}[error]${NC} %s\n" "$*"; exit 1; }

# ── check prereqs ──
command -v node  >/dev/null || err "node is not installed"
command -v npm   >/dev/null || err "npm is not installed"

# ── install deps if needed ──
install_deps() {
  local dir=$1
  if [ ! -d "$dir/node_modules" ]; then
    log "Installing dependencies in $(basename "$dir")…"
    (cd "$dir" && npm install)
  fi
}

install_deps "$CLIENT"
install_deps "$SERVER"

# ── build client ──
if [ "${1:-}" != "--skip-build" ]; then
  log "Building client…"
  (cd "$CLIENT" && npm run build)
  log "Client built → client/dist/"
else
  warn "Skipping client build (--skip-build)"
  [ -d "$CLIENT/dist" ] || err "client/dist not found — run without --skip-build first"
fi

# ── start server ──
log "Starting server on http://localhost:${PORT:-5000}"
cd "$SERVER"
exec node index.js
