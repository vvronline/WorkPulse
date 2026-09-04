# infra/livekit/Dockerfile
#
# Self-hosted LiveKit media/signaling server, packaged for Railway's
# TCP-only (no UDP) networking. See infra/livekit/README.md for the full
# deployment procedure, variable reference, and the promotion/escape-hatch
# criteria this service is bound by.
#
# ---------------------------------------------------------------------------
# Version pin (never `latest` — see infra/livekit/README.md "Version policy"):
#   livekit/livekit-server:v1.13.6
#   Source: https://github.com/livekit/livekit/releases/tag/v1.13.6
#   (latest non-prerelease release at the time this file was authored;
#   also pinned by digest for full reproducibility of `docker build`)
# ---------------------------------------------------------------------------
FROM livekit/livekit-server:v1.13.6@sha256:e37d68f172556d02aa77968b9fc55ef481468c0315fa38e4fa6c56ce72e3a815 AS livekit

FROM debian:bookworm-slim

# bash             - entrypoint scripting (POSIX sh in this image is dash)
# ca-certificates  - TLS to Redis / any TLS upstream
# socat            - portable userspace TCP forwarder for the Railway TCP
#                    proxy port mismatch; needs no NET_ADMIN/iptables
# curl             - container HEALTHCHECK against LiveKit's built-in
#                    `GET /` liveness probe
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates socat curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --no-create-home --uid 10001 --shell /usr/sbin/nologin livekit

COPY --from=livekit /livekit-server /usr/local/bin/livekit-server
COPY livekit.yaml.template /etc/livekit/livekit.yaml.template
COPY entrypoint.sh /entrypoint.sh
COPY healthcheck.sh /healthcheck.sh

RUN chmod +x /entrypoint.sh /healthcheck.sh \
    # Build-time shell syntax validation using only the bash already
    # installed above (no extra tooling) — a broken entrypoint/healthcheck
    # fails `docker build` itself instead of only failing at deploy time.
    && bash -n /entrypoint.sh \
    && bash -n /healthcheck.sh \
    && mkdir -p /tmp/livekit \
    && chown -R livekit:livekit /tmp/livekit /etc/livekit

USER livekit
WORKDIR /tmp/livekit

# 8080 - default/documented signaling port (Railway overrides via $PORT)
# 7881 - default LiveKit ICE/TCP media port (Railway overrides via the TCP
#        proxy's RAILWAY_TCP_APPLICATION_PORT / RAILWAY_TCP_PROXY_PORT)
EXPOSE 8080 7881

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/healthcheck.sh"]

ENTRYPOINT ["/entrypoint.sh"]
