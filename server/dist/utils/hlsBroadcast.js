"use strict";
/**
 * HLS broadcast helpers
 * ---------------------
 * Provisions an "HLS broadcast" for a meeting and tells the client where to
 * push media chunks (`ingestUrl`) and where viewers can pull the manifest
 * (`hlsUrl`).
 *
 * This module is intentionally pluggable. WorkPulse does not bundle its own
 * media server — instead it integrates with whatever you've stood up:
 *
 *   • OvenMediaEngine (recommended for self-host) — set HLS_MEDIA_SERVER=ovm
 *   • LiveKit Egress with HLS sink                — set HLS_MEDIA_SERVER=livekit
 *   • Mux / Cloudflare Stream / AWS IVS           — set HLS_MEDIA_SERVER=external
 *   • A simple nginx-rtmp + ffmpeg sidecar        — set HLS_MEDIA_SERVER=nginx
 *
 * If no media server is configured we return a 501 from the route — the
 * client gracefully degrades to plain WebRTC mesh mode, which is fine for
 * the first ~12 participants.
 *
 * Environment variables:
 *   HLS_MEDIA_SERVER         one of: ovm | livekit | external | nginx | ''
 *   HLS_INGEST_BASE_URL      base URL the client PUTs media chunks to
 *                            (e.g. https://media.example.com/ingest)
 *   HLS_PLAYBACK_BASE_URL    base URL clients fetch .m3u8 from
 *                            (e.g. https://media.example.com/hls)
 *   HLS_INGEST_TOKEN_SECRET  HMAC secret used to sign ingest URLs (so a
 *                            random user can't push to someone else's stream)
 *   HLS_BROADCAST_TTL_SECS   how long an ingest token is valid (default 4h)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.provisionBroadcast = provisionBroadcast;
exports.signIngestToken = signIngestToken;
exports.verifyIngestToken = verifyIngestToken;
const crypto_1 = __importDefault(require("crypto"));
const TTL = parseInt(process.env.HLS_BROADCAST_TTL_SECS || "14400", 10);
/**
 * Produce a signed token the media server can verify on each ingest PUT.
 * Format: base64url( JSON{ broadcastId, meetingId, userId, exp } ).hmac
 */
function signIngestToken({ broadcastId, meetingId, userId }) {
    const secret = process.env.HLS_INGEST_TOKEN_SECRET || process.env.JWT_SECRET || "dev-only-hls-secret";
    const payload = {
        broadcastId,
        meetingId,
        userId,
        exp: Math.floor(Date.now() / 1000) + TTL,
    };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = crypto_1.default.createHmac("sha256", secret).update(body).digest("base64url");
    return `${body}.${sig}`;
}
function verifyIngestToken(token) {
    if (!token)
        return null;
    const [body, sig] = String(token).split(".");
    if (!body || !sig)
        return null;
    const secret = process.env.HLS_INGEST_TOKEN_SECRET || process.env.JWT_SECRET || "dev-only-hls-secret";
    const expected = crypto_1.default.createHmac("sha256", secret).update(body).digest("base64url");
    // timingSafeEqual to defeat naive string-compare timing side channels
    if (expected.length !== sig.length)
        return null;
    if (!crypto_1.default.timingSafeEqual(Buffer.from(expected), Buffer.from(sig)))
        return null;
    try {
        const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
        if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000))
            return null;
        return payload;
    }
    catch {
        return null;
    }
}
/**
 * Build the ingest URL the publishing client should PUT chunks to.
 * Includes the signed token so the upstream can refuse stale / forged requests.
 */
function buildIngestUrl({ broadcastId, meetingId, userId }) {
    const base = (process.env.HLS_INGEST_BASE_URL || "").replace(/\/+$/, "");
    if (!base)
        return null;
    const token = signIngestToken({ broadcastId, meetingId, userId });
    return `${base}/${encodeURIComponent(broadcastId)}?token=${encodeURIComponent(token)}`;
}
/**
 * Build the publicly-resolvable HLS playback URL viewers fetch.
 * Most media servers expose one m3u8 per broadcast id.
 */
function buildPlaybackUrl(broadcastId) {
    const base = (process.env.HLS_PLAYBACK_BASE_URL || "").replace(/\/+$/, "");
    if (!base)
        return null;
    return `${base}/${encodeURIComponent(broadcastId)}/index.m3u8`;
}
/**
 * Provision a broadcast — returns null when no media server is configured,
 * which the caller surfaces as HTTP 501.
 */
function provisionBroadcast({ meetingId, userId }) {
    if (!process.env.HLS_MEDIA_SERVER)
        return null;
    const broadcastId = crypto_1.default.randomBytes(8).toString("hex") + "-" + meetingId;
    const ingestUrl = buildIngestUrl({ broadcastId, meetingId, userId });
    const hlsUrl = buildPlaybackUrl(broadcastId);
    if (!ingestUrl || !hlsUrl)
        return null;
    return {
        broadcastId,
        ingestUrl,
        hlsUrl,
        mediaServer: process.env.HLS_MEDIA_SERVER,
        expiresAt: Math.floor(Date.now() / 1000) + TTL,
    };
}
//# sourceMappingURL=hlsBroadcast.js.map