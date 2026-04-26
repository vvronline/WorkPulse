# Audio / Video Calls & Meetings — Operations Guide

This document covers the production setup for WorkPulse's WebRTC-based calls
and meetings, with special attention to the two failure modes that cause
~90% of real-world support tickets:

1. **Corporate proxy / firewall blocking UDP and STUN** — staff inside an
   enterprise network see "connecting…" forever, then a dropped call.
2. **Mobile network handoff (WiFi ↔ cellular) and weak signals** — a call
   that worked perfectly drops 30 seconds after the user steps outside.

Both are addressed with a self-hosted [coturn](https://github.com/coturn/coturn)
TURN server. The optional HLS broadcast pipeline (mirrors the
[videosdk-hls-react-sdk-example](https://github.com/videosdk-live/videosdk-hls-react-sdk-example)
architecture) lets meetings scale beyond ~12 active participants by demoting
non-speakers to a low-cost HLS viewer.

---

## 1. Architecture overview

```
         ┌────────────────────────────────────────────────────────┐
         │                       Browser A                         │
         │  useWebRTC.js / useMeetingState.js                      │
         └─────────────┬─────────────────────────┬─────────────────┘
                       │                         │
              WebSocket signalling      ICE candidates / DTLS / SRTP
                       │                         │
                       ▼                         ▼
        ┌──────────────────────┐    ┌──────────────────────────┐
        │  WorkPulse server    │    │  coturn (self-hosted)    │
        │  /api/chat/ice-config│◄──►│  • STUN  3478 udp/tcp    │
        │  signs ephemeral     │    │  • TURN  3478 udp/tcp    │
        │  HMAC creds          │    │  • TURNS 5349 tls        │
        │                      │    │  • TURNS 443  tls ←──┐   │
        └──────────────────────┘    └──────────────────────┘   │
                                                ▲              │
                                                │              │
                       ┌────────────────────────┴──────────────┴──┐
                       │                       Browser B (corporate net) │
                       │  iceTransportPolicy=relay → only TURN over 443  │
                       └──────────────────────────────────────────────────┘
```

- **STUN** lets each browser discover its public IP. Cheap and free, but
  fails behind symmetric NAT (most large enterprises) and any UDP-blocking
  firewall.
- **TURN** relays the actual media. WorkPulse advertises four URLs so the
  browser can pick the one that works:
  | URL                                 | Protocol | Port | Use case                   |
  | ----------------------------------- | -------- | ---- | -------------------------- |
  | `turn:HOST:3478?transport=udp`      | UDP      | 3478 | Best path — low latency    |
  | `turn:HOST:3478?transport=tcp`      | TCP      | 3478 | UDP blocked                |
  | `turns:HOST:5349?transport=tcp`     | TLS      | 5349 | TCP-over-DPI environments  |
  | `turns:HOST:443?transport=tcp`      | TLS      | 443  | Corporate proxy escape     |
- The client (`useWebRTC.js`) automatically escalates from "any candidate"
  → ICE restart → `iceTransportPolicy=relay` (TURN-only) when UDP fails. So
  a user behind a strict corporate proxy still gets connected — just over
  TLS:443.

## 2. coturn — quick deploy

### 2a. Provision a host

You need a Linux box with:

- A public, **static** IP (or DNS A record pointing at it)
- Outbound + inbound on TCP/UDP ports 3478, 5349, 443, plus a UDP relay
  range. We default to `49152–49200` (~50 ports = ~25 simultaneous calls
  per box; widen as needed).
- A TLS certificate for the hostname (Let's Encrypt is fine).

Smallest workable spec for ~50 concurrent video calls: 2 vCPU, 4 GB RAM,
**100 Mbps of egress** (this is the real bottleneck — each video call
relayed through TURN consumes ~1 Mbps both ways).

### 2b. Configure secrets

```bash
# On the WorkPulse server's .env (and in infra/coturn/.env):
TURN_HOST=turn.your-domain.com
TURN_STATIC_AUTH_SECRET=$(openssl rand -hex 32)
TURN_USE_TLS_443=true
DISABLE_PUBLIC_TURN=true        # don't fall through to public Open Relay in prod
TURN_EXTERNAL_IP=203.0.113.10   # ← REQUIRED on cloud / NAT'd hosts
```

The same `TURN_STATIC_AUTH_SECRET` MUST be set on both the WorkPulse server
(it signs ephemeral credentials) and the coturn host (it verifies them).
Mismatch → every call fails with "ICE failed".

### 2c. Drop in the TLS certificate

```bash
# On the coturn host
mkdir -p infra/coturn/certs
# Either Let's Encrypt:
certbot certonly --standalone -d turn.your-domain.com
cp /etc/letsencrypt/live/turn.your-domain.com/fullchain.pem infra/coturn/certs/
cp /etc/letsencrypt/live/turn.your-domain.com/privkey.pem   infra/coturn/certs/

# Or, just to test: skip this step and the entrypoint will generate a self-signed
# cert automatically (you'll see "DEV ONLY" in the logs).
```

### 2d. Start coturn

```bash
cd infra/coturn
docker compose up -d
docker logs -f workpulse-coturn
```

You should see lines like:

```
[entrypoint] external-ip=203.0.113.10
0: log file opened: /var/tmp/turn_…
0: SERVER: relay endpoint #0 bound to ports 49152..49200
0: TURN Server starting
```

### 2e. Verify with Trickle ICE

Open Chrome's tester at <https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/>
and add **all four** TURN URLs with username = `0:test` and any password (it
won't actually authenticate but the candidate gathering still confirms
the ports are reachable). You want at least one `relay` candidate.

For a real auth check, run `turnutils_uclient` on the coturn host:

```bash
docker exec -it workpulse-coturn \
  turnutils_uclient -t -T -u "0:diagnostic" -w "anything" \
  -p 3478 127.0.0.1
```

A successful run prints `OK: Allocated relay address …`.

### 2f. Restart WorkPulse with the new env vars

```bash
# Inside server/.env or your secrets manager:
TURN_HOST=turn.your-domain.com
TURN_STATIC_AUTH_SECRET=… (the same value as coturn)
TURN_USE_TLS_443=true
DISABLE_PUBLIC_TURN=true
```

```bash
cd server && npm restart
```

In the browser DevTools you should now see:

```
[call-webrtc] ICE config refreshed (mode: coturn-rest, expiresAt: 1714032432)
```

If you instead see `mode: public-fallback` you forgot to set
`TURN_HOST`/`TURN_STATIC_AUTH_SECRET` on the WorkPulse server.

## 3. Diagnosing call failures

| Symptom in DevTools console                                                       | Likely cause                                                       | Fix                                                                                              |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `[call-webrtc] No TURN server configured…`                                         | Server returned only STUN — env vars missing                       | Set `TURN_HOST` + `TURN_STATIC_AUTH_SECRET` on the server                                        |
| `ICE failed` after `host` and `srflx` candidates only                              | Symmetric NAT or UDP blocked, no relay candidate                   | Check coturn host firewall; verify `external-ip` matches the public IP                            |
| `[call-webrtc] escalating to RELAY-ONLY mode after ICE restart failed`            | Corporate firewall blocks UDP entirely                              | Confirm 443/TCP TLS path works (`TURN_USE_TLS_443=true`); test with Trickle ICE                  |
| `[call-webrtc] ICE candidate error: 401`                                           | Credentials rejected by coturn                                      | `TURN_STATIC_AUTH_SECRET` mismatch between server and coturn                                     |
| `[call-webrtc] ICE candidate error: 701`                                           | Server reachable but no relay allocated                             | UDP relay range (`min-port`/`max-port`) blocked on the host firewall                              |
| Call drops 30s after switching from WiFi to cellular                              | ICE restart never triggered                                         | Should be automatic via `connection.change` + `online` events; verify both events fire           |
| `NotReadableError: Could not start video source`                                   | Camera/mic in use by another app                                   | Close Zoom/Teams/Skype; on Windows: Settings → Privacy → Camera → "Allow desktop apps"           |
| `OverconstrainedError: width: 1280`                                                | Camera doesn't support requested resolution                         | Already handled — we fall through 5 progressively-relaxed profiles. If you still see this, file a bug. |

## 4. HLS broadcast (large meetings)

When meetings exceed ~12 active speakers the WebRTC mesh blows up
exponentially (each new peer doubles uploads for everyone). The HLS
broadcast pattern lets you keep N "speakers" on WebRTC and demote everyone
else to passive viewers receiving a single ~6s-latency HLS stream.

### 4a. Pick a media server

WorkPulse doesn't bundle one — pick whatever fits your infra:

| Backend            | When to pick it                                              |
| ------------------ | ------------------------------------------------------------ |
| **OvenMediaEngine** | Best self-hosted option; native LL-HLS support               |
| **LiveKit Egress**  | Already running LiveKit; just enable HLS sink                |
| **nginx-rtmp + ffmpeg** | Minimal cost; need to write the ffmpeg recipe yourself  |
| **Mux / Cloudflare Stream** | Don't want to operate a media server                |

### 4b. Configure WorkPulse

```bash
# server/.env
HLS_MEDIA_SERVER=ovm                              # or livekit / nginx / external
HLS_INGEST_BASE_URL=https://media.example.com/ingest
HLS_PLAYBACK_BASE_URL=https://media.example.com/hls
HLS_INGEST_TOKEN_SECRET=$(openssl rand -hex 32)
HLS_BROADCAST_TTL_SECS=14400                      # 4 hours
```

The server hands out signed ingest URLs of the form
`<HLS_INGEST_BASE_URL>/<broadcastId>?token=<HMAC>`. Configure your media
server to verify the HMAC against `HLS_INGEST_TOKEN_SECRET`; the format is
`base64url(JSON{broadcastId, meetingId, userId, exp}).hmac_sha256`.

### 4c. Use it from the UI

```jsx
import { useHlsBroadcast } from '@/components/meeting/useHlsBroadcast';
import HlsViewer from '@/components/meeting/HlsViewer';

function MeetingRoom({ meetingCode, isHost, getMixedStream, hlsUrl }) {
    const { state, start, stop } = useHlsBroadcast({ meetingCode, getMixedStream });

    return (
        <>
            {isHost && (
                <button onClick={state === 'live' ? stop : start}>
                    {state === 'live' ? 'Stop broadcast' : 'Go live'}
                </button>
            )}
            {hlsUrl && <HlsViewer src={hlsUrl} />}
        </>
    );
}
```

`getMixedStream` is your function that returns a single `MediaStream`
combining the meeting's audio (mixed via Web Audio's `AudioContext`) and
whichever video track should appear (active speaker or screen share).

## 5. Required client-side dependency

If you use `<HlsViewer />` you need `hls.js` for non-Safari browsers:

```bash
cd client
npm install hls.js
```

The component dynamically imports it, so users on Safari (which has native
HLS support) never download the bundle.

## 6. Deploying on Railway

WorkPulse itself runs great on Railway (see `RAILWAY_DEPLOYMENT.md`), but the
two media-plane services — coturn and an HLS media server — have UDP / port
requirements that **Railway is not designed for**. Here is the honest
breakdown of what works and what doesn't:

### 6a. Why coturn doesn't fit Railway natively

| coturn requirement                                              | Railway reality                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Bind a wide UDP port range for relay endpoints (e.g. 49152-49200) | Railway's TCP/UDP proxy maps **one port at a time**, not ranges          |
| See the real client IP via `external-ip`                        | Railway proxies all traffic — coturn would advertise the proxy IP        |
| Run on a public, static IP                                      | Railway re-IPs services on each deploy unless you pay for a static egress |
| Listen on privileged port 443 (for TLS-over-443 escape)          | Possible, but the same proxy issue applies                                |

You *can* hack it (single-port mode + `min-port=max-port=N`), but it caps
you at ~1 simultaneous call per port and the relay candidates won't be
routable for clients behind strict NATs — which defeats the entire point of
running TURN. **Don't put coturn on Railway in production.**

### 6b. Three Railway-friendly options

#### Option 1 — Cloudflare Calls TURN (zero ops, recommended for Railway)

`server/utils/coturn.js` has **first-class Cloudflare Calls support**:
on every `/api/chat/ice-config` request the server mints short-lived
credentials via Cloudflare's REST API and hands them to the browser.

**Setup (5 minutes):**

1. Sign up at <https://dash.cloudflare.com> (free) and pick any account.
2. Open **Calls** in the left sidebar → **Create TURN Server App** → name
   it `workpulse`.
3. Copy the two values Cloudflare shows you:
   - **Turn Token ID** (a 32-char hex string)
   - **API Token** (only shown once — copy it now!)
4. On your Railway WorkPulse service → **Variables** → add (paste YOUR
   own values, never commit them to git):

   ```bash
   CLOUDFLARE_TURN_TOKEN_ID=<your-token-id>
   CLOUDFLARE_TURN_API_TOKEN=<your-api-token>
   DISABLE_PUBLIC_TURN=true
   ```

   > **Security note**: the API Token is shown by Cloudflare exactly once.
   > Treat it like a password — store it only in Railway's secret manager
   > (or a `.env` file that is in your `.gitignore`). Never put it in
   > source code, commit messages, or chat logs. If you accidentally leak
   > one, rotate it immediately from the Cloudflare dashboard.
5. Click **Redeploy**.

In browser DevTools you should now see:
```
[call-webrtc] ICE config refreshed (mode: cloudflare-calls, expiresAt: ...)
```

That's it. **Free tier covers 1 TB/month** — plenty for hundreds of users.
The credentials are cached in-process for 24h with auto-refresh, so you'll
only hit Cloudflare's API ~once per user per day.

**Other managed alternatives** (use OPTION C / static creds in `server/.env.example`):

| Provider                         | Free tier                | Pricing                      |
| -------------------------------- | ------------------------ | ---------------------------- |
| **Twilio Network Traversal**     | None — pay as you go     | $0.40/GB                     |
| **Xirsys**                       | Limited free tier         | $33/mo for hobby plan        |
| **Metered Open Relay (paid)**    | Free dev tier             | $20/mo for 50 GB             |

#### Option 2 — coturn on a $5 VPS (best price/performance for self-host)

Spin up the smallest VPS you can find (Hetzner CX11 €4/mo, DigitalOcean
$4/mo, Vultr $3.50/mo, Oracle Cloud Free Tier — all work). Then on the VPS:

```bash
git clone https://github.com/your-org/WorkPulse
cd WorkPulse/infra/coturn
echo TURN_STATIC_AUTH_SECRET=$(openssl rand -hex 32) > .env
echo TURN_EXTERNAL_IP=$(curl -s https://api.ipify.org) >> .env
docker compose up -d
```

Then on **Railway**, add the matching env vars to your WorkPulse service:

```bash
TURN_HOST=<vps-public-ip-or-dns>
TURN_STATIC_AUTH_SECRET=<same value as on the VPS>
TURN_USE_TLS_443=true
DISABLE_PUBLIC_TURN=true
```

This gives you the best corporate-proxy traversal because you control
TLS-on-443 (managed providers usually only offer 3478/5349).

#### Option 3 — Fly.io for both coturn and HLS

If you want everything in one place but Railway isn't suitable, [Fly.io](https://fly.io)
has first-class UDP support (their `fly.toml` lets you allocate a UDP port
range) and IPv4 anycast. Drop the `infra/coturn/` files into a Fly app:

```toml
# fly.toml
app = "workpulse-coturn"

[[services]]
  protocol = "udp"
  internal_port = 3478
  ports = [{ port = 3478 }]

[[services]]
  protocol = "tcp"
  internal_port = 443
  ports = [{ port = 443, handlers = ["tls"] }]
# ... add per-port entries for 49152-49200/udp
```

WorkPulse on Railway points its `TURN_HOST` at `<app-name>.fly.dev`.

### 6c. HLS media server on Railway

Same story — **don't run OvenMediaEngine/Mediasoup/nginx-rtmp on Railway**.
Pick instead:

| Backend             | Hosting        | Cost rough estimate          |
| ------------------- | -------------- | ---------------------------- |
| **Mux**             | Fully managed  | ~$0.005/min ingest + $0.0012/min delivery |
| **Cloudflare Stream** | Fully managed | $5/1000 min stored + $1/1000 min delivered |
| **AWS IVS**         | Fully managed  | ~$2/hour broadcast + $0.10/GB delivery |
| **OvenMediaEngine on Fly.io** | DIY  | ~$5/mo for low traffic         |

For Mux on Railway, set:

```bash
HLS_MEDIA_SERVER=external
HLS_INGEST_BASE_URL=https://global-live.mux.com/app/<your-stream-key>
HLS_PLAYBACK_BASE_URL=https://stream.mux.com
HLS_INGEST_TOKEN_SECRET=$(openssl rand -hex 32)
```

(The exact Mux URLs will depend on your account — check their docs for the
"low-latency HLS via fragmented MP4" recipe.)

### 6d. TL;DR Railway recipe

If you want the smallest moving-parts setup that just works:

1. **WorkPulse server + Postgres** on Railway (already done, see RAILWAY_DEPLOYMENT.md)
2. **TURN** on Cloudflare Calls (free up to 1 TB/mo) — set 3 env vars
3. **HLS** skipped entirely if your meetings stay under ~12 active speakers
   (the WebRTC mesh handles it). Add Mux later if you grow.

That's $0 extra at small scale and ~5 minutes of setup.

---

## 7. Production hardening checklist

- [ ] `TURN_STATIC_AUTH_SECRET` is at least 32 random bytes (`openssl rand -hex 32`)
- [ ] `DISABLE_PUBLIC_TURN=true` on the WorkPulse server
- [ ] coturn host firewall allows: 3478/tcp, 3478/udp, 5349/tcp, 443/tcp, 49152-49200/udp
- [ ] coturn `external-ip` matches the public IP (cloud / NAT'd hosts)
- [ ] Real Let's Encrypt cert mounted into `infra/coturn/certs/` (not the dev self-signed)
- [ ] coturn cert auto-renews (cron or `certbot.timer`)
- [ ] coturn `denied-peer-ip` rules cover all your private RFC1918 ranges
- [ ] Monitoring on coturn: bandwidth / active sessions / TLS handshake failures
- [ ] `HLS_INGEST_TOKEN_SECRET` distinct from `JWT_SECRET` and `TURN_STATIC_AUTH_SECRET`
- [ ] Media server HLS endpoint is on its own subdomain with proper CORS for
      the WorkPulse origins
- [ ] Load-test with [Selkies](https://github.com/selkies-project/selkies-gstreamer)
      or your own headless-Chrome herd before launch