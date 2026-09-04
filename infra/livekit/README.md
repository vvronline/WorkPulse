# LiveKit on Railway (self-hosted, TCP-only media)

Self-hosted [LiveKit](https://livekit.io) SFU packaged for Railway, as an
infrastructure track independent of the rest of WorkPulse — nothing in
`server/`, `client/`, `mobile/`, or `desktop/` depends on this yet. It exists
so a real, production-shaped LiveKit deployment can be validated (join
latency, reconnect behavior, load) before any call-signaling code is wired
to it.

Based on the architecture of the community Railway template
[`sahilrupani/LiveKit-Template`](https://github.com/sahilrupani/LiveKit-Template)
(TCP-proxy port-forwarding problem statement, Redis-URL-driven config
rendering) but **not copied as-is** — see [Differences from the reference
template](#differences-from-the-reference-template) below.

## Why this exists / why TCP-only

Railway's network does not provide UDP ingress to containers, only HTTP(S)
and a manually-attached TCP proxy. WebRTC's ICE agent normally prefers UDP;
this deployment forces TCP-only media (`rtc.force_tcp: true`) so every
candidate LiveKit advertises is actually reachable through Railway's TCP
proxy, instead of silently offering unreachable UDP candidates.

```
Browser/Mobile client
   │  WSS (signaling)            → Railway HTTP proxy → $PORT
   │  TCP (ICE/media, TURN-less) → Railway TCP proxy   → RAILWAY_TCP_APPLICATION_PORT
   ▼
livekit-server (this image)
   │  private Redis (room/participant coordination, multi-node ready)
   ▼
REDIS_URL (Railway private networking)
```

## Version policy

Pinned to **`livekit/livekit-server:v1.13.6`**, by tag *and* digest
(`sha256:e37d68f172556d02aa77968b9fc55ef481468c0315fa38e4fa6c56ce72e3a815`),
in `Dockerfile`. `v1.13.6` was the latest non-prerelease release on
[github.com/livekit/livekit/releases](https://github.com/livekit/livekit/releases/tag/v1.13.6)
at authoring time, confirmed against both the GitHub Releases API and the
`livekit/livekit-server` Docker Hub tag list (its digest matched the `latest`
tag at the time of writing — confirming no separate/older image was
mistakenly pinned). **Never** point this image at `:latest`; bump the pinned
tag+digest deliberately after testing a new release.

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | Copies the pinned `livekit-server` binary onto `debian:bookworm-slim`, adds only `bash`/`ca-certificates`/`socat`/`curl`, runs as a non-root `livekit` user, validates entrypoint/healthcheck shell syntax at build time. |
| `entrypoint.sh` | Validates required env vars, sets up the TCP-proxy port forward, renders `livekit.yaml.template` → runtime config, execs `livekit-server`. |
| `livekit.yaml.template` | LiveKit config with `__PLACEHOLDER__` tokens; never contains real secrets. |
| `healthcheck.sh` | Docker `HEALTHCHECK` — calls LiveKit's built-in `GET /` liveness probe. |
| `railway.json` | Railway service build/deploy config (Dockerfile builder, restart policy, healthcheck path). |
| `.env.example` | Documents every variable this service reads. |
| `docker-compose.yml` + `validate.ps1` | **Local validation only** (see below) — not the Railway deploy path. |

## Deploy to Railway

1. Create a new Railway service from this directory (`infra/livekit`) as the
   build root, Dockerfile builder (already configured via `railway.json`).
2. Add a **private** Redis (Railway's Redis plugin, or reuse WorkPulse's
   existing Redis instance/database index). Set `REDIS_URL` to its
   **internal** connection string (Railway's `${{Redis.REDIS_URL}}` variable
   reference) — never the public one. It must use the **`redis://` scheme**;
   `rediss://` (TLS) is rejected explicitly at startup (see below) rather
   than silently connected without TLS.
3. Set `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` (e.g.
   `openssl rand -hex 16` / `openssl rand -hex 32`). These are the
   credentials any client/server will use to mint LiveKit access tokens —
   treat them as production secrets. **`LIVEKIT_API_SECRET` must be at least
   32 characters** — `entrypoint.sh` fails startup explicitly if it's
   shorter (LiveKit itself requires this for signing security; failing here
   surfaces it immediately instead of after DNS resolution/config
   rendering).
4. **Generate a public domain** for the service (Settings → Networking →
   Generate Domain). Railway injects `PORT` automatically once this exists;
   this is the public HTTPS/WSS signaling endpoint clients connect to
   (`wss://<domain>`).
5. **Add a TCP Proxy** (Settings → Networking → TCP Proxy → application port
   `7881`). Railway injects `RAILWAY_TCP_PROXY_DOMAIN`,
   `RAILWAY_TCP_PROXY_PORT`, and `RAILWAY_TCP_APPLICATION_PORT` once this
   exists.
6. **Redeploy** the service after step 5 — the TCP proxy variables are only
   visible to a build/deploy that starts after the proxy is attached.
   `entrypoint.sh` fails startup explicitly (non-zero exit, clear log
   message) if these are still missing, rather than starting in a broken
   "media unreachable" state.
7. Confirm health: Railway's own healthcheck (`railway.json`
   `healthcheckPath: "/"`) and the container `HEALTHCHECK` both hit
   LiveKit's built-in `GET /` liveness endpoint.

### Advertised vs. application port (why there's a forwarder at all)

Railway's TCP proxy has two distinct port numbers: the **application port**
your container actually receives traffic on internally
(`RAILWAY_TCP_APPLICATION_PORT`), and the **external proxy port**
(`RAILWAY_TCP_PROXY_PORT`) that clients must be told to dial on
`RAILWAY_TCP_PROXY_DOMAIN`. LiveKit's `rtc.tcp_port` setting is used both to
*bind* and to *advertise in ICE candidates*, so it can't be set to both
values at once. `entrypoint.sh` makes LiveKit bind+advertise the external
proxy port, then starts a `socat` forwarder that bridges
`RAILWAY_TCP_APPLICATION_PORT → RAILWAY_TCP_PROXY_PORT` inside the
container. `socat` is a portable userspace forwarder — no `NET_ADMIN`
capability or `iptables` binary/kernel module is required or attempted,
which matters because Railway's containers don't grant `NET_ADMIN` and
should not be assumed to have `iptables` available.

### ICE advertisement: DNS-resolved TCP-proxy IP, not STUN

Clients need to be told the **Railway TCP proxy's** address, not this
container's own address — those are different addresses, and STUN-based
"external IP" auto-detection only discovers the latter. So by default,
`entrypoint.sh`:

1. Resolves `RAILWAY_TCP_PROXY_DOMAIN` to an IPv4 address with `getent`
   (already in the base image; no extra tooling).
2. Passes that address as `--node-ip` and sets `rtc.use_external_ip: false`,
   so every ICE candidate LiveKit advertises is the actual reachable
   TCP-proxy endpoint.
3. **Fails startup explicitly** if that DNS resolution fails in production
   (`LIVEKIT_LOCAL_DEV` not `true`) — silently falling back to STUN here
   would advertise the wrong address and produce calls that "connect" at
   the signaling layer but never get media, which is worse than refusing to
   start.

Set `LIVEKIT_NODE_IP` to skip this resolution entirely and pin an explicit
address (e.g. if you know Railway's proxy DNS is temporarily unreliable, or
you're advertising a different public endpoint in front of the proxy).
STUN-based auto-detection (`use_external_ip: true`) is only ever used as a
fallback when `LIVEKIT_LOCAL_DEV=true` and no TCP proxy domain is
configured — i.e. local `docker compose` runs, never Railway.

## Redis: `redis://` only, no TLS

`REDIS_URL` must use the `redis://` scheme. `rediss://` (Redis-over-TLS) is
rejected explicitly at startup with a clear error, not silently accepted:
`livekit.yaml.template` never sets `redis.tls.enabled`, so stripping a
`rediss://` scheme and connecting anyway would silently downgrade to plain
TCP while looking configured for TLS — exactly the kind of silent
credential/security downgrade this image is designed to avoid. Correctly
rendering TLS options (`redis.tls.enabled`, CA/cert paths) was considered
and rejected for this track: Railway's private Redis networking (the
documented, recommended path above) already runs over Railway's isolated
private network, so a plaintext `redis://` connection on that path carries
no meaningful additional exposure, and adding TLS config/cert plumbing here
would be complexity with no corresponding benefit for the one Redis
topology this image documents. If a future deployment genuinely needs
Redis-over-TLS (e.g. a Redis instance outside Railway's private network),
extend `livekit.yaml.template`'s `redis:` block with `tls: { enabled: true
}` (see LiveKit's Redis config docs) and this scheme check accordingly —
don't just remove the check.

## Environment variables

See `.env.example` for the full annotated list. Summary:

| Variable | Required | Notes |
|---|---|---|
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | always | Never logged. Rendered as YAML-single-quoted scalars (safe for any content except a literal newline) into the runtime config with `chmod 600`. `LIVEKIT_API_SECRET` must be **>= 32 characters** — checked explicitly at startup, before any other setup work. Recommended generation: `openssl rand -hex 16` / `openssl rand -hex 32` (produces a sed/YAML-safe hex string, though any content works — see "Secret-safe config rendering" below). |
| `REDIS_URL` | always | Must be the **private** Railway URL, and must use the `redis://` scheme. `rediss://` is rejected at startup (see "Redis: `redis://` only, no TLS" below) instead of being silently connected in plaintext. Host/port/password are never printed to logs, even on parse failure. Password may contain any character except a literal newline. |
| `PORT` | Railway (auto) | Public HTTPS/WSS signaling port. |
| `RAILWAY_TCP_PROXY_DOMAIN` / `RAILWAY_TCP_PROXY_PORT` / `RAILWAY_TCP_APPLICATION_PORT` | Railway (auto, after step 5 above) | Drive the TCP forwarder above, and (via `RAILWAY_TCP_PROXY_DOMAIN`) the DNS-resolved `--node-ip` below. |
| `LIVEKIT_NODE_IP` | optional | Overrides DNS resolution of `RAILWAY_TCP_PROXY_DOMAIN`; pin an explicit advertised IP instead. |
| `LIVEKIT_LOG_LEVEL` | optional | `debug`\|`info`\|`warn`\|`error` (default `info`). |
| `LIVEKIT_LOCAL_DEV` | optional, **never on Railway** | `true` relaxes the `PORT`/TCP-proxy checks and the DNS-resolution requirement, for local `docker compose` runs only. |

Missing any always-required variable, or any TCP-proxy variable when
`LIVEKIT_LOCAL_DEV` is not `true`, makes `entrypoint.sh` exit non-zero with a
specific message naming exactly what's missing — there is no broad silent
fallback for production-critical settings.

## Local validation

```powershell
cd infra/livekit
./validate.ps1
```

This performs, using only `docker`/`docker compose` (no other tooling
added):

1. `docker compose build` — builds `Dockerfile`, which itself runs
   `bash -n entrypoint.sh` / `bash -n healthcheck.sh` as a build step, so a
   shell syntax error fails the build.
2. `docker compose up -d` — boots `livekit` (`LIVEKIT_LOCAL_DEV=true`) against
   a throwaway `redis:7-alpine`, exercising the full env-validation →
   config-render → `exec livekit-server` path.
3. Polls the container's `HEALTHCHECK` (LiveKit's `GET /` liveness probe via
   `curl`) until `healthy`, dumping logs and failing loudly otherwise.
4. Tears the stack down unconditionally.

`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` are generated fresh, in-process, as
random local-only values on every `validate.ps1` run — never printed,
logged, or written to disk, and never hardcoded in `docker-compose.yml`
(which fails via `${VAR:?...}` if run without them set). The
`docker-compose.yml` port mappings (`8080`, `7881`) are bound to
`127.0.0.1` only, and the throwaway Redis exposes no host port at all — none
of this local harness is reachable from the network.

It does not exercise the Railway TCP-proxy forwarding path, since
`RAILWAY_TCP_PROXY_*` variables only exist on Railway — that path is
exercised for real per the [promotion criteria](#promotion-criteria) below,
against an actual deployed Railway service.

## Single-region, TCP-only, manually-proxied — read before relying on this

- **No UDP.** Railway does not offer UDP ingress; this service runs
  permanently in forced-TCP mode. TCP media adds latency/jitter versus UDP
  and is more sensitive to head-of-line blocking on lossy networks.
- **Single region.** All traffic terminates in whatever single Railway
  region this service is deployed to; there is no multi-region failover or
  geographic routing.
- **The TCP proxy is manually configured**, not part of the Dockerfile/build.
  A fresh service (or a from-scratch redeploy of the Railway project) needs
  the TCP Proxy re-added by hand (step 5 above) before media will work —
  `entrypoint.sh` will refuse to start rather than run silently broken, but
  it cannot add the proxy for you.

### Promotion criteria

Before any real call traffic depends on this service, measure the following
under representative conditions (multiple client networks/regions, several
concurrent rooms) and require **all** of:

| Metric | Threshold |
|---|---|
| Join latency (offer → connected) | p50 < 2s, p95 < 4s |
| ICE/media connect success rate | ≥ 98% of join attempts |
| Reconnect-after-network-blip success | ≥ 95% within 5s of network restoration |
| Sustained load | target concurrent-room/participant count for ≥ 30 min with no CPU saturation, no memory growth trend, no rising error rate |

If any threshold isn't met, treat it as a signal to fix TCP-only-specific
issues (e.g. adjust `LIVEKIT_NODE_IP`, review Railway region/proxy health)
before expanding usage — not to silently loosen the criteria.

### Escape hatch: LiveKit Cloud / a UDP-capable host

If TCP-only/single-region Railway media doesn't meet the thresholds above,
the **media plane only** can move without touching the rest of WorkPulse's
Railway footprint (Postgres, existing Redis, the API/server, static
hosting):

- **[LiveKit Cloud](https://livekit.io/cloud)** — swap this self-hosted
  service for a Cloud project; only the WebSocket URL + API key/secret used
  by whatever server-side integration eventually issues tokens need to
  change. No client protocol change.
- **A UDP-capable host** (e.g. a small dedicated VM/Fly.io/Render instance
  running the same pinned `livekit-server` image with real UDP ports open)
  — same LiveKit protocol, same token/room model, just without the
  TCP-only/manual-proxy constraints.

In both cases WorkPulse's API, database, and other Railway services are
untouched — only the LiveKit endpoint + credentials a future integration
points at would change.

## Secret-safe config rendering

`livekit.yaml.template` is rendered with `sed`, but Redis passwords and API
secrets can legitimately contain characters that are special to *both* `sed`
replacement text (`\`, `&`, and this file's `|` delimiter) and to YAML
(`:`, `#`, `{`, `[`, `'`, etc.). Naively substituting a raw secret into
either would silently corrupt it (or worse, produce a differently-parsed
YAML document) instead of failing loudly. `entrypoint.sh` avoids that with
two composed steps for every value that isn't program-controlled
(Redis host:port, Redis password, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`):

1. `yaml_squote` wraps the value as a single-quoted YAML scalar, doubling any
   embedded `'`. Single-quoted YAML scalars have no escape sequences, so
   every other byte is preserved literally.
2. `sed_escape_replacement` then escapes that already-quoted string for use
   as `sed`'s replacement text (backslashes, `&`, and the `|` delimiter).

The one case this can't safely represent — a literal newline or carriage
return inside a secret — is rejected explicitly (`reject_control_chars`)
with a clear error instead of being silently dropped or truncated.
Recommended generation commands (`openssl rand -hex ...`, see
`.env.example`) only ever produce plain hex characters and never hit any of
this, but the escaping applies unconditionally so pasting an
externally-issued Redis password with arbitrary punctuation is also safe.

## Non-root / runtime constraints

- Runs as a dedicated non-root `livekit` system user (uid `10001`); the
  binary, forwarder, and rendered config are all owned by/run as that user.
- The rendered runtime config (containing the API secret and Redis password)
  lives only in `/tmp/livekit/livekit.yaml` inside the container, is
  `chmod 600`, and is regenerated (never reused) on every start; the
  read-only template shipped in the image never contains secrets.
- No `NET_ADMIN` capability and no `iptables` dependency — the TCP-proxy
  port mismatch is bridged with `socat`, a plain userspace process.
- Nothing in `entrypoint.sh` prints `REDIS_URL`, the Redis password, or the
  LiveKit API secret; log lines only ever confirm *that* parsing/rendering
  succeeded.

## Room lifecycle: `room.auto_create: false` is an integration contract

`livekit.yaml.template` deliberately disables implicit room creation
(`room.auto_create: false`, stricter than upstream's `true`) — LiveKit
rejects a join for a room that doesn't already exist. **This only works if
whatever server-side integration eventually issues LiveKit access tokens
also explicitly creates the room first** (LiveKit's `CreateRoom` Twirp/REST
API, called with the same `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`), before
handing a client a token to join it. If that integration lands without a
matching `CreateRoom` call, every join will fail with a "room not found"
style error — flip this to `true` only as a deliberate, documented decision
to trade that safety back for convenience, not as a workaround for a missing
`CreateRoom` call.

## Differences from the reference template

[`sahilrupani/LiveKit-Template`](https://github.com/sahilrupani/LiveKit-Template)
is a voice-AI demo stack (LiveKit + a Python voice agent + a web frontend);
we only reuse its `livekit-server` piece's *problem statement*, adapted as
follows:

- **Version pin**: reference used `livekit/livekit-server:latest`; this
  image pins an explicit tag **and digest** (`v1.13.6`) and documents the
  source release.
- **TCP-proxy forwarder**: reference tries `iptables` NAT redirect first and
  falls back to `haproxy` only if that fails. This image never attempts
  `iptables`/`NET_ADMIN` at all and forwards with `socat` directly, per this
  track's explicit constraint to not depend on `NET_ADMIN`/`iptables` being
  available.
- **Fail-fast**: reference silently continues with `tcp_port=7881` and
  `log_level: debug` defaults if TCP-proxy variables are absent. This image
  treats missing TCP-proxy variables (and missing `LIVEKIT_API_KEY`/
  `LIVEKIT_API_SECRET`/`REDIS_URL`/`PORT`) as fatal startup errors in
  production, with an explicit `LIVEKIT_LOCAL_DEV` opt-out for local testing
  only.
- **Secrets in logs**: reference logs the parsed Redis host:port. This image
  logs only pass/fail of parsing, never the value.
- **Non-root**: reference runs as root; this image drops to a dedicated
  non-root user.
- **ICE advertisement**: reference offers a `LIVEKIT_NODE_IP_MODE=auto`
  (STUN) toggle alongside DNS resolution and defaults its example config to
  `use_external_ip: true`/`auto`. This image defaults to resolving
  `RAILWAY_TCP_PROXY_DOMAIN` via `getent` and advertising that address
  (`use_external_ip: false`, `--node-ip <resolved>`), and fails startup in
  production if that resolution fails, rather than silently falling back to
  STUN (which would advertise the container's own address, not the proxy's).
- **Secret-safe rendering**: reference substitutes `LIVEKIT_API_KEY`/
  `LIVEKIT_API_SECRET`/the parsed Redis host:port directly into a YAML
  heredoc with no escaping. This image YAML-single-quotes and
  sed-escapes every one of those values before substitution, and explicitly
  rejects (rather than silently mangles) a value containing a literal
  newline.
- **Room policy**: `room.auto_create` defaults to `false` here (stricter —
  rooms must be created via an authenticated API call) vs. `true` upstream.
- **Scope**: reference ships a full voice-AI stack (agent + frontend); this
  track intentionally ships only the `livekit-server` piece, since WorkPulse
  doesn't yet have any code depending on LiveKit (see repo-wide search for
  `LiveKit` in `docs/CALLS.md` / `docs/SCALABILITY_REFACTOR_PLAN.md` /
  `server/.env.example` — all forward-looking mentions, no integration yet).
