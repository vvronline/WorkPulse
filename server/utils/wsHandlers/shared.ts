/**
 * Shared WS server state + helpers, extracted from ws.ts as part of the
 * calls/meetings-module separation (Phase 6 continuation). This module owns
 * the singleton connection registry (`clients`) and the pending
 * meeting-disconnect-cleanup timers (`pendingMeetingLeaves`) so ws.ts and the
 * wsHandlers/* modules share exactly one copy of each — duplicating either
 * Map would silently break connection tracking / meeting grace windows.
 *
 * Functions here take their dependencies (db, tenantId, sendToUser, etc.) as
 * parameters rather than importing ws.ts, which would create a circular
 * import (ws.ts -> wsHandlers/call.ts -> ws.ts).
 */
import { createHash } from "crypto";
import { logger } from "../logger";
import * as signalStore from "../../realtime/signalStore";
import * as membershipCache from "../../realtime/membershipCache";
import * as meetingLeaveStore from "../../realtime/meetingLeaveStore";
const statusService = require("../../services/status");
const wsMetrics = require("../wsMetrics");

export type Query = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: any[]; rowCount?: number | null }>;

export interface DbLike {
  query: Query;
  transaction?: (fn: (client: unknown) => Promise<unknown>) => Promise<unknown>;
}

/**
 * Extended WebSocket — the `ws` library's socket plus the bag of
 * per-connection state stashed directly on the instance.
 */
export interface ExtWS {
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

export type WSType = string;

export type SendToUser = (
  tenantId: number | null | undefined,
  userId: number,
  type: WSType,
  data: unknown,
) => void;

/** Map<clientKey, Set<WebSocket>> — local instance connections, keyed by tenantId:userId */
export const clients = new Map<string, Set<ExtWS>>();

interface PendingMeetingLeave {
  timer: NodeJS.Timeout;
  db: DbLike;
}

/**
 * Pending meeting-leave timers — see ws.ts's `setupWebSocket` close handler
 * for the full rationale (grace window before a disconnected user is
 * actually removed from a meeting). Keyed by `${tenantId}:${userId}:${meetingId}`.
 */
export const pendingMeetingLeaves = new Map<string, PendingMeetingLeave>();
const MEETING_DISCONNECT_GRACE_MS = 15_000;

const meetingLeaveKey = (
  tenantId: number | null | undefined,
  userId: number,
  meetingId: number,
): string => `${tenantId || 0}:${userId}:${meetingId}`;

/** Composite key for the clients Map to prevent cross-tenant collisions */
export function clientKey(
  tenantId: number | null | undefined,
  userId: number,
): string {
  return `${tenantId || 0}:${userId}`;
}

/** True if the user has at least one OPEN (readyState===1) local socket. */
export function hasOpenSocket(
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

export function recordCallTransitionFailure(data: Record<string, unknown>): void {
  if (typeof wsMetrics?.recordCallTransitionFailure === "function") {
    wsMetrics.recordCallTransitionFailure(data);
  }
}

export function identifyCallSignal(
  tenantId: number | null | undefined,
  callId: number,
  conversationId: number,
  senderId: number,
  targetUserId: number,
  signal: any,
): any {
  if (!["offer", "answer", "ice-candidate"].includes(signal?.type)) return signal;
  const body =
    signal.type === "ice-candidate"
      ? JSON.stringify(signal.candidate ?? null)
      : String(signal.sdp || "");
  const signalId = createHash("sha256")
    .update(
      [
        tenantId || 0,
        callId || 0,
        conversationId,
        senderId,
        targetUserId,
        signal.type,
        body,
      ].join("\u001f"),
    )
    .digest("base64url")
    .slice(0, 32);
  return { ...signal, signalId };
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
export async function _checkMembership(
  db: DbLike,
  tenantId: number | null | undefined,
  kind: "conversation" | "meeting",
  roomId: number,
  userId: number,
  sql: string,
  params: unknown[],
): Promise<boolean> {
  const cached = await membershipCache.getMembership(tenantId, kind, roomId, userId);
  if (cached !== null) return cached;
  let ok = false;
  try {
    ok = !!(await db.query(sql, params)).rows[0];
  } catch (err: any) {
    logger.warn({ err: err.message, tenantId, kind, roomId, userId }, "ws membership check failed");
    return false; // fail closed — don't relay if we can't verify
  }
  await membershipCache.setMembership(tenantId, kind, roomId, userId, ok);
  return ok;
}

/** Is `userId` a participant of the given conversation? (cached) */
export async function isConversationMember(
  db: DbLike,
  tenantId: number | null | undefined,
  conversationId: number,
  userId: number,
): Promise<boolean> {
  if (!conversationId || !userId) return false;
  return _checkMembership(
    db,
    tenantId,
    "conversation",
    conversationId,
    userId,
    "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
    [conversationId, userId],
  );
}

/** Is `userId` a participant (joined or invited) of the given meeting? (cached) */
export async function isMeetingMember(
  db: DbLike,
  tenantId: number | null | undefined,
  meetingId: number,
  userId: number,
): Promise<boolean> {
  if (!meetingId || !userId) return false;
  return _checkMembership(
    db,
    tenantId,
    "meeting",
    meetingId,
    userId,
    `SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2 AND status IN ('joined','invited')`,
    [meetingId, userId],
  );
}

// Durable WebRTC reliable-delivery state is owned by Redis.
export async function replayCallSignals(
  tenantId: number | null | undefined,
  callId: number,
  targetUserId: number,
  deliver: (fromUserId: number, signal: any) => void,
): Promise<void> {
  const entries = await signalStore.drainCallSignals(tenantId, callId, targetUserId);
  for (const entry of entries) deliver(entry.fromUserId, entry.signal);
}

export async function replayMeetingSignals(
  tenantId: number | null | undefined,
  meetingId: number,
  targetUserId: number,
  deliver: (fromUserId: number, signal: any) => void,
): Promise<void> {
  const entries = await signalStore.drainMeetingSignals(tenantId, meetingId, targetUserId);
  for (const entry of entries) deliver(entry.fromUserId, entry.signal);
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
export async function emitCallHistoryMessage(
  db: DbLike,
  tenantId: number | null | undefined,
  conversationId: number,
  callerId: number,
  callType: string,
  status: "ended" | "missed" | "declined",
  duration: number | null,
  sendToUser: SendToUser,
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

interface MeetingCleanupArgs {
  db: DbLike;
  tenantId: number | null | undefined;
  userId: number;
  meetingId: number;
  sendToUser: SendToUser;
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
export async function scheduleMeetingDisconnectCleanup({
  db,
  tenantId,
  userId,
  meetingId,
  sendToUser,
}: MeetingCleanupArgs): Promise<void> {
  const key = meetingLeaveKey(tenantId, userId, meetingId);
  // If there's already a pending timer (rare — happens if the user opens
  // and closes a second WS very quickly), replace it with a fresh one.
  const existing = pendingMeetingLeaves.get(key);
  if (existing?.timer) clearTimeout(existing.timer);

  // Create a distributed cancellation lease before scheduling the local timer.
  // A rejoin on ANY replica deletes it; this replica claims it at expiry.
  const leaseToken = await meetingLeaveStore.createMeetingLeaveLease(tenantId, userId, meetingId);
  const timer = setTimeout(async () => {
    pendingMeetingLeaves.delete(key);
    try {
      const claimed = await meetingLeaveStore.claimMeetingLeaveLease(
        tenantId, userId, meetingId, leaseToken,
      );
      if (!claimed) return; // rejoined/cancelled on this or another replica
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
      await signalStore.clearMeetingUserSignals(tenantId, meetingId, userId);

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
        await signalStore.clearMeetingSignals(tenantId, meetingId);
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
export async function cancelMeetingDisconnectCleanup({
  tenantId,
  userId,
  meetingId,
}: {
  tenantId: number | null | undefined;
  userId: number;
  meetingId: number;
}): Promise<boolean> {
  const key = meetingLeaveKey(tenantId, userId, meetingId);
  const existing = pendingMeetingLeaves.get(key);
  if (existing?.timer) {
    clearTimeout(existing.timer);
    pendingMeetingLeaves.delete(key);
    await meetingLeaveStore.cancelMeetingLeaveLease(tenantId, userId, meetingId);
    return true;
  }
  // No local timer may mean the disconnect happened on another replica.
  return meetingLeaveStore.cancelMeetingLeaveLease(tenantId, userId, meetingId);
}

/**
 * Create a notification in the DB and push it to the user via WebSocket.
 * Drop-in wrapper: call this instead of raw INSERT INTO notifications.
 */
export async function notifyUser(
  db: DbLike,
  tenantId: number | null | undefined,
  userId: number,
  type: string,
  title: string,
  body: string,
  linkTaskId: number | null | undefined,
  actorId: number | null | undefined,
  sendToUser: SendToUser,
): Promise<void> {
  const { pushNotifications } = require("../../services/pushNotifications");
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
