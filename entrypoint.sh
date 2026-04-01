#!/bin/sh
set -e

# When a volume is mounted at /app/server/uploads, the container platform
# (Railway, Docker, etc.) mounts it as root, overriding the ownership set
# during the image build. This script runs as root first, ensures the
# subdirectory exists and is writable by appuser, then drops privileges.
mkdir -p /app/server/uploads/avatars
chown -R appuser:appgroup /app/server/uploads

exec su-exec appuser dumb-init -- "$@"
