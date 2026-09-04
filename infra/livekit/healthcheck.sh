#!/usr/bin/env bash
# infra/livekit/healthcheck.sh
#
# Docker HEALTHCHECK for the LiveKit signaling port. Uses LiveKit's own
# built-in liveness probe: `GET /` on the main HTTP port returns 200 "OK"
# once the node's internal stats have updated within the last few seconds
# (see livekit/livekit pkg/service/server.go `healthCheck`). Uses curl only,
# which is already installed in this image for exactly this purpose — no
# extra tooling is added on top of what the entrypoint/forwarder need.
set -euo pipefail

PORT="${PORT:-8080}"

curl --fail --silent --show-error --max-time 3 "http://127.0.0.1:${PORT}/" >/dev/null
