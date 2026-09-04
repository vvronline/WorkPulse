#!/usr/bin/env bash
# infra/livekit/entrypoint.sh
#
# Renders livekit.yaml.template into a runtime-only config using validated
# environment variables, sets up the Railway TCP-proxy port forward if
# needed, then execs livekit-server.
#
# Design rule: this image never falls back to a "probably fine" default for
# a production-critical setting. A silently misconfigured TCP proxy or
# missing Redis/API credentials produces a server that *looks* healthy but
# drops every call — far worse than refusing to start. Every required
# variable is checked explicitly below; nothing is a broad silent fallback.
set -euo pipefail

log()  { echo "[livekit-entrypoint] $*" >&2; }
fail() { echo "[livekit-entrypoint] ERROR: $*" >&2; exit 1; }

# Resolve a hostname to a single IPv4 address using getent (glibc, already
# part of this base image — no extra tooling). Prints nothing and returns
# non-zero if resolution fails; never touches STDERR so callers can safely
# capture stdout.
resolve_ipv4() {
    getent ahostsv4 "$1" 2>/dev/null | awk '{ print $1; exit }'
}

# Produce a single-quoted YAML scalar from an arbitrary string. Single-quoted
# YAML scalars treat every character literally except a single quote, which
# must be doubled — so this is safe for secrets containing YAML metacharacters
# (`:`, `#`, `{`, `[`, `&`, `*`, etc.) without needing to restrict their
# character set.
yaml_squote() {
    local value="$1"
    printf "'%s'" "${value//\'/\'\'}"
}

# Escape a string so it can be used verbatim as the *replacement* side of a
# `sed 's|pattern|replacement|g'` expression with `|` as the delimiter.
# Order matters: backslashes must be escaped first, then the two characters
# sed treats specially in a replacement (`&` = whole match, and the chosen
# delimiter `|`). Without this, a secret containing any of these characters
# would silently corrupt the rendered config instead of erroring.
sed_escape_replacement() {
    local value="$1"
    value="${value//\\/\\\\}"
    value="${value//&/\\&}"
    value="${value//|/\\|}"
    printf '%s' "$value"
}

# Secrets/credentials are rendered as single-line YAML scalars; a literal
# newline or NUL byte can't be represented that way and must not be silently
# dropped or truncated, so reject it explicitly instead of guessing.
reject_control_chars() {
    local name="$1" value="$2"
    case "$value" in
        *$'\n'*|*$'\r'*) fail "${name} contains a literal newline/carriage return, which cannot be safely rendered into livekit.yaml. Regenerate it as a single-line value (see .env.example for recommended generation commands)." ;;
    esac
}

LOCAL_DEV="${LIVEKIT_LOCAL_DEV:-false}"

# ---------------------------------------------------------------------------
# 1. Required in every environment: signaling auth + Redis coordination.
#    Without these, LiveKit would boot unauthenticated or single-node-only.
# ---------------------------------------------------------------------------
missing=()
[ -z "${LIVEKIT_API_KEY:-}" ]    && missing+=("LIVEKIT_API_KEY")
[ -z "${LIVEKIT_API_SECRET:-}" ] && missing+=("LIVEKIT_API_SECRET")
[ -z "${REDIS_URL:-}" ]          && missing+=("REDIS_URL")

if [ "${#missing[@]}" -gt 0 ]; then
    fail "required variable(s) not set: ${missing[*]}. Refusing to start (see infra/livekit/README.md)."
fi

# LiveKit itself rejects a short api secret at config-validation time, but
# only after this image has already resolved DNS, started the TCP forwarder,
# and rendered the config — noisier and slower to diagnose than failing here,
# immediately, with a message that doesn't depend on reading server logs.
if [ "${#LIVEKIT_API_SECRET}" -lt 32 ]; then
    fail "LIVEKIT_API_SECRET must be at least 32 characters (got ${#LIVEKIT_API_SECRET}); LiveKit requires this for signing security. Generate one with e.g. \`openssl rand -hex 32\` (64 hex characters). Value withheld from logs."
fi

# ---------------------------------------------------------------------------
# 2. Public signaling port. Railway injects PORT automatically once a public
#    domain is generated for this service. Only default it when explicitly
#    told this is a non-Railway local run.
# ---------------------------------------------------------------------------
if [ -z "${PORT:-}" ]; then
    if [ "$LOCAL_DEV" = "true" ]; then
        PORT=8080
        log "PORT not set; LIVEKIT_LOCAL_DEV=true so defaulting to ${PORT}"
    else
        fail "PORT is not set. Railway sets this automatically once a public domain is attached to this service (Settings -> Networking -> Generate Domain). Set LIVEKIT_LOCAL_DEV=true only for non-Railway local runs."
    fi
fi

# ---------------------------------------------------------------------------
# 3. Railway TCP proxy variables. These are the whole point of this image:
#    without them, WebRTC media has no path into the container. Refuse to
#    boot into a "signaling works, every call silently fails to connect
#    media" state — fail loudly instead so the gap is caught at deploy time.
# ---------------------------------------------------------------------------
TCP_PROXY_DOMAIN="${RAILWAY_TCP_PROXY_DOMAIN:-}"
TCP_PROXY_PORT="${RAILWAY_TCP_PROXY_PORT:-}"
TCP_APP_PORT="${RAILWAY_TCP_APPLICATION_PORT:-}"

if [ "$LOCAL_DEV" != "true" ]; then
    tcp_missing=()
    [ -z "$TCP_PROXY_DOMAIN" ] && tcp_missing+=("RAILWAY_TCP_PROXY_DOMAIN")
    [ -z "$TCP_PROXY_PORT" ]  && tcp_missing+=("RAILWAY_TCP_PROXY_PORT")
    [ -z "$TCP_APP_PORT" ]    && tcp_missing+=("RAILWAY_TCP_APPLICATION_PORT")
    if [ "${#tcp_missing[@]}" -gt 0 ]; then
        fail "TCP proxy variable(s) not set: ${tcp_missing[*]}. Add a Railway TCP Proxy to this service (Settings -> Networking -> TCP Proxy, application port 7881) and redeploy — see infra/livekit/README.md. Set LIVEKIT_LOCAL_DEV=true only for non-Railway local testing."
    fi
else
    TCP_APP_PORT="${TCP_APP_PORT:-7881}"
    TCP_PROXY_PORT="${TCP_PROXY_PORT:-$TCP_APP_PORT}"
    log "LIVEKIT_LOCAL_DEV=true; skipping Railway TCP proxy requirement (app=${TCP_APP_PORT} advertised=${TCP_PROXY_PORT})"
fi

# LiveKit's rtc.tcp_port value is used both to *listen* and to *advertise* in
# ICE candidates. Railway's TCP proxy has two different port numbers: the
# internal "application port" traffic actually lands on inside the
# container, and the external "proxy port" clients must dial. We make
# LiveKit bind + advertise the external proxy port (so ICE candidates are
# actually reachable), then forward the internal application port to it.
ICE_TCP_PORT="$TCP_PROXY_PORT"

if [ "$TCP_APP_PORT" != "$ICE_TCP_PORT" ]; then
    log "forwarding Railway TCP proxy application port ${TCP_APP_PORT} -> ${ICE_TCP_PORT} (advertised port)"
    # socat is a portable userspace TCP forwarder: it needs no NET_ADMIN
    # capability and no iptables binary/kernel module, so it works under
    # Railway's default container security profile and as a non-root user.
    # It keeps running as a background sibling of livekit-server (below) for
    # the life of the container; the container runtime reaps it on stop.
    socat TCP-LISTEN:"${TCP_APP_PORT}",fork,reuseaddr TCP:127.0.0.1:"${ICE_TCP_PORT}" &
else
    log "TCP proxy application port already matches the advertised port (${TCP_APP_PORT}); no forwarder needed"
fi

# ---------------------------------------------------------------------------
# 4. ICE advertisement mode. Clients must be told the *Railway TCP proxy's*
#    address, not the container's own address — STUN-based external-IP
#    auto-detection discovers the latter (the outbound IP of this container
#    /node), which is not the same address the TCP proxy listens on, so it
#    is never used here. By default we resolve RAILWAY_TCP_PROXY_DOMAIN to an
#    IPv4 address and pass it as --node-ip with use_external_ip=false, so ICE
#    candidates advertise the actual reachable TCP-proxy endpoint.
#    LIVEKIT_NODE_IP overrides this resolution entirely when set.
# ---------------------------------------------------------------------------
NODE_IP_ARGS=()
RESOLVED_NODE_IP=""

if [ -n "${LIVEKIT_NODE_IP:-}" ]; then
    RESOLVED_NODE_IP="$LIVEKIT_NODE_IP"
    log "using operator-pinned LIVEKIT_NODE_IP override (skipping DNS resolution)"
elif [ -n "$TCP_PROXY_DOMAIN" ]; then
    RESOLVED_NODE_IP="$(resolve_ipv4 "$TCP_PROXY_DOMAIN")" || true
    if [ -n "$RESOLVED_NODE_IP" ]; then
        log "resolved RAILWAY_TCP_PROXY_DOMAIN (${TCP_PROXY_DOMAIN}) -> ${RESOLVED_NODE_IP} for ICE advertisement"
    elif [ "$LOCAL_DEV" = "true" ]; then
        log "WARNING: could not resolve ${TCP_PROXY_DOMAIN} to an IPv4 address; falling back to STUN-based external-IP detection (allowed only because LIVEKIT_LOCAL_DEV=true)"
    else
        fail "could not resolve RAILWAY_TCP_PROXY_DOMAIN (${TCP_PROXY_DOMAIN}) to an IPv4 address. LiveKit must advertise the Railway TCP proxy's own address, which STUN-based auto-detection cannot discover, so this is fatal rather than a silent fallback. Set LIVEKIT_NODE_IP to override if DNS is expected to be unavailable at boot."
    fi
fi

if [ -n "$RESOLVED_NODE_IP" ]; then
    USE_EXTERNAL_IP="false"
    NODE_IP_ARGS=(--node-ip "$RESOLVED_NODE_IP")
else
    # Only reachable in LIVEKIT_LOCAL_DEV=true runs with no TCP proxy domain
    # configured (nothing to resolve) or DNS unavailable locally.
    USE_EXTERNAL_IP="true"
    log "no node IP resolved/pinned; using STUN-based external-IP auto-detection (local-dev fallback only)"
fi

# ---------------------------------------------------------------------------
# 5. Parse REDIS_URL into host:port + password without ever logging the URL,
#    the password, or the host:port pair — only whether parsing succeeded.
#
#    Only redis:// is accepted. rediss:// (TLS) is rejected explicitly rather
#    than silently downgraded: livekit.yaml.template never sets
#    redis.tls.enabled, so accepting a rediss:// URL here would strip the
#    scheme and connect in plain TCP while an operator reasonably believes
#    TLS is in effect — a silent downgrade of a security property, exactly
#    the kind of broad silent fallback this image is designed to avoid.
#    Railway's private Redis networking (the documented path for this
#    service) runs over Railway's private network and is plain redis://;
#    see README.md for the recommended REDIS_URL value.
# ---------------------------------------------------------------------------
case "$REDIS_URL" in
    redis://*)
        redis_rest="${REDIS_URL#redis://}"
        ;;
    rediss://*)
        fail "REDIS_URL uses rediss:// (TLS), which this image does not support: livekit.yaml.template never sets redis.tls.enabled, so accepting rediss:// here would silently connect over plain TCP instead of TLS. Use redis:// with Railway's private Redis networking instead (REDIS_URL from the Redis service's private/internal connection variables, e.g. redis://default:<password>@redis.railway.internal:6379) — see README.md. Value withheld from logs."
        ;;
    *)
        fail "REDIS_URL must start with redis:// (rediss:// is explicitly not supported — see README.md). Value withheld from logs."
        ;;
esac

if [[ "$redis_rest" == *"@"* ]]; then
    redis_userinfo="${redis_rest%%@*}"
    REDIS_HOST_PORT="${redis_rest#*@}"
    if [[ "$redis_userinfo" == *:* ]]; then
        REDIS_PASSWORD="${redis_userinfo#*:}"
    else
        REDIS_PASSWORD=""
    fi
else
    REDIS_HOST_PORT="$redis_rest"
    REDIS_PASSWORD=""
fi
# Drop any trailing /<db-index> path segment.
REDIS_HOST_PORT="${REDIS_HOST_PORT%%/*}"

if [ -z "$REDIS_HOST_PORT" ]; then
    fail "could not parse a host:port from REDIS_URL (value withheld from logs)."
fi

# Reject values that cannot be safely rendered as single-line YAML instead of
# silently truncating/mangling them (a stray newline in a copy-pasted secret
# is a realistic mistake, not a hypothetical one).
reject_control_chars "REDIS_URL (host/port portion)" "$REDIS_HOST_PORT"
reject_control_chars "REDIS_URL (password portion)" "$REDIS_PASSWORD"
reject_control_chars "LIVEKIT_API_KEY" "$LIVEKIT_API_KEY"
reject_control_chars "LIVEKIT_API_SECRET" "$LIVEKIT_API_SECRET"

log "Redis coordination target parsed OK (host/port/password withheld from logs)"

# ---------------------------------------------------------------------------
# 6. Render config from the read-only template into a runtime-only path, then
#    lock it down (it briefly contains the API secret and Redis password).
#
#    Every value that can contain arbitrary operator/secret content (Redis
#    host:port, Redis password, API key, API secret) is first turned into a
#    single-quoted YAML scalar (yaml_squote — safe for any content except a
#    literal newline, rejected above) and only then substituted with sed,
#    whose own replacement-text metacharacters (`\`, `&`, and our `|`
#    delimiter) are escaped separately (sed_escape_replacement). This two-step
#    escape is required because YAML-quoting alone does not protect against
#    sed's replacement-text syntax, and sed-escaping alone would not protect
#    against YAML metacharacters once written to the config file — skipping
#    either step can silently corrupt a secret instead of erroring.
#    PORT/LOG_LEVEL/ICE_TCP_PORT/USE_EXTERNAL_IP are program-controlled
#    (numeric/boolean/enum) values, not user secrets, so they're substituted
#    as bare YAML scalars.
# ---------------------------------------------------------------------------
LOG_LEVEL="${LIVEKIT_LOG_LEVEL:-info}"
RUNTIME_CONFIG="/tmp/livekit/livekit.yaml"

REDIS_HOST_PORT_REPL="$(sed_escape_replacement "$(yaml_squote "$REDIS_HOST_PORT")")"
REDIS_PASSWORD_REPL="$(sed_escape_replacement "$(yaml_squote "$REDIS_PASSWORD")")"
LIVEKIT_API_KEY_REPL="$(sed_escape_replacement "$(yaml_squote "$LIVEKIT_API_KEY")")"
LIVEKIT_API_SECRET_REPL="$(sed_escape_replacement "$(yaml_squote "$LIVEKIT_API_SECRET")")"

sed \
    -e "s|__PORT__|${PORT}|g" \
    -e "s|__LOG_LEVEL__|${LOG_LEVEL}|g" \
    -e "s|__ICE_TCP_PORT__|${ICE_TCP_PORT}|g" \
    -e "s|__USE_EXTERNAL_IP__|${USE_EXTERNAL_IP}|g" \
    -e "s|__REDIS_HOST_PORT__|${REDIS_HOST_PORT_REPL}|g" \
    -e "s|__REDIS_PASSWORD__|${REDIS_PASSWORD_REPL}|g" \
    -e "s|__LIVEKIT_API_KEY__|${LIVEKIT_API_KEY_REPL}|g" \
    -e "s|__LIVEKIT_API_SECRET__|${LIVEKIT_API_SECRET_REPL}|g" \
    /etc/livekit/livekit.yaml.template > "$RUNTIME_CONFIG"
chmod 600 "$RUNTIME_CONFIG"

log "rendered runtime config -> ${RUNTIME_CONFIG} (signaling=:${PORT} ice-tcp=:${ICE_TCP_PORT} external-ip=${USE_EXTERNAL_IP} log-level=${LOG_LEVEL})"
log "starting livekit-server"

exec livekit-server --config "$RUNTIME_CONFIG" "${NODE_IP_ARGS[@]}"
