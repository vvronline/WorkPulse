#!/bin/sh
set -e

# A3: uploads moved to Cloudflare R2, so there is no longer a volume to fix up.
#
# This script used to run as root purely to chown a volume mounted at
# /app/server/uploads — the container platform mounts it as root, overriding
# image-build ownership. That volume also pinned the service to ONE instance
# (a Railway volume attaches to a single container), which is precisely what
# blocked horizontal scaling.
#
# With object storage the container is stateless: no volume, no chown, no root
# step. We drop straight to the unprivileged user.
#
# STORAGE_DRIVER=local is still supported for local development, in which case
# the app writes under /app/server/uploads inside the container's own writable
# layer. The directory is created at build time and owned by appuser, so no
# privileged fixup is needed there either.

exec dumb-init -- "$@"
