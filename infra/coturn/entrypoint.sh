#!/bin/sh
# coturn entrypoint — substitutes runtime env into turnserver.conf so secrets
# don't have to be baked into the image. The original config remains read-only.
set -e

CONF_TEMPLATE="/etc/coturn/turnserver.conf"
CONF_RUNTIME="/tmp/turnserver.conf"

if [ -z "$TURN_STATIC_AUTH_SECRET" ]; then
    echo "[entrypoint] WARNING: TURN_STATIC_AUTH_SECRET is empty — coturn will refuse all auth attempts" >&2
fi

# Replace the placeholder with the runtime secret.
sed "s|__REPLACE_WITH_TURN_STATIC_AUTH_SECRET__|${TURN_STATIC_AUTH_SECRET}|g" \
    "$CONF_TEMPLATE" > "$CONF_RUNTIME"

# Append external-ip if provided (cloud / NAT'd hosts MUST set this so the
# server-reflexive candidates coturn returns are actually routable).
if [ -n "$TURN_EXTERNAL_IP" ]; then
    echo "[entrypoint] external-ip=$TURN_EXTERNAL_IP" >&2
    echo "external-ip=${TURN_EXTERNAL_IP}" >> "$CONF_RUNTIME"
fi

# Auto-generate a self-signed cert if no real cert was mounted, so the daemon
# at least starts. Replace this with a real cert (Let's Encrypt) in production.
if [ ! -f /etc/coturn/certs/fullchain.pem ] || [ ! -f /etc/coturn/certs/privkey.pem ]; then
    echo "[entrypoint] No TLS cert found in /etc/coturn/certs; generating self-signed (DEV ONLY)" >&2
    mkdir -p /tmp/certs
    openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
        -keyout /tmp/certs/privkey.pem \
        -out /tmp/certs/fullchain.pem \
        -subj "/CN=workpulse-coturn-dev" >/dev/null 2>&1
    sed -i "s|/etc/coturn/certs/|/tmp/certs/|g" "$CONF_RUNTIME"
fi

exec turnserver -c "$CONF_RUNTIME" --no-cli