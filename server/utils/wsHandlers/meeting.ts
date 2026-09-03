/**
 * GROUP MEETING WebSocket handlers, extracted from ws.ts as part of the
 * calls/meetings-module separation. Handles: meeting_join, meeting_leave,
 * meeting_end, meeting_signal, meeting_subscribe, meeting_ready,
 * meeting_add_participant, meeting_mute_participant, meeting_raise_hand,
 * meeting_track_state, meeting_request_quality, meeting_audio_level,
 * meeting_screen_track_id, meeting_chat, meeting_chat_replay.
 *
 * Dependencies are injected (same pattern as wsHandlers/call.ts and
 * wsHandlers/huddles.ts) so this module never imports ws.ts. Logic is moved
 * verbatim from the original `handleChatMessage` dispatcher — pure
 * structural refactor, no behaviour changes.
 */
import { logger } from "../logger";
import { pushNotifications } from "../../services/pushNotifications";
import { withIdempotency } from "../wsIdempotency";
import * as signalStore from "../../realtime/signalStore";
const statusService = require("../../services/status");
import {
  DbLike,
  ExtWS,
  SendToUser,
  isMeetingMember,
  replayMeetingSignals,
  hasOpenSocket,
  cancelMeetingDisconnectCleanup,
} from "./shared";

export interface MeetingHandlerArgs {
  db: DbLike;
  senderId: number;
  tenantId: number | null;
  msg: any;
  ws: ExtWS;
  sendToUser: SendToUser;
}

export async function handleMeetingJoin({
  db,
  senderId,
  tenantId,
  msg,
  ws,
  sendToUser,
}: MeetingHandlerArgs): Promise<void> {
  const { meetingId } = msg.data || {};
  if (!meetingId) return;

  // First thing: cancel any pending disconnect-cleanup. Happy path for
  // a transient WS drop — the user reconnected within the grace window,
  // so we silently keep them in the meeting (no `meeting_participant_left`
  // was ever broadcast and the other participants' RTCPeerConnections
  // are untouched).
  const cancelledPending = await cancelMeetingDisconnectCleanup({
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

  // HUDDLE ANSWERED-ELSEWHERE (Signal/WhatsApp parity): joining a group CALL
  // is the "answer". Dismiss the ring on the answerer's OTHER devices (WS
  // frame for live sockets + push-cancel for backgrounded/killed twins) so a
  // user who answers on their phone doesn't keep ringing on their desktop.
  // Best-effort; never blocks the join.
  if (meeting.is_huddle) {
    try {
      sendToUser(tenantId, senderId, "call_handled_elsewhere", {
        callId: meeting.id,
        conversationId: meeting.conversation_id,
        action: "accepted",
      });
      pushNotifications
        .sendCallCancellation(db.query as any, senderId, tenantId, {
          callId: meeting.id,
          conversationId: meeting.conversation_id,
          reason: "answered_elsewhere",
        })
        .catch((err: any) =>
          logger.warn(
            { err: err?.message, userId: senderId, meetingId },
            "huddle answered-elsewhere push-cancel failed",
          ),
        );
    } catch (err: any) {
      logger.warn(
        { err: err?.message, meetingId },
        "huddle answered-elsewhere ring-cancel failed",
      );
    }
  }

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
  await replayMeetingSignals(tenantId, Number(meetingId), senderId, (fromUserId, signal) => {
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
}

export async function handleMeetingLeave({
  db,
  senderId,
  tenantId,
  msg,
  ws,
  sendToUser,
}: MeetingHandlerArgs): Promise<void> {
  const { meetingId } = msg.data || {};
  if (!meetingId) return;

  // Clear the tag so disconnect handler doesn't double-leave
  ws._activeMeetingId = null;
  // An explicit leave overrides any scheduled grace-window cleanup
  // — we do the cleanup synchronously below instead.
  await cancelMeetingDisconnectCleanup({ tenantId, userId: senderId, meetingId });

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
  await signalStore.clearMeetingUserSignals(tenantId, meetingId, senderId);

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
    await signalStore.clearMeetingSignals(tenantId, meetingId);
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
}

export async function handleMeetingEnd({
  db,
  senderId,
  tenantId,
  msg,
  ws,
  sendToUser,
}: MeetingHandlerArgs): Promise<void> {
  const { meetingId } = msg.data || {};
  if (!meetingId) return;

  ws._activeMeetingId = null;
  await cancelMeetingDisconnectCleanup({ tenantId, userId: senderId, meetingId });

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
  await signalStore.clearMeetingSignals(tenantId, meetingId);

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
}

export async function handleMeetingSignal({
  db,
  senderId,
  tenantId,
  msg,
  sendToUser,
}: MeetingHandlerArgs): Promise<void> {
  // WebRTC mesh signaling between meeting participants
  const { meetingId, targetUserId, signal } = msg.data || {};
  if (!meetingId || !targetUserId || !signal) return;

  // Verify BOTH sender and target are participants of the meeting for
  // EVERY signal type. Previously only offer/answer checked the sender
  // (never the target) and ICE skipped all checks, letting any tenant
  // user inject mesh signaling to an arbitrary userId. Cached for ICE bursts.
  const senderOk = await isMeetingMember(db, tenantId, meetingId, senderId);
  const targetOk = await isMeetingMember(db, tenantId, meetingId, targetUserId);
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
    await signalStore.bufferMeetingSignal(tenantId, Number(meetingId), senderId, Number(targetUserId), signal);
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
}

export async function handleMeetingSubscribe({
  db,
  senderId,
  tenantId,
  msg,
  sendToUser,
}: MeetingHandlerArgs): Promise<void> {
  // GROUP-CALL reliable-delivery handshake (mesh parity with `call_subscribe`).
  // A (re)joining peer sends this once its WS handler is attached + it is
  // ready to receive offers. We (1) replay any OFFER/ICE buffered for them
  // while they were offline, and (2) tell every OTHER joined peer to
  // (re)offer toward this user via `meeting_peer_ready` (idempotent under
  // Perfect Negotiation). This closes the race where a peer's offer was
  // emitted before the newcomer's handler was listening.
  const { meetingId } = msg.data || {};
  if (!meetingId) return;
  if (!(await isMeetingMember(db, tenantId, meetingId, senderId))) return;
  await replayMeetingSignals(tenantId, Number(meetingId), senderId, (fromUserId, signal) => {
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
}

export async function handleMeetingReady({
  db,
  senderId,
  tenantId,
  msg,
  sendToUser,
}: MeetingHandlerArgs): Promise<void> {
  // GROUP-CALL: the peer's RTCPeerConnection set is built and it is ready to
  // (re)negotiate. Same effect as `meeting_subscribe` — replay buffered
  // signals to this user and ask the other peers to (re)offer. Kept as a
  // distinct verb so the client can signal "media acquired + PCs created"
  // separately from "WS subscribed" (mirrors call_ready vs call_subscribe).
  const { meetingId } = msg.data || {};
  if (!meetingId) return;
  if (!(await isMeetingMember(db, tenantId, meetingId, senderId))) return;
  await replayMeetingSignals(tenantId, Number(meetingId), senderId, (fromUserId, signal) => {
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
}

export async function handleMeetingAddParticipant({
  db,
  senderId,
  tenantId,
  msg,
  sendToUser,
}: MeetingHandlerArgs): Promise<void> {
  // Add someone to an active meeting / group CALL (huddle).
  // Meetings: gated by the permission preset (default: host only).
  // Huddles: ANY joined member may pull in another tenant user
  // (Signal/Slack "add to call" parity — a group call has no "host").
  const { meetingId, targetUserId } = msg.data || {};
  if (!meetingId || !targetUserId) return;

  const meeting = (
    await db.query("SELECT * FROM meetings WHERE id = $1", [meetingId])
  ).rows[0];
  if (!meeting || meeting.status === "ended") return;

  if (meeting.is_huddle) {
    // Any *joined* member of the live call can add people.
    const joinedOk = (
      await db.query(
        `SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2 AND status = 'joined'`,
        [meetingId, senderId],
      )
    ).rows[0];
    if (!joinedOk) return;
  } else {
    const meetingPerms = require("../meetingPermissions");
    if (
      !meetingPerms.can(
        { userId: senderId },
        meeting,
        meetingPerms.ACTIONS.ADD_PARTICIPANT,
      )
    )
      return;
  }

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
}

export async function handleMeetingMuteParticipant({
  db,
  senderId,
  tenantId,
  msg,
  sendToUser,
}: MeetingHandlerArgs): Promise<void> {
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
      const meetingPerms = require("../meetingPermissions");
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
}

export async function handleMeetingRaiseHand({
  db,
  senderId,
  tenantId,
  msg,
  sendToUser,
}: MeetingHandlerArgs): Promise<void> {
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
}

export async function handleMeetingTrackState({
  db,
  senderId,
  tenantId,
  msg,
  sendToUser,
}: MeetingHandlerArgs): Promise<void> {
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
}

export async function handleMeetingRequestQuality({
  db,
  senderId,
  tenantId,
  msg,
  sendToUser,
}: MeetingHandlerArgs): Promise<void> {
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
  if (!(await isMeetingMember(db, tenantId, meetingId, senderId))) return;
  if (!(await isMeetingMember(db, tenantId, meetingId, targetUserId))) return;
  sendToUser(tenantId, targetUserId, "meeting_request_quality", {
    meetingId,
    fromUserId: senderId,
    level,
  });
}

export async function handleMeetingAudioLevel({
  db,
  senderId,
  tenantId,
  msg,
  sendToUser,
}: MeetingHandlerArgs): Promise<void> {
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
}

export async function handleMeetingScreenTrackId({
  db,
  senderId,
  tenantId,
  msg,
  sendToUser,
}: MeetingHandlerArgs): Promise<void> {
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
  if (!(await isMeetingMember(db, tenantId, meetingId, senderId))) return;
  if (!(await isMeetingMember(db, tenantId, meetingId, targetUserId))) return;
  sendToUser(tenantId, targetUserId, "meeting_screen_track_id", {
    meetingId,
    fromUserId: senderId,
    sharing: !!sharing,
    trackId: trackId || null,
  });
}

export async function handleMeetingChat({
  db,
  senderId,
  tenantId,
  msg,
  sendToUser,
}: MeetingHandlerArgs): Promise<void> {
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
}

export async function handleMeetingChatReplay({
  db,
  senderId,
  tenantId,
  msg,
  sendToUser,
}: MeetingHandlerArgs): Promise<void> {
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
}
