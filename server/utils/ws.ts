/**
 * WebSocket server for real-time notifications and chat.
 * Attaches to the HTTP server and authenticates via the JWT cookie.
 *
 * STATUS / PRESENCE NOTE (status service v2):
 *   • Every WS connection registers a session with `statusService.openSession`
 *     and closes it on disconnect / pong-timeout via `statusService.closeSession`.
 *   • That is the canonical source of presence + per-device activity. The
 *     legacy `presence_change` / `status_change` events were removed in PR7;
 *     clients now subscribe to the unified `user_status` event broadcast by
 *     services/status/broadcaster.js.
 */
import { randomUUID } from "crypto";
import type { Server as HTTPServer } from "http";
import type { IncomingMessage } from "http";
import { logger, logPushCallLifecycle } from "./logger";
import { chatMessage } from "./wsHandlers/chatMessage";
import { withIdempotency, withIdempotentCallAction } from "./wsIdempotency";
import { schema, validate } from "./wsValidate";
import { pushNotifications } from "../services/pushNotifications";
const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");
const cookie = require("cookie");
const { masterQuery } = require("../db");
const { getTenantPool, getTenantById } = require("./tenantManager");
const redis = require("../redis");
const statusService = require("../services/status");
const wsMetrics = require("./wsMetrics");

type Query = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: any[]; rowCount?: number | null }>;

interface DbLike {
  query: Query;
  transaction?: (fn: (client: unknown) => Promise<unknown>) => Promise<unknown>;
}

/**
 * Extended WebSocket — the `ws` library's socket plus the bag of
 * per-connection state we stash directly on the instance (auth bookkeeping,
 * status-session key, active meeting, rate-limit window, etc.).
 */
interface ExtWS {
  readyState: number;
  isAlive?: boolean;
  db?: DbLike;
  tenantId?: number | null;
  userId?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: string, cb: (...args: any[]) => void): void;
  [key: string]: any;
}

type WSType = string;

// Phase 6 — Per-message default soft-timeout. Most handlers should complete
// in well under a second; if any handler hangs for > 5s it almost certainly
// represents a runaway DB query (deadlock, missing index) or an upstream
// service hang. Surface it as a timeout error in metrics so we can see
// which handler is the culprit without piling up open WS frames.
//
// 0 means "no timeout" — set per-handler below for the few that are
// allowed to be slow (notably the legacy /meeting_chat persist that we
// already harden with its own try/catch).
const WS_HANDLER_DEFAULT_TIMEOUT_MS = 5_000;

// How often (per socket) to re-validate the JWT's token_version against the
// live value while the socket is open. Closes sockets whose session was
// revoked (logout / forced sign-out / password change) or whose JWT expired.
const WS_AUTH_RECHECK_MS = 60_000;

/** Map<clientKey, Set<WebSocket>> — local instance connections, keyed by tenantId:userId */
const clients = new Map<string, Set<ExtWS>>();

/** Max WebSocket connections a single user may hold per server instance.
 *  Each browser tab uses ~4 WS connections (chat, calls, status, notifications)
 *  so allow enough for 2-3 tabs or a browser + desktop app. */
const MAX_CONNECTIONS_PER_USER = 12;

function recordCallTransitionFailure(data: Record<string, unknown>): void {
  if (typeof wsMetrics?.recordCallTransitionFailure === "function") {
    wsMetrics.recordCallTransitionFailure(data);
  }
}

interface PendingMeetingLeave {
  timer: NodeJS.Timeout;
  db: DbLike;
}

/**
 * Pending meeting-leave timers — when a WS that was inside a meeting closes,
 * we DON'T immediately broadcast `meeting_participant_left`. We schedule a
 * delayed cleanup so that a flaky network / WS reconnect doesn't kick the
 * user out of the meeting (and doesn't tear down the other participants'
 * RTCPeerConnections). If the user re-opens a WS and sends `meeting_join`
 * within the grace window, the timer is cancelled and the meeting continues
 * uninterrupted. See `scheduleMeetingDisconnectCleanup` below.
 *
 * Keyed by `${tenantId}:${userId}:${meetingId}` → { timer, db }.
 */
const pendingMeetingLeaves = new Map<string, PendingMeetingLeave>();
const MEETING_DISCONNECT_GRACE_MS = 15_000;
const meetingLeaveKey = (
  tenantId: number | null | undefined,
  userId: number,
  meetingId: number,
): string => `${tenantId || 0}:${userId}:${meetingId}`;

/** Unique instance ID for Pub/Sub dedup */
const INSTANCE_ID = `ws-${process.pid}-${Date.now()}`;

/** Composite key for the clients Map to prevent cross-tenant collisions */
function clientKey(
  tenantId: number | null | undefined,
  userId: number,
): string {
  return `${tenantId || 0}:${userId}`;
}

// ── WS relay membership cache ──────────────────────────────────────────────
// WebRTC signaling (ICE candidates / *-state) trickles at high frequency; a
// DB round-trip per frame would exhaust the connection pool. We cache
// per-(room-kind, roomId, userId) membership for a short TTL so every relay
// can cheaply verify BOTH the sender AND the target are members of the
// conversation/meeting before forwarding. This closes the IDOR where any
// authenticated tenant user could inject signaling/control frames to an
// arbitrary userId. A removed/revoked participant is shut out within
// MEMBERSHIP_TTL_MS. Checks fail CLOSED on DB error.
const _membershipCache = new Map<string, { ok: boolean; expiresAt: number }>();
const MEMBERSHIP_TTL_MS = 10_000;
const MEMBERSHIP_CACHE_MAX = 5000;

async function _checkMembership(
  db: DbLike,
  key: string,
  sql: string,
  params: unknown[],
): Promise<boolean> {
  const now = Date.now();
  const cached = _membershipCache.get(key);
  if (cached && cached.expiresAt > now) return cached.ok;
  let ok = false;
  try {
    ok = !!(await db.query(sql, params)).rows[0];
  } catch (err: any) {
    logger.warn({ err: err.message, key }, "ws membership check failed");
    return false; // fail closed — don't relay if we can't verify
  }
  _membershipCache.set(key, { ok, expiresAt: now + MEMBERSHIP_TTL_MS });
  if (_membershipCache.size > MEMBERSHIP_CACHE_MAX) {
    const oldest = _membershipCache.keys().next().value;
    if (oldest !== undefined) _membershipCache.delete(oldest);
  }
  return ok;
}

/** Is `userId` a participant of the given conversation? (cached) */
async function isConversationMember(
  db: DbLike,
  conversationId: number,
  userId: number,
): Promise<boolean> {
  if (!conversationId || !userId) return false;
  return _checkMembership(
    db,
    `conv:${conversationId}:${userId}`,
    "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
    [conversationId, userId],
  );
}

/** Is `userId` a participant (joined or invited) of the given meeting? (cached) */
async function isMeetingMember(
  db: DbLike,
  meetingId: number,
  userId: number,
): Promise<boolean> {
  if (!meetingId || !userId) return false;
  return _checkMembership(
    db,
    `meet:${meetingId}:${userId}`,
    `SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2 AND status IN ('joined','invited')`,
    [meetingId, userId],
  );
}

// ── Per-call WebRTC signal buffer (Signal-Android reliable-delivery parity) ──
// ROOT-CAUSE FIX for "answered but never connects / black screen / can't connect
// from push": `call_signal` was a pure fire-and-forget relay (deliverLocal only
// writes to OPEN sockets and drops the frame otherwise). When the callee answers
// from a push / lock-screen / cold start, the caller emits its OFFER the instant
// `call_accepted` arrives — but the callee's call screen needs 1–5s to mount,
// acquire media and subscribe to `call_signal`. The offer (and early ICE) landed
// before the callee was listening and was SILENTLY DROPPED, so the callee never
// answered and the call hung forever.
//
// We now BUFFER the latest offer + any ICE candidates destined for a user who
// has no open socket (or hasn't signalled readiness yet), keyed per call, and
// REPLAY them the moment that user subscribes (`call_subscribe`), accepts
// (`call_accept`), or signals `call_ready`. This is the direct analogue of
// Signal's reliable signaling delivery. Buffers auto-expire and are cleared on
// any terminal call transition.
interface BufferedCallSignals {
  // Latest offer destined for each target user (keyed by targetUserId). A
  // newer offer (e.g. ICE-restart / relay rebuild) supersedes the previous one.
  offerByUser: Map<number, { fromUserId: number; signal: any }>;
  // Ordered ICE candidates destined for each target user, awaiting their
  // remote description / subscription.
  iceByUser: Map<number, Array<{ fromUserId: number; signal: any }>>;
  expiresAt: number;
}

const CALL_SIGNAL_BUFFER_TTL_MS = 60_000;
const CALL_SIGNAL_BUFFER_MAX_CALLS = 2000;
const CALL_SIGNAL_BUFFER_MAX_ICE_PER_USER = 80;
const _callSignalBuffers = new Map<number, BufferedCallSignals>();

function _pruneCallSignalBuffers(now: number): void {
  for (const [callId, buf] of _callSignalBuffers) {
    if (buf.expiresAt <= now) _callSignalBuffers.delete(callId);
  }
  // Hard cap: drop the oldest entry if we somehow exceed the ceiling.
  if (_callSignalBuffers.size > CALL_SIGNAL_BUFFER_MAX_CALLS) {
    const oldest = _callSignalBuffers.keys().next().value;
    if (oldest !== undefined) _callSignalBuffers.delete(oldest);
  }
}

function _getOrCreateCallBuffer(callId: number): BufferedCallSignals {
  const now = Date.now();
  let buf = _callSignalBuffers.get(callId);
  if (!buf || buf.expiresAt <= now) {
    buf = {
      offerByUser: new Map(),
      iceByUser: new Map(),
      expiresAt: now + CALL_SIGNAL_BUFFER_TTL_MS,
    };
    _callSignalBuffers.set(callId, buf);
    _pruneCallSignalBuffers(now);
  } else {
    buf.expiresAt = now + CALL_SIGNAL_BUFFER_TTL_MS;
  }
  return buf;
}

/** Buffer an offer/ice signal destined for a target user with no live socket. */
function bufferCallSignal(
  callId: number,
  fromUserId: number,
  targetUserId: number,
  signal: any,
): void {
  if (!callId || !targetUserId || !signal) return;
  if (signal.type !== "offer" && signal.type !== "ice-candidate") return;
  const buf = _getOrCreateCallBuffer(callId);
  if (signal.type === "offer") {
    // Keep only the LATEST offer — a newer one (ICE-restart / relay rebuild)
    // makes the previous one obsolete.
    buf.offerByUser.set(targetUserId, { fromUserId, signal });
    // An offer marks a fresh negotiation: drop stale ICE buffered against the
    // PREVIOUS offer so we never replay candidates from a dead transport.
    buf.iceByUser.delete(targetUserId);
  } else {
    let list = buf.iceByUser.get(targetUserId);
    if (!list) {
      list = [];
      buf.iceByUser.set(targetUserId, list);
    }
    list.push({ fromUserId, signal });
    if (list.length > CALL_SIGNAL_BUFFER_MAX_ICE_PER_USER) list.shift();
  }
}

/**
 * Replay any buffered offer + ICE candidates for a target user (called when they
 * subscribe / accept / signal ready). Delivers the offer FIRST, then the ICE
 * candidates in arrival order, via the supplied deliver() callback. Consumed
 * entries are removed so a later replay doesn't double-deliver.
 */
function replayCallSignals(
  callId: number,
  targetUserId: number,
  deliver: (fromUserId: number, signal: any) => void,
): void {
  const buf = _callSignalBuffers.get(callId);
  if (!buf) return;
  const offer = buf.offerByUser.get(targetUserId);
  if (offer) {
    deliver(offer.fromUserId, offer.signal);
    buf.offerByUser.delete(targetUserId);
  }
  const ice = buf.iceByUser.get(targetUserId);
  if (ice && ice.length) {
    for (const c of ice) deliver(c.fromUserId, c.signal);
    buf.iceByUser.delete(targetUserId);
  }
}

/** Clear the entire signal buffer for a call (terminal transition). */
function clearCallBuffer(callId: number): void {
  if (!callId) return;
  _callSignalBuffers.delete(callId);
}

// ── Per-meeting WebRTC MESH signal buffer (group-call reliable delivery) ──
// The 1:1 buffer above fixed the "answered but never connects" class of bugs
// for two-party calls. The N-party mesh (`meeting_signal`) was still a pure
// fire-and-forget relay: an offer/ICE destined for a peer who is mid-join,
// cold-starting, or briefly reconnecting (within MEETING_DISCONNECT_GRACE_MS)
// is silently dropped, so that one pair never connects while the rest of the
// mesh does (the "one tile stuck on Connecting…" group-call bug). We buffer
// the LATEST offer + ordered ICE candidates destined for an offline target,
// keyed by meeting → target → sender, and replay them the instant the target
// (re)joins, subscribes, or signals ready. Mirrors the proven 1:1 design.
interface BufferedMeetingPeerSignals {
  // Latest offer from `fromUserId` to the target (a newer offer — ICE-restart
  // or relay rebuild — supersedes the previous one).
  offer?: any;
  // Ordered ICE candidates from `fromUserId`, awaiting the target's remote
  // description / subscription.
  ice: Array<any>;
}
interface BufferedMeetingSignals {
  // targetUserId → (fromUserId → buffered signals from that sender)
  byTarget: Map<number, Map<number, BufferedMeetingPeerSignals>>;
  expiresAt: number;
}

const MEETING_SIGNAL_BUFFER_TTL_MS = 60_000;
const MEETING_SIGNAL_BUFFER_MAX_MEETINGS = 2000;
const MEETING_SIGNAL_BUFFER_MAX_ICE_PER_PEER = 80;
const _meetingSignalBuffers = new Map<number, BufferedMeetingSignals>();

function _pruneMeetingSignalBuffers(now: number): void {
  for (const [meetingId, buf] of _meetingSignalBuffers) {
    if (buf.expiresAt <= now) _meetingSignalBuffers.delete(meetingId);
  }
  if (_meetingSignalBuffers.size > MEETING_SIGNAL_BUFFER_MAX_MEETINGS) {
    const oldest = _meetingSignalBuffers.keys().next().value;
    if (oldest !== undefined) _meetingSignalBuffers.delete(oldest);
  }
}

function _getOrCreateMeetingBuffer(meetingId: number): BufferedMeetingSignals {
  const now = Date.now();
  let buf = _meetingSignalBuffers.get(meetingId);
  if (!buf || buf.expiresAt <= now) {
    buf = {
      byTarget: new Map(),
      expiresAt: now + MEETING_SIGNAL_BUFFER_TTL_MS,
    };
    _meetingSignalBuffers.set(meetingId, buf);
    _pruneMeetingSignalBuffers(now);
  } else {
    buf.expiresAt = now + MEETING_SIGNAL_BUFFER_TTL_MS;
  }
  return buf;
}

/**
 * Buffer a mesh offer/candidate destined for a target peer with no live socket.
 * Mesh signal types are "offer" | "answer" | "candidate". We only buffer the
 * negotiation-critical "offer" and "candidate": an "answer" is a response to an
 * offer, and if the offerer was offline when it arrived they re-offer on
 * reconnect (via `meeting_peer_ready`), so buffering answers would only risk
 * replaying a stale SDP against a fresh transport.
 */
function bufferMeetingSignal(
  meetingId: number,
  fromUserId: number,
  targetUserId: number,
  signal: any,
): void {
  if (!meetingId || !fromUserId || !targetUserId || !signal) return;
  if (signal.type !== "offer" && signal.type !== "candidate") return;
  const buf = _getOrCreateMeetingBuffer(meetingId);
  let perTarget = buf.byTarget.get(targetUserId);
  if (!perTarget) {
    perTarget = new Map();
    buf.byTarget.set(targetUserId, perTarget);
  }
  let entry = perTarget.get(fromUserId);
  if (!entry) {
    entry = { ice: [] };
    perTarget.set(fromUserId, entry);
  }
  if (signal.type === "offer") {
    // Keep only the LATEST offer from this sender; a new offer obsoletes the
    // ICE buffered against the previous one (different transport).
    entry.offer = signal;
    entry.ice = [];
  } else {
    entry.ice.push(signal);
    if (entry.ice.length > MEETING_SIGNAL_BUFFER_MAX_ICE_PER_PEER)
      entry.ice.shift();
  }
}

/**
 * Replay every buffered offer + ICE candidate destined for `targetUserId` in a
 * meeting (called when they join / subscribe / signal ready). For each sender we
 * deliver the offer FIRST, then that sender's ICE in arrival order. Consumed
 * entries are removed so a later replay can't double-deliver.
 */
function replayMeetingSignals(
  meetingId: number,
  targetUserId: number,
  deliver: (fromUserId: number, signal: any) => void,
): void {
  const buf = _meetingSignalBuffers.get(meetingId);
  if (!buf) return;
  const perTarget = buf.byTarget.get(targetUserId);
  if (!perTarget) return;
  for (const [fromUserId, entry] of perTarget) {
    if (entry.offer) deliver(fromUserId, entry.offer);
    for (const c of entry.ice) deliver(fromUserId, c);
  }
  buf.byTarget.delete(targetUserId);
}

/** Drop all buffered signals (both directions) involving a user in a meeting. */
function clearMeetingUserBuffer(meetingId: number, userId: number): void {
  if (!meetingId || !userId) return;
  const buf = _meetingSignalBuffers.get(meetingId);
  if (!buf) return;
  buf.byTarget.delete(userId);
  for (const perTarget of buf.byTarget.values()) perTarget.delete(userId);
}

/** Clear the entire mesh signal buffer for a meeting (terminal transition). */
function clearMeetingBuffer(meetingId: number): void {
  if (!meetingId) return;
  _meetingSignalBuffers.delete(meetingId);
}

/**
 * Insert a Signal-style call-event row into the conversation so 1:1 call HISTORY
 * appears INLINE in the chat thread ("Missed voice call", "Outgoing video call",
 * etc.) and is delivered live to every participant. The mobile/web clients render
 * the `metadata.type === "call"` system message into a centred call row. The
 * `callerId` is stored as the message sender so each client can infer
 * incoming-vs-outgoing direction relative to the viewer. Best-effort: any failure
 * here is logged and swallowed so it can never break the call teardown.
 */
async function emitCallHistoryMessage(
  db: DbLike,
  tenantId: number | null | undefined,
  conversationId: number,
  callerId: number,
  callType: string,
  status: "ended" | "missed" | "declined",
  duration: number | null,
): Promise<void> {
  try {
    const kind = callType === "video" ? "video" : "voice";
    const metadata = {
      type: "call",
      callType: kind,
      status,
      duration: duration ?? null,
      callerId,
    };
    // Neutral, human-readable summary used as the conversation-list preview
    // (the chat THREAD renders a richer, direction-aware row from metadata).
    const preview =
      status === "missed"
        ? `Missed ${kind} call`
        : status === "declined"
          ? `${kind === "video" ? "Video" : "Voice"} call declined`
          : `${kind === "video" ? "Video" : "Voice"} call`;
    const row = (
      await db.query(
        `INSERT INTO messages (conversation_id, sender_id, content, format_type, metadata)
             VALUES ($1, $2, $3, 'system', $4) RETURNING id, created_at`,
        [conversationId, callerId, preview, JSON.stringify(metadata)],
      )
    ).rows[0];
    if (!row) return;
    const participants = (
      await db.query(
        "SELECT user_id FROM conversation_participants WHERE conversation_id = $1",
        [conversationId],
      )
    ).rows;
    for (const p of participants) {
      sendToUser(tenantId, p.user_id, "chat_message", {
        id: row.id,
        conversationId,
        senderId: callerId,
        content: preview,
        formatType: "system",
        metadata,
        createdAt: row.created_at,
      });
    }
  } catch (err: any) {
    logger.warn(
      { err: err?.message, conversationId, callerId, status },
      "emitCallHistoryMessage failed",
    );
  }
}

/** True if the user has at least one OPEN (readyState===1) local socket. */
function hasOpenSocket(
  tenantId: number | null | undefined,
  userId: number,
): boolean {
  const set = clients.get(clientKey(tenantId, userId));
  if (!set) return false;
  for (const ws of set) {
    if (ws.readyState === 1) return true;
  }
  return false;
}

function setupWebSocket(server: HTTPServer): any {
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: 64 * 1024,
    verifyClient: (
      { req }: { req: IncomingMessage },
      done: (ok: boolean, code?: number, message?: string) => void,
    ) => {
      // Prevent Cross-Site WebSocket Hijacking (CSWSH)
      const origin = req.headers.origin;
      if (!origin) return done(true); // non-browser clients (Electron, curl) have no Origin

      const host = req.headers.host;
      if (host && (origin === `https://${host}` || origin === `http://${host}`))
        return done(true);

      if (origin.startsWith("workpulse://")) return done(true);

      if (process.env.CORS_ORIGIN) {
        const allowed = process.env.CORS_ORIGIN.split(",").map((s) => s.trim());
        if (allowed.includes(origin)) return done(true);
      }

      if (process.env.NODE_ENV !== "production") {
        const devOrigins = [
          "http://localhost:3000",
          "http://localhost:3001",
          "http://localhost:5173",
          "http://localhost:5000",
        ];
        if (devOrigins.includes(origin)) return done(true);
      }

      logger.warn({ origin }, "WebSocket connection rejected: invalid origin");
      done(false, 403, "Origin not allowed");
    },
  });

  // ── Redis Pub/Sub: subscribe to user message channels ──
  const sub = redis.getSubscriber();
  if (sub) {
    sub.subscribe("ws:broadcast", (err: any) => {
      if (err)
        logger.warn(
          { err: err.message },
          "Redis subscribe failed for ws:broadcast",
        );
    });
    sub.on("message", (channel: string, raw: string) => {
      try {
        const envelope = JSON.parse(raw);
        if (envelope._from === INSTANCE_ID) return; // ignore own publishes
        if (channel === "ws:broadcast") {
          deliverLocal(
            envelope.tenantId,
            envelope.userId,
            envelope.type,
            envelope.data,
          );
        }
      } catch {
        /* ignore */
      }
    });
  }

  wss.on("connection", async (ws: ExtWS, req: IncomingMessage) => {
    // Authenticate via cookie (web/desktop) or, for native mobile clients
    // that can't send cookies on the WS handshake, via a `token` query
    // param or the `Sec-WebSocket-Protocol` header. Cookie takes precedence.
    const cookies = cookie.parse(req.headers.cookie || "");
    let token: string | undefined = cookies.token;
    if (!token) {
      try {
        const url = new URL(req.url || "", "http://localhost");
        token = url.searchParams.get("token") || undefined;
      } catch {
        /* malformed url — ignore */
      }
    }
    if (!token) {
      const proto = req.headers["sec-websocket-protocol"];
      if (typeof proto === "string" && proto.length > 0) {
        token = proto.split(",")[0].trim();
      }
    }
    if (!token) {
      ws.close(4001, "Unauthorized");
      return;
    }

    let payload: any;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      ws.close(4001, "Unauthorized");
      return;
    }

    // Verify token_version hasn't been revoked (password change/reset)
    const userId: number = payload.id;
    const tenantId: number | null = payload.tenant_id;

    // Resolve tenant DB
    let db: DbLike;
    if (tenantId) {
      try {
        const tenant = await getTenantById(tenantId);
        if (!tenant || tenant.status !== "active") {
          ws.close(4003, "Tenant unavailable");
          return;
        }
        const poolEntry = await getTenantPool(tenant.db_name, tenant.db_host);
        db = { query: poolEntry.query, transaction: poolEntry.transaction };
      } catch (e: any) {
        logger.warn({ err: e.message, tenantId }, "WS tenant pool failed");
        ws.close(4003, "Tenant unavailable");
        return;
      }
    } else {
      db = { query: masterQuery };
    }
    ws.db = db;
    ws.tenantId = tenantId || null;

    try {
      const tokenVersion = payload.tv ?? 0;
      let dbTokenVersion = await redis.getTokenVersion(tenantId, userId);
      if (dbTokenVersion === null) {
        const userRow = (
          await db.query("SELECT token_version FROM users WHERE id = $1", [
            userId,
          ])
        ).rows[0];
        if (!userRow) {
          ws.close(4001, "Token revoked");
          return;
        }
        dbTokenVersion = userRow.token_version || 0;
        await redis.setTokenVersion(tenantId, userId, dbTokenVersion);
      }
      if (tokenVersion !== dbTokenVersion) {
        ws.close(4001, "Token revoked");
        return;
      }
      // Stash the token version + JWT expiry so the message handler can
      // periodically re-validate. Without this, a socket opened before a
      // logout / forced-revoke / password change stays fully functional
      // forever because the token version is otherwise only checked once.
      ws._tokenVersion = tokenVersion;
      ws._tokenExpMs = payload.exp ? payload.exp * 1000 : null;
      ws._lastAuthCheckAt = Date.now();
    } catch {
      ws.close(4001, "Auth check failed");
      return;
    }

    // Register client (enforce per-user connection limit)
    const ck = clientKey(tenantId, userId);
    const wasOffline = !clients.has(ck) || clients.get(ck)!.size === 0;
    if (!clients.has(ck)) clients.set(ck, new Set<ExtWS>());
    const userConns = clients.get(ck)!;
    if (userConns.size >= MAX_CONNECTIONS_PER_USER) {
      ws.close(4029, "Too many connections");
      return;
    }
    userConns.add(ws);

    // Status service v2: register this connection as its own session so
    // per-device activity (in_call / in_meeting) and "Appear Offline" can
    // be tracked correctly. The session_key is a UUID generated per WS
    // connection and stashed on `ws` so the disconnect handler can close
    // exactly this row (instead of guessing which one to kill).
    ws._statusSessionKey = randomUUID();
    const deviceLabel = req.headers["user-agent"]
      ? String(req.headers["user-agent"]).slice(0, 80)
      : null;
    // openSession also re-resolves effective state, writes an audit row,
    // updates the cache, and broadcasts the unified `user_status` event.
    statusService
      .openSession(
        { db, tenantId },
        { userId, sessionKey: ws._statusSessionKey, deviceLabel },
      )
      .catch((err: any) => {
        logger.warn(
          { err: err.message, userId },
          "statusService.openSession failed",
        );
      });

    logger.debug(
      { userId, tenantId, sessionKey: ws._statusSessionKey },
      "WS client connected",
    );

    // Bump users.last_seen_at on first WS connect so legacy chat /
    // presence callers ('/api/chat/presence') still see the user as
    // online. The status service writes its own per-session
    // last_seen_at — this is only for the legacy chat-presence read.
    if (wasOffline) {
      redis.setPresence(tenantId, userId, redis.TTL.PRESENCE);
      db.query("UPDATE users SET last_seen_at = NOW() WHERE id = $1", [
        userId,
      ]).catch((err: any) =>
        logger.warn({ err: err.message, userId }, "last_seen_at bump failed"),
      );
    }

    ws.on("message", (raw: any) => {
      // Per-connection rate limiting: max 60 messages per second
      // (WebRTC ICE candidate trickling can burst during call setup)
      const now = Date.now();

      // Re-validate the session periodically (and on JWT expiry) so a
      // socket opened before a logout / forced-revoke / password change
      // is torn down instead of remaining fully functional. The check is
      // throttled and runs asynchronously so it never blocks message
      // dispatch; it fails open on transient Redis/DB errors.
      if (ws._tokenExpMs && now > ws._tokenExpMs) {
        ws.close(4001, "Token expired");
        return;
      }
      if (
        !ws._authCheckInFlight &&
        now - (ws._lastAuthCheckAt || 0) > WS_AUTH_RECHECK_MS
      ) {
        ws._lastAuthCheckAt = now;
        ws._authCheckInFlight = true;
        Promise.resolve()
          .then(async () => {
            let dbTv = await redis.getTokenVersion(tenantId, userId);
            if (dbTv === null) {
              const row = (
                await db.query(
                  "SELECT token_version FROM users WHERE id = $1",
                  [userId],
                )
              ).rows[0];
              if (!row) {
                ws.close(4001, "Token revoked");
                return;
              }
              dbTv = row.token_version || 0;
              await redis.setTokenVersion(tenantId, userId, dbTv);
            }
            if ((ws._tokenVersion ?? 0) !== dbTv) {
              logger.debug(
                { userId, tenantId },
                "WS session revoked — closing socket",
              );
              ws.close(4001, "Session revoked");
            }
          })
          .catch(() => {
            /* fail open on transient error */
          })
          .finally(() => {
            ws._authCheckInFlight = false;
          });
      }

      if (!ws._rlWindow || now - ws._rlWindow > 1000) {
        ws._rlWindow = now;
        ws._rlCount = 0;
      }
      if (++ws._rlCount > 60) {
        logger.warn(
          { userId, tenantId, count: ws._rlCount },
          "WS rate limit exceeded, dropping message",
        );
        return;
      }

      try {
        const msg = JSON.parse(raw);
        // Application-level heartbeat: the client (web + desktop) sends
        // `{ type: 'ping' }` on a timer and arms a watchdog that closes
        // the socket if no frame comes back. Reply immediately with a
        // `pong` so a healthy-but-quiet connection isn't torn down.
        // Handled here (before the metrics-wrapped dispatch) so it stays
        // cheap and doesn't pollute the per-handler stats. We also treat
        // it as proof of life for the server-side pong heartbeat.
        if (msg && msg.type === "ping") {
          ws.isAlive = true;
          ws._missedPongs = 0;
          try {
            ws.send(JSON.stringify({ type: "pong" }));
          } catch {
            /* ignore */
          }
          return;
        }
        // Phase 6 — wrap every dispatch with the metrics collector so
        // /api/internal/ws-stats can show p50/p95 latency, count,
        // errors, and timeouts per message type. Timeout defaults to
        // 5s so a runaway DB query surfaces as a timeout error in
        // metrics instead of piling up open WS frames.
        wsMetrics
          .recordHandler(
            msg?.type || "unknown",
            WS_HANDLER_DEFAULT_TIMEOUT_MS,
            () => handleChatMessage(db, userId, tenantId, msg, ws),
          )
          .catch((err: any) => {
            logger.error(
              {
                err: err?.message,
                stack: err?.stack,
                userId,
                tenantId,
                type: msg?.type,
              },
              "WS message handler error",
            );
          });
      } catch {
        /* ignore non-JSON */
      }
    });

    ws.on("close", () => {
      const set = clients.get(ck);
      if (set) {
        set.delete(ws);
        if (set.size === 0) {
          clients.delete(ck);
          // Drop Redis presence + bump last_seen_at for legacy
          // /api/chat/presence readers. Status service emits the
          // canonical `user_status` event from closeSession() below.
          redis.removePresence(tenantId, userId);
          db.query("UPDATE users SET last_seen_at = NOW() WHERE id = $1", [
            userId,
          ]).catch((err: any) => {
            logger.warn(
              { err: err.message, userId },
              "Failed to update last_seen_at on disconnect",
            );
          });
        }
      }

      // Status service v2: close exactly this connection's session.
      // If it was the user's last open session, the service will
      // resolve them as offline and broadcast `user_status` accordingly.
      // closeSession also clears any per-session activity (in_call /
      // in_meeting) as part of the UPDATE — see repository.closeSession.
      if (ws._statusSessionKey) {
        statusService
          .closeSession({ db, tenantId }, ws._statusSessionKey)
          .catch((err: any) =>
            logger.warn(
              { err: err.message, userId },
              "statusService.closeSession failed",
            ),
          );
        ws._statusSessionKey = null;
        ws._callActivityRefId = null;
        ws._meetingActivityRefId = null;
      }

      // Clean up meeting if user was in one and didn't explicitly leave.
      // IMPORTANT: do NOT mark them as "left" immediately — schedule a
      // grace window so the user's auto-reconnecting WebSocket can
      // re-join silently without ejecting them from the meeting and
      // tearing down the other participants' RTCPeerConnections.
      if (ws._activeMeetingId) {
        const mid = ws._activeMeetingId;
        ws._activeMeetingId = null;
        scheduleMeetingDisconnectCleanup({
          db,
          tenantId,
          userId,
          meetingId: mid,
        });
      }

      logger.debug({ userId, tenantId }, "WS client disconnected");
    });

    ws.on("error", (err: any) => {
      logger.warn({ err: err?.message, userId }, "WebSocket error");
      ws.close();
    });

    // Heartbeat: keep connection alive
    ws.isAlive = true;
    ws.userId = userId;
    ws.tenantId = tenantId || null;
    ws.on("pong", () => {
      ws.isAlive = true;
      // Refresh Redis presence TTL on every pong so users don't appear offline
      redis.setPresence(ws.tenantId, ws.userId, redis.TTL.PRESENCE);
      // Status service v2: keep this session's last_seen_at fresh so
      // the resolver doesn't classify it as stale (> SESSION_STALE_MS).
      if (ws._statusSessionKey) {
        statusService
          .touchSession({ db, tenantId: ws.tenantId }, ws._statusSessionKey)
          .catch(() => {
            /* best-effort */
          });
      }
    });
  });

  // Heartbeat interval — softer than before: a single missed pong no longer
  // terminates the socket. We only kill the connection after `MAX_MISSED_PONGS`
  // consecutive missed pings (~60s of silence), which matches videosdk-style
  // SDK behaviour and prevents brief network blips from kicking users out of
  // their meeting. Combined with `scheduleMeetingDisconnectCleanup` below,
  // a short Wi-Fi drop now causes zero user-visible disruption.
  const MAX_MISSED_PONGS = 2;
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws: ExtWS) => {
      ws._missedPongs = (ws._missedPongs || 0) + (ws.isAlive ? 0 : 1);
      if (ws._missedPongs > MAX_MISSED_PONGS) {
        logger.debug(
          { userId: ws.userId, missed: ws._missedPongs },
          "WS terminating after missed pongs",
        );
        return ws.terminate();
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    });
  }, 30000);

  wss.on("close", () => clearInterval(heartbeat));

  return wss;
}

interface MeetingCleanupArgs {
  db: DbLike;
  tenantId: number | null | undefined;
  userId: number;
  meetingId: number;
}

/**
 * Schedule a delayed "user left the meeting" cleanup after a WS close.
 *
 * Behaviour:
 *   • Wait MEETING_DISCONNECT_GRACE_MS (~15s) for the user to reconnect.
 *   • If a new `meeting_join` arrives from the same user/meeting within that
 *     window, `cancelMeetingDisconnectCleanup` will be invoked and the
 *     scheduled cleanup is skipped — other participants never see a
 *     `meeting_participant_left` event, the meeting continues unaffected,
 *     and the user's RTCPeerConnections re-negotiate via the existing
 *     ICE-restart code in useMeetingState.
 *   • If the grace window expires without a rejoin, we perform the same
 *     cleanup that used to happen synchronously on close.
 *
 * This is the equivalent of videosdk's internal "reconnecting" window —
 * brief network blips or laptop-sleep events no longer eject the user.
 */
function scheduleMeetingDisconnectCleanup({
  db,
  tenantId,
  userId,
  meetingId,
}: MeetingCleanupArgs): void {
  const key = meetingLeaveKey(tenantId, userId, meetingId);
  // If there's already a pending timer (rare — happens if the user opens
  // and closes a second WS very quickly), replace it with a fresh one.
  const existing = pendingMeetingLeaves.get(key);
  if (existing?.timer) clearTimeout(existing.timer);

  const timer = setTimeout(async () => {
    pendingMeetingLeaves.delete(key);
    try {
      // Re-check: if the user reconnected and is `joined` via another
      // session by the time we run, the upsert-on-join already cleared
      // any stale row — but if they reconnected and then left properly
      // (meeting_leave), they may already be `left`. Either way, only
      // act if they are *still* `joined`.
      const isJoined = (
        await db.query(
          `SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2 AND status = 'joined'`,
          [meetingId, userId],
        )
      ).rows[0];
      if (!isJoined) return;

      // Also: don't fire the cleanup if the user has reconnected with
      // a new WS that's now associated with this meeting (clients
      // Map will still contain at least one WS for them).
      const hasOtherSessionForMeeting = (() => {
        const set = clients.get(clientKey(tenantId, userId));
        if (!set) return false;
        for (const ws of set) {
          if (ws._activeMeetingId === meetingId) return true;
        }
        return false;
      })();
      if (hasOtherSessionForMeeting) return;

      await db.query(
        `UPDATE meeting_participants SET status = 'left', left_at = NOW() WHERE meeting_id = $1 AND user_id = $2`,
        [meetingId, userId],
      );

      // Drop any mesh signals buffered for / from this user — they are gone
      // and a future rejoin starts a fresh negotiation.
      clearMeetingUserBuffer(meetingId, userId);

      const activeParticipants = (
        await db.query(
          `SELECT user_id FROM meeting_participants WHERE meeting_id = $1 AND status = 'joined'`,
          [meetingId],
        )
      ).rows;

      for (const p of activeParticipants) {
        sendToUser(tenantId, p.user_id, "meeting_participant_left", {
          meetingId,
          userId,
        });
      }

      if (activeParticipants.length === 0) {
        // Meeting is empty — drop the whole mesh signal buffer.
        clearMeetingBuffer(meetingId);
        await db.query(
          `UPDATE meetings SET status = 'ended', ended_at = NOW() WHERE id = $1 AND status != 'ended'`,
          [meetingId],
        );
        statusService
          .clearActivityForRef({ db, tenantId }, "in_meeting", meetingId)
          .catch((err: any) =>
            logger.warn(
              { err: err.message, meetingId },
              "clearActivityForRef(in_meeting) on grace expiry failed",
            ),
          );
      }
    } catch (err: any) {
      logger.warn(
        { err: err.message, userId, meetingId },
        "Delayed meeting cleanup failed",
      );
    }
  }, MEETING_DISCONNECT_GRACE_MS);

  pendingMeetingLeaves.set(key, { timer, db });
}

/** Cancel a pending disconnect-cleanup timer (called when the user rejoins). */
function cancelMeetingDisconnectCleanup({
  tenantId,
  userId,
  meetingId,
}: {
  tenantId: number | null | undefined;
  userId: number;
  meetingId: number;
}): boolean {
  const key = meetingLeaveKey(tenantId, userId, meetingId);
  const existing = pendingMeetingLeaves.get(key);
  if (existing?.timer) {
    clearTimeout(existing.timer);
    pendingMeetingLeaves.delete(key);
    return true;
  }
  return false;
}

/** Handle incoming WS messages for chat */
async function handleChatMessage(
  db: DbLike,
  senderId: number,
  tenantId: number | null,
  msg: any,
  ws: ExtWS,
): Promise<void> {
  if (msg.type === "chat_message") {
    // Phase 6 part 2 (ADR-009): delegated to the extracted handler.
    // `sendToUser` is injected so the handler module doesn't pull this
    // file in via require (circular). Behaviour is preserved exactly,
    // PLUS the handler now sends a typed `chat_message_error` ack on
    // validation failure instead of silently dropping.
    await chatMessage({
      db,
      senderId,
      tenantId,
      data: msg.data || {},
      ws,
      sendToUser,
    });
    return;
  } else if (msg.type === "chat_typing") {
    // wsValidate: constitution Principle III — typed schema check replaces the
    // former bare `if (!conversationId) return;` silent-drop. Validation
    // failures are logged (not silently swallowed) but produce no reply frame
    // (typing indicators are fire-and-forget; a typed error ack adds no value).
    const parsed = validate({ conversationId: schema.posInt() }, msg.data);
    if (!parsed.ok) {
      logger.warn(
        { senderId, tenantId, errors: parsed.errors },
        "chat_typing: schema validation failed",
      );
      return;
    }
    const { conversationId } = parsed.value as { conversationId: number };

    // Verify sender is a participant
    const participant = (
      await db.query(
        "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
        [conversationId, senderId],
      )
    ).rows[0];
    if (!participant) return;

    // Notify other participants
    const participants = (
      await db.query(
        "SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2",
        [conversationId, senderId],
      )
    ).rows;

    for (const p of participants) {
      sendToUser(tenantId, p.user_id, "chat_typing", {
        conversationId,
        userId: senderId,
      });
    }
  } else if (msg.type === "chat_read") {
    // wsValidate: same pattern as chat_typing — silent-drop replaced with a
    // logged validation failure so bad frames surface in wsMetrics.
    const parsedRead = validate({ conversationId: schema.posInt() }, msg.data);
    if (!parsedRead.ok) {
      logger.warn(
        { senderId, tenantId, errors: parsedRead.errors },
        "chat_read: schema validation failed",
      );
      return;
    }
    const { conversationId: readConvId } = parsedRead.value as { conversationId: number };

    const participant = (
      await db.query(
        "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
        [readConvId, senderId],
      )
    ).rows[0];
    if (!participant) return;

    await db.query(
      `INSERT INTO message_reads (conversation_id, user_id, last_read_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = NOW()`,
      [readConvId, senderId],
    );
    redis.resetUnread(tenantId, senderId, readConvId);
  } else if (msg.type === "call_initiate") {
    // Caller initiates a call → create call_log, notify participants.
    // T038: gate this with idempotency so reconnect replays don't create
    // duplicate ringing rows/invites.
    const {
      conversationId,
      callType,
      clientMsgId: rawCallInitiateId,
    } = msg.data || {};
    if (!conversationId || !["voice", "video"].includes(callType)) return;

    await withIdempotency(
      {
        tenantId,
        senderId,
        type: "call_initiate",
        clientMsgId: rawCallInitiateId,
      },
      async () => {
        const participant = (
          await db.query(
            "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
            [conversationId, senderId],
          )
        ).rows[0];
        if (!participant) {
          logger.warn(
            { senderId, conversationId },
            "call_initiate: sender not a participant",
          );
          recordCallTransitionFailure({
            event: "call_transition_failed",
            action: "initiate",
            tenantId,
            senderId,
            conversationId,
            reason: "sender_not_participant",
          });
          return;
        }

        // Group conversations use the meeting mesh flow for n-way reliability.
        // Direct call_initiate is p2p and cannot connect all participants.
        const isGroupConv = (
          await db.query("SELECT is_group FROM conversations WHERE id = $1", [
            conversationId,
          ])
        ).rows[0]?.is_group;
        if (isGroupConv) {
          logger.info(
            { senderId, conversationId, tenantId },
            "call_initiate: group conversation blocked; use meeting flow",
          );
          sendToUser(tenantId, senderId, "call_ended", {
            conversationId,
            reason: "group_unsupported",
          });
          recordCallTransitionFailure({
            event: "call_transition_failed",
            action: "initiate",
            tenantId,
            senderId,
            conversationId,
            reason: "group_unsupported",
          });
          return;
        }

        // P0.3 — call_busy on 1:1 collision. For NON-group conversations we
        // ring at most one callee; if that callee already has an active
        // (ringing/answered) call we must NOT create another ringing row.
        // Instead tell the caller the callee is busy and bail out.
        {
          const targetRow = (
            await db.query(
              `SELECT user_id FROM conversation_participants
                         WHERE conversation_id = $1 AND user_id != $2
                         ORDER BY user_id ASC
                         LIMIT 1`,
              [conversationId, senderId],
            )
          ).rows[0];
          if (targetRow) {
            const targetUserId = targetRow.user_id;
            // Only treat the callee as busy for a GENUINELY active call.
            // Critical guards (a too-broad check here silently blocks all
            // future calls + push notifications to that user):
            //   • Exclude THIS conversation — in a 1:1 chat both users are
            //     participants of it, so a leftover row in the same convo
            //     would make the callee look "busy" to their own caller.
            //   • Freshness window — a crashed/killed client can leave a
            //     row stuck in 'ringing'/'answered' forever (the stale-call
            //     sweep is the authoritative cleanup, but we must also not
            //     trust rows older than the TTL here, or a user gets pinned
            //     "busy" until the next sweep / indefinitely for 'answered').
            //   • 'ringing' counts only within the ring TTL (~45s).
            //   • 'answered' counts only within a max PLAUSIBLE live-call
            //     window. This used to be 12h from created_at, which meant a
            //     single abandoned 'answered' row (client crashed / app killed
            //     mid-call so call_end never arrived) pinned the callee as
            //     "busy" for up to 12 HOURS — every caller got call_busy and
            //     the callee's phone NEVER RANG (a primary "receiver never
            //     rings" cause when the stale-call sweep isn't running, e.g.
            //     no Redis/BullMQ). 1:1 calls realistically don't exceed a
            //     couple of hours (group calls use the meeting mesh), so we
            //     tighten the window to 2h and anchor it on started_at (the
            //     moment the call actually connected) falling back to
            //     created_at. The 20s stale-call sweep remains the
            //     authoritative cleanup; this is the defensive bound.
            const busy = (
              await db.query(
                `SELECT 1 FROM call_logs cl
                             JOIN conversation_participants cp ON cp.conversation_id = cl.conversation_id
                             WHERE cp.user_id = $1
                               AND cl.conversation_id != $2
                               AND (
                                     (cl.status = 'ringing'
                                       AND cl.created_at > NOW() - INTERVAL '45 seconds')
                                  OR (cl.status = 'answered'
                                       AND COALESCE(cl.started_at, cl.created_at) > NOW() - INTERVAL '2 hours')
                                   )
                             LIMIT 1`,
                [targetUserId, conversationId],
              )
            ).rows[0];
            if (busy) {
              logger.info(
                { senderId, conversationId, targetUserId, tenantId },
                "call_initiate: callee busy, sending call_busy",
              );
              // Optionally record a missed-call row for history.
              try {
                await db.query(
                  `INSERT INTO call_logs (conversation_id, caller_id, call_type, status, ended_at)
                                     VALUES ($1, $2, $3, 'missed', NOW())`,
                  [conversationId, senderId, callType],
                );
              } catch (err: any) {
                logger.warn(
                  { err: err?.message, conversationId, senderId },
                  "call_initiate: failed to record missed busy call log",
                );
              }
              sendToUser(tenantId, senderId, "call_busy", {
                conversationId,
                targetUserId,
                reason: "busy",
              });
              recordCallTransitionFailure({
                event: "call_transition_failed",
                action: "initiate",
                tenantId,
                senderId,
                conversationId,
                reason: "callee_busy",
              });
              return;
            }
          }
        }

        const [callLogResult, callerResult, convResult] = await Promise.all([
          db.query(
            `INSERT INTO call_logs (conversation_id, caller_id, call_type, status)
                         VALUES ($1, $2, $3, 'ringing') RETURNING id, created_at`,
            [conversationId, senderId, callType],
          ),
          db.query("SELECT full_name, avatar FROM users WHERE id = $1", [
            senderId,
          ]),
          db.query("SELECT name, is_group FROM conversations WHERE id = $1", [
            conversationId,
          ]),
        ]);

        const callLog = callLogResult.rows[0];
        const caller = callerResult.rows[0];
        const conv = convResult.rows[0];

        // For NON-group (1:1) conversations we ring at most ONE other user.
        const participantsQuery = conv?.is_group
          ? `SELECT user_id FROM conversation_participants
                       WHERE conversation_id = $1 AND user_id != $2`
          : `SELECT user_id FROM conversation_participants
                       WHERE conversation_id = $1 AND user_id != $2
                       ORDER BY user_id ASC
                       LIMIT 1`;
        const participants = (
          await db.query(participantsQuery, [conversationId, senderId])
        ).rows;

        logger.info(
          {
            senderId,
            callId: callLog.id,
            conversationId,
            callType,
            participantCount: participants.length,
            tenantId,
          },
          "call_initiate: notifying participants",
        );

        for (const p of participants) {
          sendToUser(tenantId, p.user_id, "call_incoming", {
            callId: callLog.id,
            conversationId,
            callerId: senderId,
            callerName: caller?.full_name,
            callerAvatar: caller?.avatar,
            callType,
            isGroup: conv?.is_group || false,
            groupName: conv?.name,
          });

          // Send push notification to recipient if they have registered devices
          pushNotifications
            .sendCallNotification(db.query as any, p.user_id, tenantId, {
              callId: callLog.id,
              conversationId,
              callerId: senderId,
              callerName: caller?.full_name || "Unknown",
              callerAvatar: caller?.avatar,
              callType: callType as "voice" | "video",
              isGroup: conv?.is_group || false,
              groupName: conv?.name,
            })
            .then(() => {
              logPushCallLifecycle(
                {
                  event: "push_send_result",
                  tenantId,
                  userId: p.user_id,
                  callId: callLog.id,
                  conversationId,
                  status: "success",
                },
                "debug",
              );
            })
            .catch((err: any) => {
              logger.warn(
                { err: err.message, userId: p.user_id, callId: callLog.id },
                "Failed to send call push notification",
              );
              logPushCallLifecycle(
                {
                  event: "push_send_result",
                  tenantId,
                  userId: p.user_id,
                  callId: callLog.id,
                  conversationId,
                  status: "failed",
                  failureReason: err.message || "unknown",
                },
                "warn",
              );
            });
        }

        // Confirm call started to caller
        sendToUser(tenantId, senderId, "call_started", {
          callId: callLog.id,
          conversationId,
          callType,
        });

        // Status service v2: mark THIS device of the caller as in_call.
        if (ws._statusSessionKey) {
          statusService
            .setSessionActivity(
              { db, tenantId },
              ws._statusSessionKey,
              "in_call",
              callLog.id,
            )
            .catch((err: any) =>
              logger.warn(
                { err: err.message, callId: callLog.id },
                "setSessionActivity(in_call) failed",
              ),
            );
          ws._callActivityRefId = callLog.id;
        }
      },
    );
  } else if (msg.type === "call_accept") {
    // Callee accepts → update call log, notify caller with acceptance
    const { callId, conversationId, clientMsgId: rawIdAccept } = msg.data || {};
    if (!callId || !conversationId) return;

    await withIdempotentCallAction(
      {
        tenantId,
        senderId,
        callId,
        action: "answer",
        clientMsgId: rawIdAccept,
      },
      async () => {
        const [callLogResult, participantResult] = await Promise.all([
          db.query(
            `SELECT * FROM call_logs WHERE id = $1 AND conversation_id = $2`,
            [callId, conversationId],
          ),
          db.query(
            "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
            [conversationId, senderId],
          ),
        ]);

        const callLog = callLogResult.rows[0];
        if (!callLog) {
          logger.warn(
            { senderId, callId, conversationId },
            "call_accept: call log not found",
          );
          recordCallTransitionFailure({
            event: "call_transition_failed",
            action: "answer",
            tenantId,
            senderId,
            callId,
            conversationId,
            reason: "call_not_found",
          });
          return;
        }
        if (callLog.status !== "ringing") {
          logger.info(
            { senderId, callId, conversationId, status: callLog.status },
            "call_accept: terminal/invalid state; ignoring",
          );
          recordCallTransitionFailure({
            event: "call_transition_failed",
            action: "answer",
            tenantId,
            senderId,
            callId,
            conversationId,
            fromStatus: callLog.status,
            reason: "invalid_transition",
          });
          return;
        }
        if (!participantResult.rows[0]) {
          logger.warn(
            { senderId, callId, conversationId },
            "call_accept: sender not a participant",
          );
          recordCallTransitionFailure({
            event: "call_transition_failed",
            action: "answer",
            tenantId,
            senderId,
            callId,
            conversationId,
            reason: "sender_not_participant",
          });
          return;
        }

        const [updatedCall, accepterResult] = await Promise.all([
          db.query(
            `UPDATE call_logs
                         SET status = 'answered', started_at = NOW()
                         WHERE id = $1 AND status = 'ringing'
                         RETURNING id`,
            [callId],
          ),
          db.query("SELECT full_name, avatar FROM users WHERE id = $1", [
            senderId,
          ]),
        ]);

        if (!updatedCall.rows[0]) {
          logger.info(
            { senderId, callId, conversationId },
            "call_accept: transition already applied by another action",
          );
          recordCallTransitionFailure({
            event: "call_transition_failed",
            action: "answer",
            tenantId,
            senderId,
            callId,
            conversationId,
            reason: "transition_race",
          });
          return;
        }

        const accepter = accepterResult.rows[0];

        logPushCallLifecycle(
          {
            event: "native_call_action_applied",
            tenantId,
            userId: senderId,
            callId,
            conversationId,
            action: "answer",
            status: "success",
          },
          "info",
        );

        logger.info(
          {
            senderId,
            callerId: callLog.caller_id,
            callId,
            conversationId,
            tenantId,
          },
          "call_accept: notifying caller",
        );

        // Notify the caller that call was accepted
        sendToUser(tenantId, callLog.caller_id, "call_accepted", {
          callId,
          conversationId,
          userId: senderId,
          userName: accepter?.full_name,
          userAvatar: accepter?.avatar,
        });

        // Multi-session support: the accepter may have other active sessions
        // (e.g. desktop + browser) where the incoming-call PiP is still
        // ringing. Tell every one of the accepter's sessions that the call
        // has been handled so non-accepting devices dismiss their PiP.
        // The accepting session itself has already cleared its PiP locally
        // and ignores this event (see CallContext handler).
        sendToUser(tenantId, senderId, "call_handled_elsewhere", {
          callId,
          conversationId,
          action: "accepted",
        });

        // Push-cancel the accepter's OTHER devices (e.g. a locked /
        // backgrounded twin phone) so the native incoming-call ring is
        // dismissed there. The WS dismiss above only reaches sessions
        // with a live socket; a killed/locked device relies on this
        // data-only "call handled elsewhere" push.
        pushNotifications
          .sendCallCancellation(db.query as any, senderId, tenantId, {
            callId,
            conversationId,
            reason: "accepted",
          })
          .catch((err: any) =>
            logger.warn(
              { err: err.message, callId, userId: senderId },
              "Failed to push-cancel accepter devices on accept",
            ),
          );

        // Status service v2: mark the accepting device (only) as in_call.
        if (ws._statusSessionKey) {
          statusService
            .setSessionActivity(
              { db, tenantId },
              ws._statusSessionKey,
              "in_call",
              callId,
            )
            .catch((err: any) =>
              logger.warn(
                { err: err.message, callId },
                "setSessionActivity(in_call) failed",
              ),
            );
          ws._callActivityRefId = callId;
        }

        // P0 — Reliable delivery: replay any OFFER/ICE the caller sent
        // BEFORE this callee's socket/screen was ready (buffered in
        // call_signal). This is the key fix for "answered from push but
        // never connects": the caller fired its offer the instant it saw
        // call_accepted, but the callee was still mounting; the buffered
        // offer is now delivered so negotiation actually starts.
        replayCallSignals(Number(callId), senderId, (fromUserId, signal) => {
          sendToUser(tenantId, senderId, "call_signal", {
            conversationId,
            fromUserId,
            signal,
          });
        });
      },
    );
  } else if (msg.type === "call_cancel") {
    // Caller cancels — either media acquisition failed after call_initiate
    // was sent, OR the caller backed out / the outgoing ring timed out
    // before the callee answered (mobile sends this when it has no callId
    // yet). Idempotent via the optional clientMsgId so a retried frame on a
    // flaky link doesn't double-cancel.
    const { conversationId, clientMsgId: rawCallCancelId } = msg.data || {};
    if (!conversationId) return;

    await withIdempotency(
      {
        tenantId,
        senderId,
        type: "call_cancel",
        clientMsgId: rawCallCancelId,
      },
      async () => {
        const callLog = (
          await db.query(
            `SELECT id, call_type FROM call_logs WHERE conversation_id = $1 AND caller_id = $2 AND status = 'ringing' ORDER BY created_at DESC LIMIT 1`,
            [conversationId, senderId],
          )
        ).rows[0];
        if (!callLog) return;

        const updated = await db.query(
          `UPDATE call_logs SET status = 'missed', ended_at = NOW() WHERE id = $1 AND status = 'ringing' RETURNING id`,
          [callLog.id],
        );
        if (!updated.rows[0]) return;

        const participants = (
          await db.query(
            "SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2",
            [conversationId, senderId],
          )
        ).rows;

        for (const p of participants) {
          sendToUser(tenantId, p.user_id, "call_ended", {
            callId: callLog.id,
            conversationId,
          });

          // Push-cancel the callee's devices (locked/backgrounded twin)
          // so a native incoming-call ring is dismissed when the caller
          // cancels.
          pushNotifications
            .sendCallCancellation(db.query as any, p.user_id, tenantId, {
              callId: callLog.id,
              conversationId,
              reason: "cancelled",
            })
            .catch((err: any) =>
              logger.warn(
                { err: err.message, callId: callLog.id, userId: p.user_id },
                "Failed to push-cancel callee devices on cancel",
              ),
            );
        }

        // Echo to the caller's OTHER devices so their outgoing-ring UI is
        // dismissed too (e.g. desktop + mobile both showing the call).
        sendToUser(tenantId, senderId, "call_ended", {
          callId: callLog.id,
          conversationId,
        });

        // Status service v2: caller cancelled; their device was briefly
        // marked in_call by call_initiate. Sweep every session
        // referencing this call.
        statusService
          .clearActivityForRef({ db, tenantId }, "in_call", callLog.id)
          .catch((err: any) =>
            logger.warn(
              { err: err.message, callId: callLog.id },
              "clearActivityForRef(in_call) on cancel failed",
            ),
          );
        ws._callActivityRefId = null;
        // Inline "missed" call-history row in the chat thread (the callee never
        // answered before the caller cancelled / the ring timed out).
        await emitCallHistoryMessage(
          db,
          tenantId,
          Number(conversationId),
          senderId,
          callLog.call_type || "voice",
          "missed",
          null,
        );
        // P0 — drop any buffered signals for this now-dead call.
        clearCallBuffer(callLog.id);
      },
    );
  } else if (msg.type === "call_reject") {
    // Callee rejects → update call log, notify caller
    const { callId, conversationId, clientMsgId: rawIdReject } = msg.data || {};
    if (!callId || !conversationId) return;

    await withIdempotentCallAction(
      {
        tenantId,
        senderId,
        callId,
        action: "reject",
        clientMsgId: rawIdReject,
      },
      async () => {
        // Verify sender is a participant in this conversation
        const isParticipant = (
          await db.query(
            "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
            [conversationId, senderId],
          )
        ).rows[0];
        if (!isParticipant) return;

        const callLog = (
          await db.query(
            `SELECT * FROM call_logs WHERE id = $1 AND conversation_id = $2`,
            [callId, conversationId],
          )
        ).rows[0];
        if (!callLog) {
          recordCallTransitionFailure({
            event: "call_transition_failed",
            action: "reject",
            tenantId,
            senderId,
            callId,
            conversationId,
            reason: "call_not_found",
          });
          return;
        }
        if (callLog.status !== "ringing") {
          logger.info(
            { senderId, callId, conversationId, status: callLog.status },
            "call_reject: terminal/invalid state; ignoring",
          );
          recordCallTransitionFailure({
            event: "call_transition_failed",
            action: "reject",
            tenantId,
            senderId,
            callId,
            conversationId,
            fromStatus: callLog.status,
            reason: "invalid_transition",
          });
          return;
        }

        const updated = await db.query(
          `UPDATE call_logs
                     SET status = 'declined', ended_at = NOW()
                     WHERE id = $1 AND status = 'ringing'
                     RETURNING id`,
          [callId],
        );
        if (!updated.rows[0]) {
          recordCallTransitionFailure({
            event: "call_transition_failed",
            action: "reject",
            tenantId,
            senderId,
            callId,
            conversationId,
            reason: "transition_race",
          });
          return;
        }

        const rejecter = (
          await db.query("SELECT full_name FROM users WHERE id = $1", [
            senderId,
          ])
        ).rows[0];

        logPushCallLifecycle(
          {
            event: "native_call_action_applied",
            tenantId,
            userId: senderId,
            callId,
            conversationId,
            action: "reject",
            status: "success",
          },
          "info",
        );

        // Notify other participants
        const participants = (
          await db.query(
            "SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2",
            [conversationId, senderId],
          )
        ).rows;

        for (const p of participants) {
          sendToUser(tenantId, p.user_id, "call_rejected", {
            callId,
            conversationId,
            userId: senderId,
            userName: rejecter?.full_name,
          });
        }

        // Multi-session support: dismiss the ringing PiP on the rejecter's
        // other devices (e.g. desktop + browser). The session that pressed
        // "reject" has already cleared its PiP locally.
        sendToUser(tenantId, senderId, "call_handled_elsewhere", {
          callId,
          conversationId,
          action: "rejected",
        });

        // Push-cancel the rejecter's OTHER devices (locked/backgrounded
        // twin) so their native ring is dismissed, plus the caller's
        // devices so a backgrounded caller stops its outgoing ring.
        pushNotifications
          .sendCallCancellation(db.query as any, senderId, tenantId, {
            callId,
            conversationId,
            reason: "rejected",
          })
          .catch((err: any) =>
            logger.warn(
              { err: err.message, callId, userId: senderId },
              "Failed to push-cancel rejecter devices on reject",
            ),
          );
        pushNotifications
          .sendCallCancellation(db.query as any, callLog.caller_id, tenantId, {
            callId,
            conversationId,
            reason: "rejected",
          })
          .catch((err: any) =>
            logger.warn(
              { err: err.message, callId, userId: callLog.caller_id },
              "Failed to push-cancel caller devices on reject",
            ),
          );

        // Status service v2: if the callee had been auto-flagged in_call by a
        // racy accept (or the caller's device was still marked from initiate),
        // clear it for every session referencing this call.
        statusService
          .clearActivityForRef({ db, tenantId }, "in_call", callId)
          .catch((err: any) =>
            logger.warn(
              { err: err.message, callId },
              "clearActivityForRef(in_call) on reject failed",
            ),
          );

        // Inline "declined" call-history row in the chat thread.
        await emitCallHistoryMessage(
          db,
          tenantId,
          Number(conversationId),
          callLog.caller_id,
          callLog.call_type,
          "declined",
          null,
        );
        clearCallBuffer(Number(callId));
      },
    );
  } else if (msg.type === "call_end") {
    // Either party ends the call → update log, notify others
    const { callId, conversationId, clientMsgId: rawIdEnd } = msg.data || {};
    if (!callId || !conversationId) return;

    await withIdempotentCallAction(
      { tenantId, senderId, callId, action: "end", clientMsgId: rawIdEnd },
      async () => {
        // Verify sender is a participant in this conversation
        const isParticipant = (
          await db.query(
            "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
            [conversationId, senderId],
          )
        ).rows[0];
        if (!isParticipant) {
          recordCallTransitionFailure({
            event: "call_transition_failed",
            action: "end",
            tenantId,
            senderId,
            callId,
            conversationId,
            reason: "sender_not_participant",
          });
          return;
        }

        const callLog = (
          await db.query(
            `SELECT * FROM call_logs WHERE id = $1 AND conversation_id = $2`,
            [callId, conversationId],
          )
        ).rows[0];
        if (!callLog) {
          recordCallTransitionFailure({
            event: "call_transition_failed",
            action: "end",
            tenantId,
            senderId,
            callId,
            conversationId,
            reason: "call_not_found",
          });
          return;
        }
        if (["ended", "missed", "declined"].includes(callLog.status)) {
          logger.info(
            { senderId, callId, conversationId, status: callLog.status },
            "call_end: terminal state; ignoring duplicate",
          );
          recordCallTransitionFailure({
            event: "call_transition_failed",
            action: "end",
            tenantId,
            senderId,
            callId,
            conversationId,
            fromStatus: callLog.status,
            reason: "already_terminal",
          });
          return;
        }

        // Calculate duration if call was answered
        let duration: number | null = null;
        if (callLog.started_at) {
          duration = Math.round(
            (Date.now() - new Date(callLog.started_at).getTime()) / 1000,
          );
        }

        const updated = await db.query(
          `UPDATE call_logs
                     SET status = CASE WHEN status = 'ringing' THEN 'missed' ELSE 'ended' END,
                         ended_at = NOW(),
                         duration = $2
                     WHERE id = $1
                     RETURNING id`,
          [callId, duration],
        );
        if (!updated.rows[0]) {
          recordCallTransitionFailure({
            event: "call_transition_failed",
            action: "end",
            tenantId,
            senderId,
            callId,
            conversationId,
            reason: "transition_race",
          });
          return;
        }

        // Notify all participants about call end
        const allParticipants = (
          await db.query(
            "SELECT user_id FROM conversation_participants WHERE conversation_id = $1",
            [conversationId],
          )
        ).rows;

        for (const p of allParticipants) {
          if (p.user_id !== senderId) {
            sendToUser(tenantId, p.user_id, "call_ended", {
              callId,
              conversationId,
              endedBy: senderId,
              duration,
            });

            // P2.13 — Decline/end teardown parity. The WS `call_ended`
            // above only reaches sessions with a live socket. A
            // locked/backgrounded/killed twin (e.g. the call was ended
            // while it was still ringing, or a second device never
            // joined) keeps its native incoming-call ring / ongoing-call
            // notification until this data-only "call handled elsewhere"
            // push dismisses it — matching the call_cancel / call_reject
            // / stale-sweep teardown paths.
            pushNotifications
              .sendCallCancellation(db.query as any, p.user_id, tenantId, {
                callId,
                conversationId,
                reason: "ended",
              })
              .catch((err: any) =>
                logger.warn(
                  { err: err.message, callId, userId: p.user_id },
                  "Failed to push-cancel participant devices on end",
                ),
              );
          }
        }

        // Status service v2: clear in_call for every session referencing
        // this call (caller + all callees, across all their devices).
        statusService
          .clearActivityForRef({ db, tenantId }, "in_call", callId)
          .catch((err: any) =>
            logger.warn(
              { err: err.message, callId },
              "clearActivityForRef(in_call) on end failed",
            ),
          );
        if (ws._callActivityRefId === callId) ws._callActivityRefId = null;
        // Inline call-history row in the chat thread (Signal parity). A
        // call that was never answered (still `ringing`) is a MISSED
        // call; otherwise it `ended` with the measured duration.
        await emitCallHistoryMessage(
          db,
          tenantId,
          Number(conversationId),
          callLog.caller_id,
          callLog.call_type,
          callLog.status === "ringing" ? "missed" : "ended",
          duration,
        );
        // P0 — drop any buffered signals for this now-ended call.
        clearCallBuffer(Number(callId));
      },
    );
  } else if (msg.type === "call_signal") {
    // WebRTC signaling relay: offer, answer, ICE candidates
    const { conversationId, targetUserId, signal } = msg.data || {};
    if (!conversationId || !targetUserId || !signal) return;

    // Validate signal type against whitelist
    const VALID_SIGNAL_TYPES = [
      "offer",
      "answer",
      "ice-candidate",
      "video-state",
      "audio-state",
      "screen-share-state",
      "quality-state",
      "request-video-state",
    ];
    if (!signal.type || !VALID_SIGNAL_TYPES.includes(signal.type)) {
      logger.warn(
        { senderId, signalType: signal?.type },
        "call_signal: rejected unknown signal type",
      );
      return;
    }

    // Validate signal payload per type
    if (signal.type === "offer" || signal.type === "answer") {
      if (
        typeof signal.sdp !== "string" ||
        signal.sdp.length === 0 ||
        signal.sdp.length > 100000
      ) {
        logger.warn(
          { senderId, signalType: signal.type, sdpLen: signal.sdp?.length },
          "call_signal: invalid SDP",
        );
        return;
      }
    } else if (signal.type === "ice-candidate") {
      if (
        signal.candidate != null &&
        (typeof signal.candidate !== "object" ||
          typeof signal.candidate.candidate !== "string")
      ) {
        logger.warn(
          { senderId },
          "call_signal: invalid ICE candidate structure",
        );
        return;
      }
    } else if (signal.type === "video-state") {
      if (typeof signal.videoOff !== "boolean") return;
    } else if (signal.type === "quality-state") {
      // Self-reported connection quality so the peer can surface a
      // "<name>'s connection is unstable" banner (Teams/Meet parity).
      // Mobile already emits this every time its measured quality changes;
      // it MUST be whitelisted here or the relay drops every frame.
      if (!["good", "fair", "poor", "unknown"].includes(signal.quality)) {
        logger.warn(
          { senderId, quality: signal.quality },
          "call_signal: invalid quality-state",
        );
        return;
      }
    }

    // Verify BOTH sender and target are members of the conversation for
    // EVERY signal type (not just offer/answer). ICE/state frames were
    // previously relayed with no membership check, letting any tenant user
    // inject signaling to an arbitrary userId. Cached to survive ICE bursts.
    const senderOk = await isConversationMember(db, conversationId, senderId);
    const targetOk = await isConversationMember(
      db,
      conversationId,
      targetUserId,
    );
    if (!senderOk || !targetOk) {
      logger.warn(
        {
          senderId,
          targetUserId,
          conversationId,
          senderOk,
          targetOk,
          signalType: signal.type,
        },
        "call_signal: participant check failed",
      );
      return;
    }

    logger.debug(
      {
        senderId,
        targetUserId,
        conversationId,
        signalType: signal.type,
        tenantId,
      },
      "call_signal: relaying",
    );

    // RELIABLE DELIVERY (Signal-Android parity): if the target has NO open
    // socket on this instance, buffer the OFFER / ICE so we can replay it the
    // moment they subscribe/accept/become ready. This is the core fix for
    // "answered but never connects / black screen / can't connect from push":
    // the caller fires its offer the instant `call_accepted` arrives, but the
    // callee's call screen needs 1–5s to mount + subscribe. Without buffering
    // that offer (and early ICE) was silently dropped and the call hung.
    // We STILL relay (sendToUser also publishes cross-instance) so a callee on
    // another instance / already-subscribed still receives it immediately.
    const callIdForBuffer = Number(msg.data?.callId) || 0;
    if (
      (signal.type === "offer" || signal.type === "ice-candidate") &&
      !hasOpenSocket(tenantId, targetUserId)
    ) {
      if (callIdForBuffer) {
        bufferCallSignal(callIdForBuffer, senderId, targetUserId, signal);
        logger.debug(
          {
            senderId,
            targetUserId,
            conversationId,
            callId: callIdForBuffer,
            signalType: signal.type,
          },
          "call_signal: buffered for offline target",
        );
      }
    }

    // Relay the signal to the target user
    sendToUser(tenantId, targetUserId, "call_signal", {
      conversationId,
      fromUserId: senderId,
      signal,
    });
  } else if (msg.type === "call_subscribe") {
    // P0 — Reliable-delivery handshake. The callee's call screen sends this
    // the moment it mounts + subscribes to `call_signal`. We (1) replay any
    // OFFER/ICE that was buffered while they had no socket (single-instance
    // fast path) and (2) tell the OTHER participant(s) to re-send their offer
    // (`call_peer_ready`) so a cross-instance / never-buffered caller offer
    // is (re)delivered. The caller's offer creation is idempotent via Perfect
    // Negotiation so a duplicate is harmless.
    const { callId, conversationId } = msg.data || {};
    if (!callId || !conversationId) return;
    const isParticipant = await isConversationMember(
      db,
      conversationId,
      senderId,
    );
    if (!isParticipant) return;
    // Replay buffered signals to THIS subscriber.
    replayCallSignals(Number(callId), senderId, (fromUserId, signal) => {
      sendToUser(tenantId, senderId, "call_signal", {
        conversationId,
        fromUserId,
        signal,
      });
    });
    // Ask the other participant(s) to (re)send their offer.
    const others = (
      await db.query(
        "SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2",
        [conversationId, senderId],
      )
    ).rows;
    for (const p of others) {
      sendToUser(tenantId, p.user_id, "call_peer_ready", {
        callId,
        conversationId,
        userId: senderId,
      });
    }
  } else if (msg.type === "call_ready") {
    // P0 — The callee signals its PeerConnection exists and it is ready to
    // receive an offer. Relay to the other participant(s) so the caller
    // (re)sends its offer immediately (idempotent via Perfect Negotiation),
    // and replay any locally-buffered signals to the now-ready user.
    const { callId, conversationId } = msg.data || {};
    if (!callId || !conversationId) return;
    const isParticipant = await isConversationMember(
      db,
      conversationId,
      senderId,
    );
    if (!isParticipant) return;
    replayCallSignals(Number(callId), senderId, (fromUserId, signal) => {
      sendToUser(tenantId, senderId, "call_signal", {
        conversationId,
        fromUserId,
        signal,
      });
    });
    const others = (
      await db.query(
        "SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2",
        [conversationId, senderId],
      )
    ).rows;
    for (const p of others) {
      sendToUser(tenantId, p.user_id, "call_peer_ready", {
        callId,
        conversationId,
        userId: senderId,
      });
    }
  } else if (msg.type === "call_reconnect") {
    // User refreshed the page during an active call — notify the other party to re-offer
    const { callId, conversationId } = msg.data || {};
    if (!callId || !conversationId) return;

    const callLog = (
      await db.query(
        `SELECT * FROM call_logs WHERE id = $1 AND conversation_id = $2 AND status = 'answered'`,
        [callId, conversationId],
      )
    ).rows[0];
    if (!callLog) return;

    // Verify sender is in the conversation
    const participant = (
      await db.query(
        "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
        [conversationId, senderId],
      )
    ).rows[0];
    if (!participant) return;

    // Find the other participant(s) and tell them to re-offer
    const others = (
      await db.query(
        "SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2",
        [conversationId, senderId],
      )
    ).rows;

    for (const p of others) {
      sendToUser(tenantId, p.user_id, "call_reconnect", {
        callId,
        conversationId,
        userId: senderId,
      });
    }
  } else if (msg.type === "call_reaction") {
    const { conversationId, targetUserId, emoji } = msg.data || {};
    if (!conversationId || !targetUserId || !emoji) return;
    const allowedEmojis = [
      "\u{1F44D}",
      "\u{1F44F}",
      "\u{2764}\u{FE0F}",
      "\u{1F602}",
      "\u{1F389}",
      "\u{1F914}",
    ];
    if (!allowedEmojis.includes(emoji)) return;
    // Both sender AND target must be in the conversation — otherwise a
    // participant could spam reactions at arbitrary users (privacy/harassment).
    const senderInConv = await isConversationMember(
      db,
      conversationId,
      senderId,
    );
    if (!senderInConv) return;
    const targetInConv = await isConversationMember(
      db,
      conversationId,
      targetUserId,
    );
    if (!targetInConv) return;
    sendToUser(tenantId, targetUserId, "call_reaction", {
      conversationId,
      fromUserId: senderId,
      emoji,
    });
    // ═══════════════════════════════════════════════════════
    //  MEETING HANDLERS
    // ═══════════════════════════════════════════════════════
  } else if (msg.type === "meeting_join") {
    const { meetingId } = msg.data || {};
    if (!meetingId) return;

    // First thing: cancel any pending disconnect-cleanup. Happy path for
    // a transient WS drop — the user reconnected within the grace window,
    // so we silently keep them in the meeting (no `meeting_participant_left`
    // was ever broadcast and the other participants' RTCPeerConnections
    // are untouched).
    const cancelledPending = cancelMeetingDisconnectCleanup({
      tenantId,
      userId: senderId,
      meetingId,
    });
    if (cancelledPending) {
      logger.debug(
        { userId: senderId, meetingId },
        "Cancelled pending meeting cleanup on rejoin",
      );
    }

    const meeting = (
      await db.query("SELECT * FROM meetings WHERE id = $1", [meetingId])
    ).rows[0];
    if (!meeting) return;

    // Allow rejoining ended meetings — reactivate the meeting
    if (meeting.status === "ended") {
      await db.query(
        `UPDATE meetings SET status = 'active', ended_at = NULL WHERE id = $1`,
        [meetingId],
      );
    }

    // Verify participant is allowed
    const mp = (
      await db.query(
        "SELECT status FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2",
        [meetingId, senderId],
      )
    ).rows[0];
    const isOrgMember = meeting.org_id
      ? (
          await db.query("SELECT 1 FROM users WHERE id = $1 AND org_id = $2", [
            senderId,
            meeting.org_id,
          ])
        ).rows[0]
      : true;
    if (!mp && !isOrgMember) return;

    // Track if this is a rejoin (already had status 'joined') to skip duplicate system messages
    const wasAlreadyJoined = mp?.status === "joined";

    // Upsert participant
    await db.query(
      `INSERT INTO meeting_participants (meeting_id, user_id, role, status, joined_at)
             VALUES ($1, $2, 'participant', 'joined', NOW())
             ON CONFLICT (meeting_id, user_id) DO UPDATE SET status = 'joined', joined_at = NOW(), left_at = NULL`,
      [meetingId, senderId],
    );

    // Tag this WS connection so we can clean up on disconnect
    ws._activeMeetingId = meetingId;

    // Determine if we should notify other participants
    const isRestart = meeting.status === "ended";
    const isFirstStart = meeting.status === "scheduled";
    // For active meetings, notify if no one else is currently in the meeting
    let isFirstJoinActive = false;
    if (meeting.status === "active" && !isFirstStart) {
      const currentlyJoined = (
        await db.query(
          `SELECT COUNT(*) as cnt FROM meeting_participants WHERE meeting_id = $1 AND status = 'joined' AND user_id != $2`,
          [meetingId, senderId],
        )
      ).rows[0];
      isFirstJoinActive = parseInt(currentlyJoined.cnt) === 0;
    }

    // Mark meeting as active on first join
    if (isFirstStart) {
      await db.query(
        `UPDATE meetings SET status = 'active', started_at = NOW() WHERE id = $1`,
        [meetingId],
      );
    }

    // Huddles (instant group CALLS) are decoupled from the user-visible
    // "Meeting" concept: they must NOT emit `meeting_started` /
    // `meeting_restarted` cards, persistent notifications, or a
    // `meeting_joined` system message into the chat. The group stays a pure
    // chat group and the call rings via `call_incoming` only. The mesh
    // transport (peer discovery via `meeting_participant_joined`) is reused.
    if (!meeting.is_huddle && (isFirstStart || isRestart || isFirstJoinActive)) {
      // Notify all invited participants that the meeting has started/restarted
      const allInvited = (
        await db.query(
          `SELECT mp.user_id FROM meeting_participants mp
                 WHERE mp.meeting_id = $1 AND mp.user_id != $2`,
          [meetingId, senderId],
        )
      ).rows;
      const starter = (
        await db.query("SELECT full_name, avatar FROM users WHERE id = $1", [
          senderId,
        ])
      ).rows[0];
      const starterName = starter?.full_name || "Someone";
      const notifType = isRestart ? "meeting_restarted" : "meeting_started";
      const notifTitle = isRestart
        ? `Meeting Restarted: ${meeting.title || "Untitled"}`
        : `Meeting Started: ${meeting.title || "Untitled"}`;
      const notifBody = isRestart
        ? `${starterName} restarted the meeting`
        : `${starterName} started the meeting`;

      for (const p of allInvited) {
        try {
          await db.query(
            `INSERT INTO notifications (user_id, type, title, body) VALUES ($1, $2, $3, $4)`,
            [p.user_id, notifType, notifTitle, notifBody],
          );
        } catch {
          /* ignore duplicate or constraint errors */
        }

        sendToUser(tenantId, p.user_id, "meeting_started", {
          meetingId,
          meetingCode: meeting.meeting_code,
          title: meeting.title,
          organizerName: starterName,
          organizerAvatar: starter?.avatar,
          startedBy: senderId,
          restarted: isRestart,
        });
        sendToUser(tenantId, p.user_id, "notification", {
          title: notifTitle,
          body: notifBody,
        });
      }
    }

    const [joinerResult, allParticipantsResult] = await Promise.all([
      db.query("SELECT full_name, avatar, username FROM users WHERE id = $1", [
        senderId,
      ]),
      db.query(
        `SELECT mp.user_id, u.full_name, u.avatar, u.username
                 FROM meeting_participants mp JOIN users u ON u.id = mp.user_id
                 WHERE mp.meeting_id = $1 AND mp.status = $2`,
        [meetingId, "joined"],
      ),
    ]);

    const joiner = joinerResult.rows[0];
    const allParticipants = allParticipantsResult.rows;

    // Build existingPeers with full user info so the joiner can display names
    const existingPeers = allParticipants
      .filter((p) => p.user_id !== senderId)
      .map((p) => ({
        userId: p.user_id,
        fullName: p.full_name,
        avatar: p.avatar,
        username: p.username,
      }));

    for (const p of allParticipants) {
      sendToUser(tenantId, p.user_id, "meeting_participant_joined", {
        meetingId,
        userId: senderId,
        fullName: joiner?.full_name,
        avatar: joiner?.avatar,
        username: joiner?.username,
        existingPeers: p.user_id === senderId ? existingPeers : undefined,
      });
    }

    // RELIABLE MESH DELIVERY: replay any OFFER/ICE that existing peers sent
    // toward this user while they had no open socket (cold start / reconnect
    // within the grace window). The joiner just attached its WS handler and
    // got `existingPeers`, so it is ready to consume them. This is the mesh
    // analogue of the 1:1 `call_accept`/`call_subscribe` replay and the core
    // fix for "one tile stuck on Connecting…" after a (re)join. The client
    // additionally sends `meeting_subscribe` for a belt-and-braces re-request,
    // but replaying here means the happy path needs no extra round-trip.
    replayMeetingSignals(Number(meetingId), senderId, (fromUserId, signal) => {
      sendToUser(tenantId, senderId, "meeting_signal", {
        meetingId,
        fromUserId,
        signal,
      });
    });

    // System message in conversation (skip on PiP rejoin to avoid duplicates).
    // Huddles never post a `meeting_joined` system row — a group CALL is not a
    // meeting and must not leave meeting artifacts in the chat thread.
    if (meeting.conversation_id && !wasAlreadyJoined && !meeting.is_huddle) {
      const sysMsg = (
        await db.query(
          `INSERT INTO messages (conversation_id, sender_id, content, format_type, metadata)
                 VALUES ($1, $2, '', 'system', $3) RETURNING id, created_at`,
          [
            meeting.conversation_id,
            senderId,
            JSON.stringify({
              type: "meeting_joined",
              meetingId,
              name: joiner?.full_name,
            }),
          ],
        )
      ).rows[0];
      const convParticipants = (
        await db.query(
          "SELECT user_id FROM conversation_participants WHERE conversation_id = $1",
          [meeting.conversation_id],
        )
      ).rows;
      for (const p of convParticipants) {
        sendToUser(tenantId, p.user_id, "chat_message", {
          id: sysMsg.id,
          conversationId: meeting.conversation_id,
          senderId,
          content: "",
          formatType: "system",
          metadata: {
            type: "meeting_joined",
            meetingId,
            name: joiner?.full_name,
          },
          createdAt: sysMsg.created_at,
        });
      }
    }

    // Status service v2: mark THIS device of the joiner as in_meeting.
    // Per-session: their other tabs/devices retain their existing status.
    if (ws._statusSessionKey) {
      statusService
        .setSessionActivity(
          { db, tenantId },
          ws._statusSessionKey,
          "in_meeting",
          meetingId,
        )
        .catch((err: any) =>
          logger.warn(
            { err: err.message, meetingId },
            "setSessionActivity(in_meeting) failed",
          ),
        );
      ws._meetingActivityRefId = meetingId;
    }
  } else if (msg.type === "meeting_leave") {
    const { meetingId } = msg.data || {};
    if (!meetingId) return;

    // Clear the tag so disconnect handler doesn't double-leave
    ws._activeMeetingId = null;
    // An explicit leave overrides any scheduled grace-window cleanup
    // — we do the cleanup synchronously below instead.
    cancelMeetingDisconnectCleanup({ tenantId, userId: senderId, meetingId });

    // Verify sender is actually a joined participant
    const isJoined = (
      await db.query(
        `SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2 AND status = 'joined'`,
        [meetingId, senderId],
      )
    ).rows[0];
    if (!isJoined) return;

    await db.query(
      `UPDATE meeting_participants SET status = 'left', left_at = NOW() WHERE meeting_id = $1 AND user_id = $2`,
      [meetingId, senderId],
    );

    // Drop any mesh signals buffered for / from the leaver.
    clearMeetingUserBuffer(meetingId, senderId);

    const activeParticipants = (
      await db.query(
        `SELECT mp.user_id FROM meeting_participants mp WHERE mp.meeting_id = $1 AND mp.status = 'joined'`,
        [meetingId],
      )
    ).rows;

    for (const p of activeParticipants) {
      sendToUser(tenantId, p.user_id, "meeting_participant_left", {
        meetingId,
        userId: senderId,
      });
    }

    // If no active participants, mark meeting ended (use WHERE to prevent double-update race)
    if (activeParticipants.length === 0) {
      // Empty meeting — drop the whole mesh signal buffer.
      clearMeetingBuffer(meetingId);
      await db.query(
        `UPDATE meetings SET status = 'ended', ended_at = NOW() WHERE id = $1 AND status != 'ended'`,
        [meetingId],
      );

      // HUDDLE RING-CANCEL (Slack/Teams/Signal parity): a "huddle" is a group
      // CALL whose ring is a `call_incoming` event sent to every invited
      // member. If the LAST joined participant leaves — most importantly the
      // initiator backing out BEFORE anyone answered — the callees' devices are
      // still ringing (they only dismiss on call_ended/rejected/handled). We
      // must therefore broadcast `call_ended` + push-cancel to every invited
      // member so the ring stops everywhere. Best-effort.
      try {
        const meetingRow = (
          await db.query(
            "SELECT id, is_huddle, conversation_id FROM meetings WHERE id = $1",
            [meetingId],
          )
        ).rows[0];
        if (meetingRow?.is_huddle) {
          const invited = (
            await db.query(
              `SELECT user_id FROM meeting_participants WHERE meeting_id = $1`,
              [meetingId],
            )
          ).rows;
          for (const p of invited) {
            sendToUser(tenantId, p.user_id, "call_ended", {
              callId: meetingRow.id,
              conversationId: meetingRow.conversation_id,
              reason: "cancelled",
            });
            pushNotifications
              .sendCallCancellation(db.query as any, p.user_id, tenantId, {
                callId: meetingRow.id,
                conversationId: meetingRow.conversation_id,
                reason: "cancelled",
              })
              .catch((err: any) =>
                logger.warn(
                  { err: err?.message, userId: p.user_id, meetingId },
                  "huddle ring-cancel push (meeting_leave) failed",
                ),
              );
          }
        }
      } catch (err: any) {
        logger.warn(
          { err: err?.message, meetingId },
          "huddle ring-cancel on meeting_leave failed",
        );
      }
    }

    // Status service v2: clear in_meeting on THIS device only. Other
    // devices of the same user (e.g. they joined the meeting from
    // desktop while ALSO having a browser tab open with no meeting)
    // keep their state intact.
    if (ws._statusSessionKey) {
      statusService
        .clearSessionActivity(
          { db, tenantId },
          ws._statusSessionKey,
          "in_meeting",
        )
        .catch((err: any) =>
          logger.warn(
            { err: err.message, meetingId },
            "clearSessionActivity(in_meeting) on leave failed",
          ),
        );
      if (ws._meetingActivityRefId === meetingId)
        ws._meetingActivityRefId = null;
    }
  } else if (msg.type === "meeting_end") {
    const { meetingId } = msg.data || {};
    if (!meetingId) return;

    ws._activeMeetingId = null;
    cancelMeetingDisconnectCleanup({ tenantId, userId: senderId, meetingId });

    const meeting = (
      await db.query(
        "SELECT * FROM meetings WHERE id = $1 AND created_by = $2",
        [meetingId, senderId],
      )
    ).rows[0];
    if (!meeting) return;

    const startedAt = meeting.started_at ? new Date(meeting.started_at) : null;
    const durationSecs = startedAt
      ? Math.round((Date.now() - startedAt.getTime()) / 1000)
      : null;

    await db.query(
      `UPDATE meetings SET status = 'ended', ended_at = NOW() WHERE id = $1`,
      [meetingId],
    );
    await db.query(
      `UPDATE meeting_participants SET status = 'left', left_at = NOW() WHERE meeting_id = $1`,
      [meetingId],
    );

    // Terminal transition — drop the whole mesh signal buffer for this meeting.
    clearMeetingBuffer(meetingId);

    const activeParticipants = (
      await db.query(
        "SELECT user_id FROM meeting_participants WHERE meeting_id = $1",
        [meetingId],
      )
    ).rows;

    for (const p of activeParticipants) {
      sendToUser(tenantId, p.user_id, "meeting_ended", {
        meetingId,
        endedBy: senderId,
        duration: durationSecs,
      });
    }

    // HUDDLE RING-CANCEL (Slack/Teams/Signal parity): the host ended a group
    // CALL. Any invited member still ringing (never answered) must have their
    // ring dismissed — broadcast `call_ended` + push-cancel to every invited
    // member. Best-effort.
    if (meeting.is_huddle) {
      try {
        const invited = (
          await db.query(
            `SELECT user_id FROM meeting_participants WHERE meeting_id = $1`,
            [meetingId],
          )
        ).rows;
        for (const p of invited) {
          sendToUser(tenantId, p.user_id, "call_ended", {
            callId: meeting.id,
            conversationId: meeting.conversation_id,
            reason: "ended",
          });
          pushNotifications
            .sendCallCancellation(db.query as any, p.user_id, tenantId, {
              callId: meeting.id,
              conversationId: meeting.conversation_id,
              reason: "ended",
            })
            .catch((err: any) =>
              logger.warn(
                { err: err?.message, userId: p.user_id, meetingId },
                "huddle ring-cancel push (meeting_end) failed",
              ),
            );
        }
      } catch (err: any) {
        logger.warn(
          { err: err?.message, meetingId },
          "huddle ring-cancel on meeting_end failed",
        );
      }
    }

    // System message in conversation. Huddles never post a meeting system row.
    if (meeting.conversation_id && !meeting.is_huddle) {
      const sysMsg = (
        await db.query(
          `INSERT INTO messages (conversation_id, sender_id, content, format_type, metadata)
                 VALUES ($1, $2, '', 'system', $3) RETURNING id, created_at`,
          [
            meeting.conversation_id,
            senderId,
            JSON.stringify({
              type: "meeting_ended",
              meetingId,
              duration: durationSecs,
            }),
          ],
        )
      ).rows[0];
      const convParticipants = (
        await db.query(
          "SELECT user_id FROM conversation_participants WHERE conversation_id = $1",
          [meeting.conversation_id],
        )
      ).rows;
      for (const p of convParticipants) {
        sendToUser(tenantId, p.user_id, "chat_message", {
          id: sysMsg.id,
          conversationId: meeting.conversation_id,
          senderId,
          content: "",
          formatType: "system",
          metadata: {
            type: "meeting_ended",
            meetingId,
            duration: durationSecs,
          },
          createdAt: sysMsg.created_at,
        });
      }
    }

    // Status service v2: end of meeting → clear in_meeting for EVERY
    // session referencing this meetingId (every participant, every device).
    statusService
      .clearActivityForRef({ db, tenantId }, "in_meeting", meetingId)
      .catch((err: any) =>
        logger.warn(
          { err: err.message, meetingId },
          "clearActivityForRef(in_meeting) on end failed",
        ),
      );
    if (ws._meetingActivityRefId === meetingId) ws._meetingActivityRefId = null;
  } else if (msg.type === "meeting_signal") {
    // WebRTC mesh signaling between meeting participants
    const { meetingId, targetUserId, signal } = msg.data || {};
    if (!meetingId || !targetUserId || !signal) return;

    // Verify BOTH sender and target are participants of the meeting for
    // EVERY signal type. Previously only offer/answer checked the sender
    // (never the target) and ICE skipped all checks, letting any tenant
    // user inject mesh signaling to an arbitrary userId. Cached for ICE bursts.
    const senderOk = await isMeetingMember(db, meetingId, senderId);
    const targetOk = await isMeetingMember(db, meetingId, targetUserId);
    if (!senderOk || !targetOk) {
      logger.warn(
        {
          senderId,
          targetUserId,
          meetingId,
          senderOk,
          targetOk,
          signalType: signal?.type,
        },
        "meeting_signal: participant check failed",
      );
      return;
    }

    logger.debug(
      { senderId, targetUserId, meetingId, signalType: signal.type, tenantId },
      "meeting_signal: relaying",
    );

    // RELIABLE MESH DELIVERY (group-call parity with the 1:1 buffer): if the
    // target peer has NO open socket on this instance (mid-join, cold start,
    // or briefly reconnecting within the 15s grace window), buffer the OFFER /
    // ICE so we can replay it the instant they (re)join / subscribe / signal
    // ready. Without this the one offline pair never connects while the rest
    // of the mesh does ("one tile stuck on Connecting…"). We STILL relay below
    // (sendToUser also publishes cross-instance) so an already-subscribed peer
    // on this or another instance receives it immediately.
    if (
      (signal.type === "offer" || signal.type === "candidate") &&
      !hasOpenSocket(tenantId, targetUserId)
    ) {
      bufferMeetingSignal(
        Number(meetingId),
        senderId,
        Number(targetUserId),
        signal,
      );
      logger.debug(
        { senderId, targetUserId, meetingId, signalType: signal.type },
        "meeting_signal: buffered for offline peer",
      );
    }

    sendToUser(tenantId, targetUserId, "meeting_signal", {
      meetingId,
      fromUserId: senderId,
      signal,
    });
  } else if (msg.type === "meeting_subscribe") {
    // GROUP-CALL reliable-delivery handshake (mesh parity with `call_subscribe`).
    // A (re)joining peer sends this once its WS handler is attached + it is
    // ready to receive offers. We (1) replay any OFFER/ICE buffered for them
    // while they were offline, and (2) tell every OTHER joined peer to
    // (re)offer toward this user via `meeting_peer_ready` (idempotent under
    // Perfect Negotiation). This closes the race where a peer's offer was
    // emitted before the newcomer's handler was listening.
    const { meetingId } = msg.data || {};
    if (!meetingId) return;
    if (!(await isMeetingMember(db, meetingId, senderId))) return;
    replayMeetingSignals(Number(meetingId), senderId, (fromUserId, signal) => {
      sendToUser(tenantId, senderId, "meeting_signal", {
        meetingId,
        fromUserId,
        signal,
      });
    });
    const others = (
      await db.query(
        `SELECT user_id FROM meeting_participants WHERE meeting_id = $1 AND status = 'joined' AND user_id != $2`,
        [meetingId, senderId],
      )
    ).rows;
    for (const p of others) {
      sendToUser(tenantId, p.user_id, "meeting_peer_ready", {
        meetingId,
        userId: senderId,
      });
    }
  } else if (msg.type === "meeting_ready") {
    // GROUP-CALL: the peer's RTCPeerConnection set is built and it is ready to
    // (re)negotiate. Same effect as `meeting_subscribe` — replay buffered
    // signals to this user and ask the other peers to (re)offer. Kept as a
    // distinct verb so the client can signal "media acquired + PCs created"
    // separately from "WS subscribed" (mirrors call_ready vs call_subscribe).
    const { meetingId } = msg.data || {};
    if (!meetingId) return;
    if (!(await isMeetingMember(db, meetingId, senderId))) return;
    replayMeetingSignals(Number(meetingId), senderId, (fromUserId, signal) => {
      sendToUser(tenantId, senderId, "meeting_signal", {
        meetingId,
        fromUserId,
        signal,
      });
    });
    const others = (
      await db.query(
        `SELECT user_id FROM meeting_participants WHERE meeting_id = $1 AND status = 'joined' AND user_id != $2`,
        [meetingId, senderId],
      )
    ).rows;
    for (const p of others) {
      sendToUser(tenantId, p.user_id, "meeting_peer_ready", {
        meetingId,
        userId: senderId,
      });
    }
  } else if (msg.type === "meeting_add_participant") {
    // Organizer adds someone to an active meeting
    const { meetingId, targetUserId } = msg.data || {};
    if (!meetingId || !targetUserId) return;

    const meeting = (
      await db.query(
        "SELECT * FROM meetings WHERE id = $1 AND created_by = $2",
        [meetingId, senderId],
      )
    ).rows[0];
    if (!meeting || meeting.status === "ended") return;

    const targetUser = (
      await db.query("SELECT full_name, avatar FROM users WHERE id = $1", [
        targetUserId,
      ])
    ).rows[0];
    if (!targetUser) return;

    await db.query(
      `INSERT INTO meeting_participants (meeting_id, user_id, role, status)
             VALUES ($1, $2, 'participant', 'invited') ON CONFLICT (meeting_id, user_id) DO NOTHING`,
      [meetingId, targetUserId],
    );
    if (meeting.conversation_id) {
      await db.query(
        `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [meeting.conversation_id, targetUserId],
      );
    }

    const organizer = (
      await db.query("SELECT full_name, avatar FROM users WHERE id = $1", [
        senderId,
      ])
    ).rows[0];

    if (meeting.is_huddle) {
      // Group CALL (huddle): RING the added member with `call_incoming` so they
      // get the native incoming-call UI and join the live mesh (Signal-style
      // "add to call"), instead of a passive meeting invite. Mirrors the
      // huddle create ring in routes/meetings.ts.
      const callType =
        meeting.settings && meeting.settings.callType === "video"
          ? "video"
          : "voice";
      sendToUser(tenantId, targetUserId, "call_incoming", {
        callId: meeting.id,
        conversationId: meeting.conversation_id,
        callerId: senderId,
        callerName: organizer?.full_name,
        callerAvatar: organizer?.avatar,
        callType,
        isGroup: true,
        groupName: meeting.title,
        meetingCode: meeting.meeting_code,
        meetingId: meeting.id,
        isHuddle: true,
        isJoining: true,
      });
      pushNotifications
        .sendCallNotification(db.query as any, targetUserId, tenantId, {
          callId: meeting.id,
          conversationId: meeting.conversation_id,
          callerId: senderId,
          callerName: organizer?.full_name || "Unknown",
          callerAvatar: organizer?.avatar,
          callType: callType as "voice" | "video",
          isGroup: true,
          groupName: meeting.title,
          meetingCode: meeting.meeting_code,
        })
        .catch((err: any) => {
          logger.warn(
            { err: err.message, userId: targetUserId, meetingId },
            "Failed to send huddle add-participant push notification",
          );
        });
    } else {
      sendToUser(tenantId, targetUserId, "meeting_invite", {
        meetingId,
        meetingCode: meeting.meeting_code,
        title: meeting.title,
        organizerName: organizer?.full_name,
        conversationId: meeting.conversation_id,
        isOngoing: true,
      });
    }
  } else if (msg.type === "meeting_mute_participant") {
    // Organizer mutes/unmutes a participant. Phase 3 — Permission Presets:
    // route through the shared `meetingPermissions` helper so the 'open'
    // preset (which lets every joined participant mute anyone) works
    // without an extra branch here. The previous behaviour was
    // "only the organiser can mute"; the standard preset preserves that.
    //
    // Phase 2 — Idempotency: clients now send an optional `clientMsgId`
    // for every mute toggle. `withIdempotency` dedupes the second
    // click during a glitchy WS reconnect so the target doesn't see
    // their mic toggled twice in a row. Legacy clients (no id) keep
    // the previous behaviour — the wrapper is a no-op without an id.
    const {
      meetingId,
      targetUserId,
      muted,
      clientMsgId: rawIdMute,
    } = msg.data || {};
    if (!meetingId || !targetUserId) return;
    await withIdempotency(
      {
        tenantId,
        senderId,
        type: "meeting_mute_participant",
        clientMsgId: rawIdMute,
      },
      async () => {
        const meeting = (
          await db.query("SELECT * FROM meetings WHERE id = $1", [meetingId])
        ).rows[0];
        if (!meeting) return;
        const meetingPerms = require("./meetingPermissions");
        if (
          !meetingPerms.can(
            { userId: senderId },
            meeting,
            meetingPerms.ACTIONS.MUTE_OTHERS,
          )
        )
          return;

        // Notify the target to mute/unmute themselves
        sendToUser(tenantId, targetUserId, "meeting_muted", {
          meetingId,
          muted: muted !== false,
          byUserId: senderId,
        });

        // Broadcast updated mute state to all participants so UI reflects change
        const participants = (
          await db.query(
            `SELECT user_id FROM meeting_participants WHERE meeting_id = $1 AND status = 'joined'`,
            [meetingId],
          )
        ).rows;
        for (const p of participants) {
          if (p.user_id !== targetUserId) {
            sendToUser(tenantId, p.user_id, "meeting_track_state", {
              meetingId,
              userId: targetUserId,
              muted: muted !== false,
              videoOff: null,
              screenSharing: null,
            });
          }
        }
      },
    );
  } else if (msg.type === "meeting_raise_hand") {
    // Phase 2 — Idempotency: the hand-toggle button is one of the
    // easiest things to double-fire on a flaky link (user taps, sees
    // no response, taps again). With `clientMsgId` the second tap
    // becomes a free no-op rather than re-flipping the state and
    // re-broadcasting to every participant.
    const { meetingId, raised, clientMsgId: rawIdHand } = msg.data || {};
    if (!meetingId) return;
    await withIdempotency(
      {
        tenantId,
        senderId,
        type: "meeting_raise_hand",
        clientMsgId: rawIdHand,
      },
      async () => {
        // Verify sender is an active participant
        const senderOk = (
          await db.query(
            `SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2 AND status = 'joined'`,
            [meetingId, senderId],
          )
        ).rows[0];
        if (!senderOk) return;

        const participants = (
          await db.query(
            `SELECT user_id FROM meeting_participants WHERE meeting_id = $1 AND status = 'joined'`,
            [meetingId],
          )
        ).rows;

        const raiser = (
          await db.query("SELECT full_name FROM users WHERE id = $1", [
            senderId,
          ])
        ).rows[0];
        for (const p of participants) {
          sendToUser(tenantId, p.user_id, "meeting_hand_raised", {
            meetingId,
            userId: senderId,
            name: raiser?.full_name,
            raised: !!raised,
          });
        }
      },
    );
  } else if (msg.type === "meeting_track_state") {
    // Participant broadcasts their muted/videoOff state
    const { meetingId, muted, videoOff, screenSharing } = msg.data || {};
    if (!meetingId) return;

    // Verify sender is an active participant
    const senderOk = (
      await db.query(
        `SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2 AND status = 'joined'`,
        [meetingId, senderId],
      )
    ).rows[0];
    if (!senderOk) return;

    const participants = (
      await db.query(
        `SELECT user_id FROM meeting_participants WHERE meeting_id = $1 AND status = 'joined'`,
        [meetingId],
      )
    ).rows;

    // Only include explicitly-sent fields to avoid coercing undefined to false
    const trackState: Record<string, unknown> = { meetingId, userId: senderId };
    if (muted !== undefined) trackState.muted = !!muted;
    if (videoOff !== undefined) trackState.videoOff = !!videoOff;
    if (screenSharing !== undefined) trackState.screenSharing = !!screenSharing;

    for (const p of participants) {
      if (p.user_id !== senderId) {
        sendToUser(tenantId, p.user_id, "meeting_track_state", trackState);
      }
    }
  } else if (msg.type === "meeting_request_quality") {
    // Phase 5 — Mesh quality. The receiving peer is telling the sending
    // peer "I only need 'q' / 'h' / 'f' (quality/half/full) right now"
    // because the sender's tile is currently:
    //   • off-screen (IntersectionObserver fired)
    //   • a tiny PiP / sidebar mini tile
    //   • NOT the active speaker (Phase 5 prioritisation)
    //
    // The sending peer flips `setParameters({ encodings: [{ maxBitrate }]})`
    // on the matching RTCRtpSender. This is the mesh equivalent of an SFU's
    // simulcast layer selection — done client-side because mesh has no
    // server-side media routing.
    //
    // Server is a pure relay; no DB checks (both parties were verified at
    // meeting_join). The payload is intentionally tiny so we don't
    // care about validation overhead.
    const { meetingId, targetUserId, level } = msg.data || {};
    if (!meetingId || !targetUserId) return;
    if (!["q", "h", "f"].includes(level)) return;
    // Verify sender and target are both meeting participants before relaying
    // — otherwise any user could force an arbitrary user's encoder to the
    // lowest bitrate (media-sabotage DoS). Cached.
    if (!(await isMeetingMember(db, meetingId, senderId))) return;
    if (!(await isMeetingMember(db, meetingId, targetUserId))) return;
    sendToUser(tenantId, targetUserId, "meeting_request_quality", {
      meetingId,
      fromUserId: senderId,
      level,
    });
  } else if (msg.type === "meeting_audio_level") {
    // Phase 5 — Active-speaker. Sender broadcasts their local RMS audio
    // level (0..1) sampled every ~500ms via the existing WebAudio
    // analyser. The server fans this out to every participant so they
    // can independently compute "who's the active speaker right now"
    // without needing a central SFU. We deliberately throttle on the
    // CLIENT (not here) — server is a dumb relay.
    const { meetingId, level } = msg.data || {};
    if (!meetingId || typeof level !== "number" || level < 0 || level > 1)
      return;
    // Reuse the meeting-chat broadcast audience (joined + invited) so
    // mid-reconnect participants don't miss active-speaker updates.
    const senderOk = (
      await db.query(
        `SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2 AND status = 'joined'`,
        [meetingId, senderId],
      )
    ).rows[0];
    if (!senderOk) return;
    const participants = (
      await db.query(
        `SELECT user_id FROM meeting_participants WHERE meeting_id = $1 AND status = 'joined'`,
        [meetingId],
      )
    ).rows;
    for (const p of participants) {
      if (p.user_id === senderId) continue;
      sendToUser(tenantId, p.user_id, "meeting_audio_level", {
        meetingId,
        userId: senderId,
        level,
      });
    }
  } else if (msg.type === "meeting_screen_track_id") {
    // Sender is announcing which of the tracks they sent over their
    // peer connection is the screen share. Client-side `useMeetingState`
    // uses this to route the incoming track from the camera stream
    // (shown in the participant tile) to a dedicated screen stream
    // (shown in PresenterView). Server only relays — no DB checks
    // needed since both peers were already verified at meeting_join.
    const { meetingId, targetUserId, sharing, trackId } = msg.data || {};
    if (!meetingId || !targetUserId) return;
    // Verify sender and target are both meeting participants before relaying
    // — otherwise any user could inject screen-routing signals at an
    // arbitrary user. Cached.
    if (!(await isMeetingMember(db, meetingId, senderId))) return;
    if (!(await isMeetingMember(db, meetingId, targetUserId))) return;
    sendToUser(tenantId, targetUserId, "meeting_screen_track_id", {
      meetingId,
      fromUserId: senderId,
      sharing: !!sharing,
      trackId: trackId || null,
    });
  } else if (msg.type === "meeting_chat") {
    // In-meeting chat message relay (text or file).
    //
    // RELIABILITY MODEL (Phase 0.5 "chat disappears" fix):
    //   • The client mints a `clientMsgId` (UUID) for every send and
    //     keeps the message in its pending-send queue until it sees
    //     either an echo OR an explicit ack from us. This handler
    //     therefore MUST be idempotent w.r.t. clientMsgId so retries
    //     from a flaky network never create duplicates.
    //   • Idempotency is enforced at the DB layer by the partial unique
    //     index `idx_messages_client_msg_id` over
    //     (conversation_id, sender_id, client_msg_id). We use
    //     `INSERT ... ON CONFLICT DO NOTHING` and, on conflict, fetch
    //     the canonical row so the echo always carries the persisted
    //     `id` + `created_at`.
    //   • We send a dedicated `meeting_message_ack` to the sender
    //     immediately after persistence, decoupled from the broadcast
    //     loop. This is critical because the broadcast only delivers
    //     to participants whose `status='joined'` AT THIS MOMENT — if
    //     the sender themselves is mid-reconnect, they'd never see the
    //     echo and the message would sit in their pending queue
    //     forever, eventually flipping to `_failed`. The ack closes
    //     that hole.
    //   • Persist errors are surfaced via `meeting_message_error`
    //     instead of being silently swallowed.
    //
    // PERSISTENCE: messages are written to the same `messages` table
    // used by regular chat, scoped to the meeting's `conversation_id`.
    // This mirrors videosdk's PubSub `persist: true` semantic and lets
    // participants who refresh / rejoin re-hydrate the full chat
    // history via `GET /api/meetings/:code/messages`.
    const { meetingId, text, file_url, file_name, file_size, clientMsgId } =
      msg.data || {};
    if (!meetingId) return;
    if (
      !file_url &&
      (!text || typeof text !== "string" || !text.trim() || text.length > 5000)
    ) {
      if (clientMsgId)
        sendToUser(tenantId, senderId, "meeting_message_error", {
          clientMsgId,
          reason: "invalid-payload",
        });
      return;
    }
    // We accept messages without a clientMsgId for backwards-compat,
    // but every new client supplies one. Sanity-cap the length so we
    // don't index unbounded user input.
    const safeClientMsgId =
      typeof clientMsgId === "string" &&
      clientMsgId.length > 0 &&
      clientMsgId.length <= 64
        ? clientMsgId
        : null;

    // Verify sender is an active participant
    const senderOk = (
      await db.query(
        `SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2 AND status = 'joined'`,
        [meetingId, senderId],
      )
    ).rows[0];
    if (!senderOk) {
      if (safeClientMsgId)
        sendToUser(tenantId, senderId, "meeting_message_error", {
          clientMsgId: safeClientMsgId,
          reason: "not-a-participant",
        });
      return;
    }

    // Fetch sender + meeting info (we need the meeting's conversation_id
    // to persist the message). Run in parallel for latency.
    //
    // BROADCAST AUDIENCE CHANGE: we no longer restrict to currently
    // `status='joined'` participants. The set of recipients now
    // includes everyone who has EVER joined this meeting — they may
    // be momentarily disconnected (within the 15s
    // MEETING_DISCONNECT_GRACE_MS window) and would otherwise miss
    // the message entirely. For users who are well and truly offline,
    // the message is already persisted and will reappear on their
    // next hydration via GET /:code/messages. `sendToUser` is a
    // no-op for users with no open WS connection so this is cheap.
    const [senderResult, meetingResult, participantsResult] = await Promise.all(
      [
        db.query("SELECT full_name FROM users WHERE id = $1", [senderId]),
        db.query("SELECT conversation_id FROM meetings WHERE id = $1", [
          meetingId,
        ]),
        db.query(
          `SELECT user_id FROM meeting_participants WHERE meeting_id = $1 AND status IN ('joined','invited')`,
          [meetingId],
        ),
      ],
    );
    const sender = senderResult.rows[0];
    const conversationId = meetingResult.rows[0]?.conversation_id || null;
    const participants = participantsResult.rows;

    // Persist to DB. Failure here is now a HARD error (we tell the
    // sender so the optimistic bubble can be marked _failed) — the
    // earlier "warn and continue" silently produced ephemeral
    // messages that vanished on the next rejoin.
    let persistedId: number | null = null;
    let persistedCreatedAt: string = new Date().toISOString();
    let persistError: any = null;
    if (conversationId) {
      try {
        // Encode file metadata in the messages.metadata JSONB column.
        // The content column stores the visible text — for file-only
        // messages we store the file name so legacy chat readers
        // still see something meaningful.
        const content =
          text && text.trim()
            ? text.trim()
            : file_name
              ? `📎 ${file_name}`
              : "";
        const metadata = {
          source: "meeting",
          meetingId,
          ...(file_url
            ? {
                file_url,
                file_name: file_name || "File",
                file_size: file_size || null,
              }
            : {}),
        };
        const inserted = await db.query(
          `INSERT INTO messages (conversation_id, sender_id, content, format_type, metadata, client_msg_id)
                     VALUES ($1, $2, $3, 'text', $4, $5)
                     ON CONFLICT (conversation_id, sender_id, client_msg_id)
                     WHERE client_msg_id IS NOT NULL
                     DO NOTHING
                     RETURNING id, created_at`,
          [
            conversationId,
            senderId,
            content,
            JSON.stringify(metadata),
            safeClientMsgId,
          ],
        );
        if (inserted.rows[0]) {
          persistedId = inserted.rows[0].id;
          persistedCreatedAt = inserted.rows[0].created_at;
          // Bump conversation updated_at so the meeting's chat row in
          // the user's main chat list also surfaces the activity.
          await db.query(
            "UPDATE conversations SET updated_at = NOW() WHERE id = $1",
            [conversationId],
          );
        } else if (safeClientMsgId) {
          // ON CONFLICT path: a previous attempt by this client
          // already inserted the row. Fetch its canonical id so
          // the echo carries the right primary key.
          const existing = (
            await db.query(
              `SELECT id, created_at FROM messages
                          WHERE conversation_id = $1 AND sender_id = $2 AND client_msg_id = $3
                          LIMIT 1`,
              [conversationId, senderId, safeClientMsgId],
            )
          ).rows[0];
          if (existing) {
            persistedId = existing.id;
            persistedCreatedAt = existing.created_at;
          }
        }
      } catch (err: any) {
        persistError = err;
        logger.warn(
          { err: err.message, meetingId, conversationId },
          "meeting_chat: persist failed",
        );
      }
    }

    if (persistError) {
      // Tell ONLY the sender so they can mark their optimistic bubble
      // as failed. Other participants don't need to know.
      if (safeClientMsgId) {
        sendToUser(tenantId, senderId, "meeting_message_error", {
          clientMsgId: safeClientMsgId,
          reason: "persist-failed",
        });
      }
      return;
    }

    // Send the ack to the sender FIRST. This is the signal the client's
    // pending-send queue waits on; it's decoupled from the broadcast so
    // even mid-reconnect senders get their queue drained.
    if (safeClientMsgId) {
      sendToUser(tenantId, senderId, "meeting_message_ack", {
        meetingId,
        clientMsgId: safeClientMsgId,
        id: persistedId,
        createdAt: persistedCreatedAt,
      });
    }

    const message: Record<string, unknown> = {
      id: persistedId,
      clientMsgId: safeClientMsgId, // round-trip the id on every echo
      sender_id: senderId,
      sender_name: sender?.full_name || "Participant",
      text: text ? text.trim() : null,
      created_at: persistedCreatedAt,
    };
    if (file_url) {
      message.file_url = file_url;
      message.file_name = file_name || "File";
      message.file_size = file_size || null;
    }

    for (const p of participants) {
      sendToUser(tenantId, p.user_id, "meeting_message", {
        meetingId,
        message,
      });
    }
  } else if (msg.type === "meeting_chat_replay") {
    // Reconnect-recovery: the client just opened (or reopened) its WS
    // and wants to backfill any meeting chat that arrived while it
    // was disconnected. We respond with one `meeting_message` per
    // missed row plus a `meeting_chat_replay_done` marker so the
    // client can clear any "Reconnecting…" indicator.
    //
    // Cap at 200 messages — anything older falls back to the existing
    // GET /api/meetings/:code/messages REST endpoint.
    const { meetingId, sinceMessageId } = msg.data || {};
    if (!meetingId) return;

    // Verify the requester is allowed to see this meeting's chat.
    const allowed = (
      await db.query(
        `SELECT 1 FROM meeting_participants
              WHERE meeting_id = $1 AND user_id = $2`,
        [meetingId, senderId],
      )
    ).rows[0];
    if (!allowed) return;

    const meetingRow = (
      await db.query("SELECT conversation_id FROM meetings WHERE id = $1", [
        meetingId,
      ])
    ).rows[0];
    if (!meetingRow?.conversation_id) {
      sendToUser(tenantId, senderId, "meeting_chat_replay_done", {
        meetingId,
        count: 0,
      });
      return;
    }

    const since =
      Number.isInteger(sinceMessageId) && sinceMessageId > 0
        ? sinceMessageId
        : 0;
    const rows = (
      await db.query(
        `SELECT m.id, m.sender_id, m.content, m.metadata, m.created_at, m.client_msg_id,
                    u.full_name AS sender_name
               FROM messages m
               JOIN users u ON u.id = m.sender_id
              WHERE m.conversation_id = $1
                AND m.id > $2
                AND (m.format_type != 'system' OR (m.metadata->>'type' IN ('meeting_joined','meeting_ended')))
              ORDER BY m.id ASC
              LIMIT 200`,
        [meetingRow.conversation_id, since],
      )
    ).rows;

    for (const r of rows) {
      const meta = r.metadata || {};
      const message = {
        id: r.id,
        clientMsgId: r.client_msg_id || null,
        sender_id: r.sender_id,
        sender_name: r.sender_name,
        text: meta.file_url ? null : r.content,
        created_at: r.created_at,
        ...(meta.file_url
          ? {
              file_url: meta.file_url,
              file_name: meta.file_name || null,
              file_size: meta.file_size || null,
            }
          : {}),
      };
      sendToUser(tenantId, senderId, "meeting_message", {
        meetingId,
        message,
        _replay: true,
      });
    }
    sendToUser(tenantId, senderId, "meeting_chat_replay_done", {
      meetingId,
      count: rows.length,
    });
  } else if (msg.type === "call_add_participant") {
    // Add a participant to an ongoing GROUP call.
    // We only allow this on existing group conversations so a 1:1 DM
    // can never be silently mutated into a group.
    const { callId, conversationId, targetUserId } = msg.data || {};
    if (!callId || !conversationId || !targetUserId) return;

    const callLog = (
      await db.query("SELECT * FROM call_logs WHERE id = $1 AND status = $2", [
        callId,
        "answered",
      ])
    ).rows[0];
    if (!callLog) return;

    // Verify sender is in the call conversation
    const senderOk = (
      await db.query(
        "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
        [conversationId, senderId],
      )
    ).rows[0];
    if (!senderOk) return;

    // Refuse to upgrade a 1:1 conversation into a group via this path.
    const conv = (
      await db.query("SELECT is_group FROM conversations WHERE id = $1", [
        conversationId,
      ])
    ).rows[0];
    if (!conv || !conv.is_group) {
      logger.warn(
        { senderId, callId, conversationId, targetUserId },
        "call_add_participant: rejected — conversation is not a group",
      );
      return;
    }

    // Add target to conversation (no-op if they were already a member)
    await db.query(
      `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [conversationId, targetUserId],
    );

    const caller = (
      await db.query("SELECT full_name, avatar FROM users WHERE id = $1", [
        senderId,
      ])
    ).rows[0];

    // Notify target as incoming call
    sendToUser(tenantId, targetUserId, "call_incoming", {
      callId,
      conversationId,
      callerId: senderId,
      callerName: caller?.full_name,
      callerAvatar: caller?.avatar,
      callType: callLog.call_type,
      isGroup: true,
      isJoining: true,
    });

    // Send push notification for group call participant addition
    pushNotifications
      .sendCallNotification(db.query as any, targetUserId, tenantId, {
        callId,
        conversationId,
        callerId: senderId,
        callerName: caller?.full_name || "Unknown",
        callerAvatar: caller?.avatar,
        callType: callLog.call_type as "voice" | "video",
        isGroup: true,
      })
      .catch((err: any) => {
        logger.warn(
          { err: err.message, userId: targetUserId, callId },
          "Failed to send group call push notification",
        );
      });
  }
}

/**
 * Deliver a message to a user's local WebSocket connections (this instance only).
 * When tenantId is provided, only delivers to connections belonging to that tenant.
 */
function deliverLocal(
  tenantId: number | null | undefined,
  userId: number,
  type: WSType,
  data: unknown,
): void {
  const ck = clientKey(tenantId, userId);
  const set = clients.get(ck);
  if (!set) {
    if (
      type === "call_signal" ||
      type === "call_accepted" ||
      type === "call_incoming" ||
      type === "meeting_signal" ||
      type === "meeting_participant_joined" ||
      type === "meeting_started"
    ) {
      logger.warn(
        { tenantId, userId, type, clientKey: ck, totalKeys: clients.size },
        "deliverLocal: no connections found for user",
      );
    }
    return;
  }
  const msg = JSON.stringify({ type, data });
  let delivered = 0;
  for (const ws of set) {
    if (ws.readyState === 1) {
      ws.send(msg);
      delivered++;
    }
  }
  if (
    delivered === 0 &&
    (type === "call_signal" ||
      type === "call_accepted" ||
      type === "call_incoming" ||
      type === "meeting_signal" ||
      type === "meeting_participant_joined" ||
      type === "meeting_started")
  ) {
    logger.warn(
      { tenantId, userId, type, clientKey: ck, connections: set.size },
      "deliverLocal: user has connections but none are open",
    );
  }
}

/**
 * Send a message to a specific user (all their open tabs/devices, across all instances).
 * tenantId ensures messages are only delivered to connections in the correct tenant.
 */
function sendToUser(
  tenantId: number | null | undefined,
  userId: number,
  type: WSType,
  data: unknown,
): void {
  // Always deliver locally first
  deliverLocal(tenantId, userId, type, data);
  // Publish to Redis for other instances (include tenantId for cross-instance filtering)
  redis.publish("ws:broadcast", {
    _from: INSTANCE_ID,
    tenantId,
    userId,
    type,
    data,
  });
}

/**
 * Broadcast to all connected clients of a specific tenant (local instance).
 * tenantId is required to prevent cross-tenant data leaks.
 */
function broadcast(
  tenantId: number | null | undefined,
  type: WSType,
  data: unknown,
): void {
  const msg = JSON.stringify({ type, data });
  for (const [key, set] of clients) {
    // Only deliver to connections belonging to the specified tenant
    const keyTenant = key.split(":")[0];
    if (String(tenantId || 0) !== keyTenant) continue;
    for (const ws of set) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }
}

/**
 * Create a notification in the DB and push it to the user via WebSocket.
 * Drop-in wrapper: call this instead of raw INSERT INTO notifications.
 */
async function notifyUser(
  db: DbLike,
  tenantId: number | null | undefined,
  userId: number,
  type: string,
  title: string,
  body: string,
  linkTaskId?: number | null,
  // Optional id of the user who TRIGGERED this notification (the "actor" — e.g.
  // the task assigner, the leave approver). When supplied we look up their
  // avatar/name and forward it to the push so the mobile client can render the
  // actor's circular avatar as the notification largeIcon (chat-avatar parity);
  // otherwise the client falls back to the org branding logo. The app-logo
  // silhouette is always the status-bar smallIcon.
  actorId?: number | null,
): Promise<void> {
  try {
    const sql = linkTaskId
      ? "INSERT INTO notifications (user_id, type, title, body, link_task_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at"
      : "INSERT INTO notifications (user_id, type, title, body) VALUES ($1, $2, $3, $4) RETURNING id, created_at";
    const params = linkTaskId
      ? [userId, type, title, body, linkTaskId]
      : [userId, type, title, body];
    const row = (await db.query(sql, params)).rows[0];
    if (row) {
      sendToUser(tenantId, userId, "notification", {
        id: row.id,
        type,
        title,
        body,
        link_task_id: linkTaskId || null,
        created_at: row.created_at,
        is_read: false,
      });

      // Best-effort: resolve the actor's avatar/name so the push can show their
      // circular avatar as the notification largeIcon. A missing actor (or a
      // failed lookup) simply leaves the fields empty and the client falls back
      // to the org branding logo.
      let actorAvatar = "";
      let actorName = "";
      if (actorId) {
        try {
          const actor = (
            await db.query("SELECT full_name, avatar FROM users WHERE id = $1", [
              actorId,
            ])
          ).rows[0];
          actorAvatar = actor?.avatar || "";
          actorName = actor?.full_name || "";
        } catch {
          /* best-effort — leave actor fields empty */
        }
      }

      // Send push notification for important alerts
      pushNotifications
        .sendNotificationAlert(db.query as any, userId, tenantId || null, {
          notificationId: row.id,
          title,
          body,
          type,
          actorAvatar,
          actorName,
        })
        .catch((err: any) => {
          logger.warn(
            { err: err.message, userId },
            "Failed to send push notification alert",
          );
        });
    }
  } catch {
    /* ignore — notification delivery is best-effort */
  }
}

export {
  setupWebSocket,
  sendToUser,
  broadcast,
  notifyUser,
  handleChatMessage,
  isConversationMember,
  isMeetingMember,
  emitCallHistoryMessage,
};
