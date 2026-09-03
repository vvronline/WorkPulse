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
import { logger } from "./logger";
import { chatMessage } from "./wsHandlers/chatMessage";
import { handleChatTyping, handleChatRead } from "./wsHandlers/chat";
import { handleHuddleDecline } from "./wsHandlers/huddles";
import {
  handleCallInitiate,
  handleCallAccept,
  handleCallCancel,
  handleCallReject,
  handleCallEnd,
  handleCallSignal,
  handleCallSubscribe,
  handleCallReady,
  handleCallReconnect,
  handleCallReaction,
  handleCallAddParticipant,
} from "./wsHandlers/call";
import {
  handleMeetingJoin,
  handleMeetingLeave,
  handleMeetingEnd,
  handleMeetingSignal,
  handleMeetingSubscribe,
  handleMeetingReady,
  handleMeetingAddParticipant,
  handleMeetingMuteParticipant,
  handleMeetingRaiseHand,
  handleMeetingTrackState,
  handleMeetingRequestQuality,
  handleMeetingAudioLevel,
  handleMeetingScreenTrackId,
  handleMeetingChat,
  handleMeetingChatReplay,
} from "./wsHandlers/meeting";
import {
  DbLike,
  ExtWS,
  WSType,
  clients,
  clientKey,
  isConversationMember,
  isMeetingMember,
  emitCallHistoryMessage as sharedEmitCallHistoryMessage,
  scheduleMeetingDisconnectCleanup,
  notifyUser as sharedNotifyUser,
} from "./wsHandlers/shared";
const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");
const cookie = require("cookie");
const { masterQuery } = require("../db");
const { getTenantPool, getTenantById } = require("./tenantManager");
const redis = require("../redis");
const statusService = require("../services/status");
const wsMetrics = require("./wsMetrics");
import { pushNotifications } from "../services/pushNotifications";

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

/** Max WebSocket connections a single user may hold per server instance.
 *  Each browser tab uses ~4 WS connections (chat, calls, status, notifications)
 *  so allow enough for 2-3 tabs or a browser + desktop app. */
const MAX_CONNECTIONS_PER_USER = 12;

/** Unique instance ID for Pub/Sub dedup */
const INSTANCE_ID = `ws-${process.pid}-${Date.now()}`;

/**
 * Wraps shared.emitCallHistoryMessage with `sendToUser` pre-bound, matching
 * the public signature this module has always exported.
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
  return sharedEmitCallHistoryMessage(
    db,
    tenantId,
    conversationId,
    callerId,
    callType,
    status,
    duration,
    sendToUser,
  );
}

async function setupWebSocket(server: HTTPServer): Promise<any> {
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

      // REBRAND (WorkPulse -> AINO): accept both desktop protocol origins so
      // installed builds keep their realtime socket while new builds use aino://.
      if (origin.startsWith("workpulse://") || origin.startsWith("aino://"))
        return done(true);

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
    // bootstrap() has awaited Redis readiness. Await subscription too so the
    // realtime role never reports ready while cross-instance fan-out is dark.
    await sub.subscribe("ws:broadcast");
    logger.info("Redis subscribed to ws:broadcast");
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

    ws.on("close", async () => {
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
        try {
          await scheduleMeetingDisconnectCleanup({
            db,
            tenantId,
            userId,
            meetingId: mid,
            sendToUser,
          });
        } catch (err: any) {
          // In production Redis loss is already process-fatal. Log this frame
          // explicitly so the meeting state risk is visible before restart.
          logger.error(
            { err: err.message, tenantId, userId, meetingId: mid },
            "Failed to schedule distributed meeting disconnect cleanup",
          );
        }
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

/** Handle incoming WS messages for chat, calls, and meetings.
 *
 * This is now a thin dispatcher: business logic for each `msg.type` lives in
 * ./wsHandlers/{chatMessage,chat,huddles,call,meeting}.ts. Every handler is
 * invoked with the same dependency-injection shape (db, senderId, tenantId,
 * msg/data, ws, sendToUser) so none of them import this module — avoiding a
 * ws.ts <-> wsHandlers/* circular import.
 */
async function handleChatMessage(
  db: DbLike,
  senderId: number,
  tenantId: number | null,
  msg: any,
  ws: ExtWS,
): Promise<void> {
  const args = { db, senderId, tenantId, msg, ws, sendToUser };
  const dataArgs = { db, senderId, tenantId, data: msg.data, ws, sendToUser };

  switch (msg.type) {
    case "chat_message":
      // Phase 6 part 2 (ADR-009): delegated to the extracted handler.
      await chatMessage(dataArgs);
      return;
    case "chat_typing":
      await handleChatTyping(dataArgs);
      return;
    case "chat_read":
      await handleChatRead(dataArgs);
      return;
    case "call_initiate":
      // Group conversations use the meeting mesh flow for n-way reliability;
      // direct call_initiate is p2p and cannot connect all participants.
      // Guard now lives in ./wsHandlers/call.ts (handleCallInitiate), but
      // it still runs 'SELECT is_group FROM conversations WHERE id = $1',
      // logs "call_initiate: group conversation blocked; use meeting flow",
      // and replies with reason: "group_unsupported".
      await handleCallInitiate(args);
      return;
    case "call_accept":
      await handleCallAccept(args);
      return;
    case "call_cancel":
      await handleCallCancel(args);
      return;
    case "call_reject":
      await handleCallReject(args);
      return;
    case "call_end":
      await handleCallEnd(args);
      return;
    case "call_signal":
      await handleCallSignal(args);
      return;
    case "call_subscribe":
      await handleCallSubscribe(args);
      return;
    case "call_ready":
      await handleCallReady(args);
      return;
    case "call_reconnect":
      await handleCallReconnect(args);
      return;
    case "call_reaction":
      await handleCallReaction(args);
      return;
    case "meeting_join":
      await handleMeetingJoin(args);
      return;
    case "meeting_leave":
      await handleMeetingLeave(args);
      return;
    case "meeting_end":
      await handleMeetingEnd(args);
      return;
    case "meeting_signal":
      await handleMeetingSignal(args);
      return;
    case "meeting_subscribe":
      await handleMeetingSubscribe(args);
      return;
    case "meeting_ready":
      await handleMeetingReady(args);
      return;
    case "huddle_decline":
      await handleHuddleDecline(
        { db, tenantId, senderId, sendToUser },
        msg.data,
      );
      return;
    case "meeting_add_participant":
      await handleMeetingAddParticipant(args);
      return;
    case "meeting_mute_participant":
      await handleMeetingMuteParticipant(args);
      return;
    case "meeting_raise_hand":
      await handleMeetingRaiseHand(args);
      return;
    case "meeting_track_state":
      await handleMeetingTrackState(args);
      return;
    case "meeting_request_quality":
      await handleMeetingRequestQuality(args);
      return;
    case "meeting_audio_level":
      await handleMeetingAudioLevel(args);
      return;
    case "meeting_screen_track_id":
      await handleMeetingScreenTrackId(args);
      return;
    case "meeting_chat":
      await handleMeetingChat(args);
      return;
    case "meeting_chat_replay":
      await handleMeetingChatReplay(args);
      return;
    case "call_add_participant":
      await handleCallAddParticipant(args);
      return;
    default:
      return;
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
