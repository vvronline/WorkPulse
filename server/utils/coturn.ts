/**
 * TURN / STUN credential helpers
 * ------------------------------
 * Resolves the right ICE-server config for the current request. Supports
 * four sources of TURN credentials, tried in this order:
 *
 *   1. Cloudflare Calls (recommended for Railway / serverless deployments)
 *      Set CLOUDFLARE_TURN_TOKEN_ID + CLOUDFLARE_TURN_API_TOKEN. We mint a
 *      short-lived credential by POSTing to Cloudflare's REST API.
 *
 *   2. Self-hosted coturn with `use-auth-secret` REST API (best for
 *      self-host deployments). Set TURN_HOST + TURN_STATIC_AUTH_SECRET.
 *      Username is "<unix-expiry>:<userId>"; credential is
 *      base64(HMAC-SHA1(static-auth-secret, username)).
 *      Refs: https://github.com/coturn/coturn/blob/master/README.turnserver
 *            https://datatracker.ietf.org/doc/html/draft-uberti-behave-turn-rest
 *
 *   3. Static credentials (legacy / Twilio-style providers).
 *      Set TURN_SERVER_URL + TURN_SERVER_USERNAME + TURN_SERVER_CREDENTIAL.
 *
 *   4. Public Open Relay fallback (dev only).
 *
 * Environment variables (all optional):
 *
 *   ── Cloudflare Calls ──
 *   CLOUDFLARE_TURN_TOKEN_ID       (32-char hex, from the Cloudflare dashboard)
 *   CLOUDFLARE_TURN_API_TOKEN      (long token; shown ONCE — keep secret)
 *
 *   ── Self-hosted coturn ──
 *   TURN_STATIC_AUTH_SECRET        shared secret in turnserver.conf
 *   TURN_TTL_SECONDS               credential lifetime (default: 12h, min 60s)
 *   TURN_HOST                      public hostname / IP of coturn
 *   TURN_PORT_UDP / _TCP / _TLS    defaults: 3478 / 3478 / 5349
 *   TURN_USE_TLS_443               "true" to advertise turns:host:443
 *
 *   ── Static / 3rd-party ──
 *   TURN_SERVER_URL / _USERNAME / _CREDENTIAL
 *
 *   ── Misc ──
 *   STUN_HOSTS                     comma-separated list (default: Google STUN)
 *   DISABLE_PUBLIC_TURN            "true" to suppress the Open Relay fallback
 */

import crypto from "crypto";

interface IceServer {
    urls: string | string[];
    username?: string;
    credential?: string;
}

interface CfCredCacheEntry {
    iceServers: IceServer[];
    expiresAt: number;
}

interface EphemeralCreds {
    username: string;
    credential: string;
    ttl: number;
}

interface IceConfigResult {
    iceServers: IceServer[];
    ttl: number | null;
    expiresAt?: number;
    mode: string;
    // P1.9 — whether the CLIENT is permitted to fall back to the public Open
    // Relay (openrelay.metered.ca) TURN service when its own /ice-config request
    // fails or returns no provisioned TURN. STUN is ALWAYS allowed; this flag
    // gates ONLY the public-TURN relay. Mirrors DISABLE_PUBLIC_TURN so the
    // public relay is never used in a production deployment that disabled it.
    allowPublicFallback: boolean;
}

const DEFAULT_STUN = [
    "stun:stun.l.google.com:19302",
    "stun:stun1.l.google.com:19302",
    "stun:stun.cloudflare.com:3478",
];

// In-process cache for Cloudflare credentials (keyed by userId). Cuts the
// per-call latency from ~150 ms to 0 once warmed, and keeps us well below
// Cloudflare's 1000 req/min rate limit.
const CF_TOKEN_TTL = 86_400; // 24h — Cloudflare's max
const CF_REFRESH_BEFORE = 600; // refresh 10 min before expiry
const cfCredCache = new Map<string, CfCredCacheEntry>(); // userId → { iceServers, expiresAt }

/**
 * Mint a short-lived Cloudflare Calls TURN credential.
 *
 * The official endpoint is documented at
 * https://developers.cloudflare.com/calls/turn/generate-credentials/
 *   POST https://rtc.live.cloudflare.com/v1/turn/keys/<TOKEN_ID>/credentials/generate
 *   Authorization: Bearer <API_TOKEN>
 *   { "ttl": 86400 }
 *
 * Returns null if the env vars aren't set or the request fails. Failures are
 * intentionally swallowed — the caller falls through to the next provider.
 */
async function fetchCloudflareCreds(userId?: string | number): Promise<CfCredCacheEntry | null> {
    const tokenId = process.env.CLOUDFLARE_TURN_TOKEN_ID;
    const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;
    if (!tokenId || !apiToken) return null;

    // Cache hit?
    const cacheKey = String(userId || "guest");
    const cached = cfCredCache.get(cacheKey);
    const now = Math.floor(Date.now() / 1000);
    if (cached && cached.expiresAt - now > CF_REFRESH_BEFORE) return cached;

    try {
        const resp = await fetch(
            `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(tokenId)}/credentials/generate`,
            {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiToken}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ ttl: CF_TOKEN_TTL }),
                // Hard timeout — we never want to block the /ice-config response
                // for more than 3 s on a third-party API.
                signal: AbortSignal.timeout(3000),
            }
        );
        if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            console.warn("[coturn] Cloudflare TURN API responded", resp.status, body.slice(0, 200));
            return null;
        }
        const data = await resp.json() as { iceServers?: { urls?: string | string[]; username?: string; credential?: string } };
        // The body shape is { iceServers: { urls: [...], username, credential } }
        // (note: `iceServers` here is a single object, not an array).
        const ice = data?.iceServers;
        if (!ice?.urls || !ice?.username || !ice?.credential) {
            console.warn("[coturn] Cloudflare TURN API returned unexpected shape:", JSON.stringify(data).slice(0, 200));
            return null;
        }

        // Augment Cloudflare's URL list with the corporate-firewall escape hatch.
        // Cloudflare's TURN service DOES accept `turns:turn.cloudflare.com:443`
        // but their /credentials/generate response doesn't return it by default.
        // Without 443/TLS, users behind enterprise proxies that only allow
        // outbound 443 can't open a TURN allocation at all → call fails.
        // We also explicitly add tcp variants on 5349 in case the default list
        // ever changes.
        const cfUrls = Array.isArray(ice.urls) ? ice.urls : [ice.urls];
        const augmented = [...new Set([
            ...cfUrls,
            "turn:turn.cloudflare.com:3478?transport=udp",
            "turn:turn.cloudflare.com:3478?transport=tcp",
            "turns:turn.cloudflare.com:5349?transport=tcp",
            "turns:turn.cloudflare.com:443?transport=tcp", // corporate proxy lifeline
        ])];

        const result: CfCredCacheEntry = {
            iceServers: [
                // Keep STUN as a separate entry (some browsers ignore stun: URLs
                // that share an entry with TURN credentials).
                { urls: "stun:stun.cloudflare.com:3478" },
                { urls: "stun:stun.l.google.com:19302" },
                {
                    urls: augmented,
                    username: ice.username,
                    credential: ice.credential,
                },
            ],
            expiresAt: now + CF_TOKEN_TTL,
        };
        cfCredCache.set(cacheKey, result);
        return result;
    } catch (err: unknown) {
        console.warn("[coturn] Cloudflare TURN credential fetch failed:", (err as Error)?.message || err);
        return null;
    }
}

/**
 * Build STUN server entries from STUN_HOSTS or fall back to public defaults.
 */
function buildStunServers(): IceServer[] {
    const raw = (process.env.STUN_HOSTS || "").trim();
    if (!raw) return DEFAULT_STUN.map(u => ({ urls: u }));
    return raw
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
        .map(host => ({ urls: host.startsWith("stun:") ? host : `stun:${host}` }));
}

/**
 * Build the list of TURN URLs to advertise (UDP, TCP, and optionally TLS:443).
 * TURN-over-TLS-on-443 is critical for corporate networks that only allow
 * outbound 443 — the traffic is indistinguishable from HTTPS.
 */
function buildTurnUrlList(): string[] | null {
    const host = process.env.TURN_HOST;
    if (!host) return null;

    const portUdp = process.env.TURN_PORT_UDP || "3478";
    const portTcp = process.env.TURN_PORT_TCP || "3478";
    const portTls = process.env.TURN_PORT_TLS || "5349";
    const useTls443 = String(process.env.TURN_USE_TLS_443 || "true").toLowerCase() === "true";

    const urls = [
        `turn:${host}:${portUdp}?transport=udp`,
        `turn:${host}:${portTcp}?transport=tcp`,
        `turns:${host}:${portTls}?transport=tcp`,
    ];
    if (useTls443) urls.push(`turns:${host}:443?transport=tcp`);
    return urls;
}

/**
 * Generate ephemeral TURN credentials per the REST API spec.
 * Returns null if no shared secret is configured.
 */
function generateEphemeralCreds(userId?: string | number): EphemeralCreds | null {
    const secret = process.env.TURN_STATIC_AUTH_SECRET;
    if (!secret) return null;

    const ttl = Math.max(60, parseInt(process.env.TURN_TTL_SECONDS || "43200", 10)); // 12h default
    const expiry = Math.floor(Date.now() / 1000) + ttl;
    const username = `${expiry}:${userId || "guest"}`;
    const credential = crypto.createHmac("sha1", secret).update(username).digest("base64");
    return { username, credential, ttl };
}

/**
 * Build the final iceServers array for a given user.
 *
 * NOTE: now ASYNC — Cloudflare credential minting is an HTTP call. The
 * legacy synchronous build path (no Cloudflare configured) is unchanged
 * apart from being awaited; perf impact is zero when Cloudflare env vars
 * aren't set.
 */
async function buildIceServers(userId?: string | number): Promise<IceConfigResult> {
    const iceServers = buildStunServers();

    // P1.9 — single source of truth for whether the CLIENT may use the public
    // Open Relay TURN service as a last resort. STUN is always allowed; this
    // gates ONLY the public TURN relay and mirrors DISABLE_PUBLIC_TURN so a
    // production deployment that disabled the public relay server-side ALSO
    // forbids the client's hard-coded public-TURN fallback.
    const allowPublicFallback =
        String(process.env.DISABLE_PUBLIC_TURN || "false").toLowerCase() !== "true";

    // 1) Preferred when configured: Cloudflare Calls (zero ops, generous free tier).
    //    Cloudflare's response already bundles their STUN URL inside the
    //    iceServers entry, so we drop our DEFAULT_STUN list to avoid handing
    //    the browser duplicate / lower-quality alternatives.
    const cf = await fetchCloudflareCreds(userId);
    if (cf) {
        return {
            iceServers: cf.iceServers,
            ttl: cf.expiresAt - Math.floor(Date.now() / 1000),
            expiresAt: cf.expiresAt,
            mode: "cloudflare-calls",
            allowPublicFallback,
        };
    }

    // 2) Self-hosted coturn with ephemeral REST creds (most secure for self-host)
    const turnUrls = buildTurnUrlList();
    const eph = generateEphemeralCreds(userId);
    if (turnUrls && eph) {
        iceServers.push({
            urls: turnUrls,
            username: eph.username,
            credential: eph.credential,
        });
        return { iceServers, ttl: eph.ttl, mode: "coturn-rest", allowPublicFallback };
    }

    // 3) Legacy static creds (Twilio-style providers, or coturn with `lt-cred-mech`)
    const legacyUrl = process.env.TURN_SERVER_URL;
    const legacyUser = process.env.TURN_SERVER_USERNAME;
    const legacyCred = process.env.TURN_SERVER_CREDENTIAL;
    if (legacyUrl && legacyUser && legacyCred) {
        iceServers.push({
            urls: legacyUrl,
            username: legacyUser,
            credential: legacyCred,
        });
        return { iceServers, ttl: null, mode: "static", allowPublicFallback };
    }

    // 4) Public Open Relay fallback (development only — DO NOT use in prod)
    if (allowPublicFallback) {
        iceServers.push(
            { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
            { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
            { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
        );
        return { iceServers, ttl: null, mode: "public-fallback", allowPublicFallback };
    }

    return { iceServers, ttl: null, mode: "stun-only", allowPublicFallback };
}

export {
    buildIceServers,
    generateEphemeralCreds,
    buildTurnUrlList,
    buildStunServers,
    fetchCloudflareCreds,
};