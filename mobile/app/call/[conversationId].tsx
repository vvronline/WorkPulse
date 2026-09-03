import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Modal,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  Vibration,
  View,
} from "react-native";
import {
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
} from "expo-audio";
import { useKeepAwake } from "expo-keep-awake";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  mediaDevices,
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  MediaStream,
  type MediaStreamTrack,
} from "react-native-webrtc";
import { useTheme } from "../../src/theme/ThemeProvider";
import { socket } from "../../src/realtime/socket";
import { endCallNavigation } from "../../src/realtime/callRouting";
import {
  getIceConfig,
  getCachedIceConfig,
  getNotificationPrefs,
  acceptCallHttp,
  rejectCallHttp,
  endCallHttp,
  searchChatUsers,
  getMessages,
} from "../../src/features";
import { SERVER_ORIGIN } from "../../src/config";
import { getNotificationPreviewDataUri } from "../../src/utils/notificationSoundPreview";
import {
  DEFAULT_NOTIFICATION_PREFS,
  mergeNotificationPrefs,
} from "../../src/utils/notificationPrefs";
import { setShowWhenLocked } from "../../modules/lock-screen";
import {
  startActiveCall,
  stopActiveCall,
  getPendingCallAction,
  clearPendingCallAction,
} from "../../modules/call-ringer";
import {
  isPipSupported,
  setCallActive as setPipCallActive,
  setAutoEnter as setPipAutoEnter,
  addPipModeListener,
} from "../../modules/pip";
import { notifeeService } from "../../src/services/notifeeService";
import { persistCallPrefs } from "../../src/services/callPrefsStore";
import {
  subscribeAnswerIntent,
  consumeAnswerIntent,
  clearAnswerIntent,
} from "../../src/realtime/callAnswerIntent";
import {
  callStateReducer,
  initialCallPhase,
} from "../../src/realtime/callStateMachine";
import { makeStyles } from "./[conversationId].styles";
import CallScreenOverlay from "../../src/components/call/CallScreenOverlay";
import { CallDuration } from "../../src/components/call/CallVideoPrimitives";
import CallMediaStage from "../../src/components/call/CallMediaStage";
import {
  applyPublicTurnPolicy,
  FALLBACK_ICE,
  hasRealTurn,
} from "../../src/realtime/callIceConfig";
import { useMobileCallControls } from "../../src/components/call/useMobileCallControls";
import { useAuth } from "../../src/auth/AuthContext";
import {
  forgetInboundSignal,
  rememberInboundSignal,
} from "../../src/calls/p2p/callSignalDeduplicator";
import {
  applyAudioEncodingCap,
  applyVideoEncodingTier,
  collectStatsSample,
  createQualityController,
  preferOpusFec,
  RAMP_START_TIER_INDEX,
  startBitrateRampUp,
  type PeerConnectionLike,
  type QualityController,
} from "../../src/calls/shared/callQuality";
import {
  errorMessage,
  type CallMessage,
  type CallQuality,
  type CallSignal,
  type FloatingReaction,
  type IceCandidateLike,
  type SessionDescriptionLike,
} from "../../src/calls/shared/callUiTypes";
import type { IceServer } from "../../src/calls/shared/callIceConfig";

/**
 * `getUserMedia` constraint profile. react-native-webrtc's own `Constraints`
 * type is not exported from the package root, and it accepts a wider shape
 * than the DOM's (`audio` may be a plain boolean OR a processing-flags object),
 * so the profiles below are described locally and cast once at the call site.
 */
type MediaConstraintProfile = {
  audio: boolean | Record<string, boolean>;
  video:
    | boolean
    | {
        facingMode?: string;
        width?: { ideal?: number; max?: number };
        height?: { ideal?: number; max?: number };
        frameRate?: { ideal?: number; max?: number };
      };
};

/**
 * The `on*` event-handler properties of an `RTCPeerConnection`.
 *
 * react-native-webrtc installs these at runtime via event-target-shim's
 * `defineEventAttribute` (see its RTCPeerConnection.js), but its bundled
 * `.d.ts` declares neither the attributes nor `addEventListener` on the class,
 * so TypeScript can't see either. Assigning through this narrow view keeps the
 * handler parameters typed instead of falling back to `any` per handler.
 */
interface PeerConnectionHandlers {
  onicecandidate:
    | ((event: { candidate: RTCIceCandidate | null }) => void)
    | null;
  ontrack:
    | ((event: {
        streams?: MediaStream[];
        track?: MediaStreamTrack | null;
      }) => void)
    | null;
  oniceconnectionstatechange: (() => void) | null;
  onconnectionstatechange: (() => void) | null;
}

/** Attach the `on*` handlers to a peer connection without widening to `any`. */
function pcHandlers(pc: RTCPeerConnection): PeerConnectionHandlers {
  return pc as unknown as PeerConnectionHandlers;
}

/**
 * Apply the local description with Opus in-band FEC enabled, and return the
 * MUNGED descriptor so the caller signals exactly the SDP the peer connection
 * is using.
 *
 * Without `useinbandfec=1` every lost audio packet is an audible gap — the
 * most-noticed form of "jitter" on a call, and the one users describe as the
 * audio "cutting out". FEC lets the decoder reconstruct a lost packet from
 * redundancy carried in the next one for a few kbps. `usedtx=0` additionally
 * stops the encoder from going silent during pauses, which some decoders
 * render as a click/dropout when speech resumes.
 */
async function setLocalDescriptionWithFec(
  pc: RTCPeerConnection,
  desc: SessionDescriptionLike,
): Promise<SessionDescriptionLike> {
  const munged: SessionDescriptionLike =
    desc && desc.sdp ? { type: desc.type, sdp: preferOpusFec(desc.sdp) } : desc;
  await pc.setLocalDescription(munged as RTCSessionDescription);
  return munged;
}

/**
 * Native audio/video call screen (react-native-webrtc). Mirrors the web call
 * flow & WebRTC signaling protocol exactly:
 *   caller: call_initiate → call_started(callId) → call_accepted(peer) → offer
 *   callee: call_incoming → call_accept → wait for offer → answer
 *   both:   call_signal {offer|answer|ice-candidate|video-state} ; call_end / call_ended
 *
 * Route params:
 *   conversationId  (required)
 *   mode            "outgoing" | "incoming"
 *   callType        "voice" | "video"
 *   callId          (incoming only — provided by call_incoming)
 *   peerId          (incoming only — the caller's user id)
 *   peerName        display name
 */
export default function CallScreen() {
  // Keep the screen awake for the entire lifetime of the call UI. Without this
  // Android dims/sleeps the display after the system inactivity timeout when the
  // user is not touching the screen (e.g. just watching a video call), which on
  // tablets like the OnePlus Pad turns the call screen off mid-call. This sets
  // FLAG_KEEP_SCREEN_ON while mounted and releases it automatically on unmount.
  useKeepAwake();

  const theme = useTheme();
  const { user } = useAuth();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    conversationId: string;
    mode?: string;
    callType?: string;
    callId?: string;
    peerId?: string;
    peerName?: string;
    peerAvatar?: string;
    isGroup?: string;
    autoAnswer?: string;
    action?: string;
  }>();
  const router = useRouter();

  const conversationId = Number(params.conversationId);
  // Reconnect mode: the user is REJOINING a still-active call they navigated
  // away from (back-press, app killed/reopened). Mirrors the web client's
  // refresh-rejoin (useCallState `isReconnect`): we skip the ringing/initiate
  // flow, acquire media, announce `call_reconnect` to the server, and wait for
  // the peer to send a fresh offer. We treat reconnect as an "outgoing"-shaped
  // session for the non-incoming UI, but it is neither a fresh outgoing call
  // nor an incoming ring.
  const isReconnect = params.mode === "reconnect";
  const mode = params.mode === "incoming" ? "incoming" : "outgoing";
  const callType = params.callType === "video" ? "video" : "voice";
  const isGroupCall = params.isGroup === "1";
  const autoAnswer = params.autoAnswer === "1";
  // Deep-linked decline (e.g. user tapped "Decline" on the full-screen call
  // notification while the app was backgrounded/terminated). When present we
  // auto-reject the incoming call instead of presenting the ringing UI.
  const autoDecline = params.action === "decline";
  const peerName = params.peerName || "Call";
  const [peerAvatar, setPeerAvatar] = useState(params.peerAvatar || "");

  // P3.14 — Consolidated call state machine. `status` is now driven by an
  // explicit reducer (idle/ringing→connecting→connected→ended/rejected) instead
  // of nine scattered `setStatus(...)` calls. The reducer's terminal-absorbing
  // guard (see callStateMachine.ts) fixes the effect race where a late
  // PC_CONNECTED (a peer connection that reached "connected" a beat after the
  // call had already ended/been rejected) could flip the UI back to a live call.
  const [status, dispatchCall] = useReducer(
    callStateReducer,
    isReconnect,
    initialCallPhase,
  );
  // Mirror `status` into a ref so reconnect handlers can read the latest phase
  // without re-registering their socket listeners on every status change.
  const statusRef = useRef(status);
  statusRef.current = status;
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(callType !== "video");
  // Front camera → mirror the self-view; rear → don't (otherwise the rear feed
  // renders left-right flipped). Toggled by switchCamera().
  const [usingFrontCamera, setUsingFrontCamera] = useState(true);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  // Peer's camera state — when true we render the avatar instead of a frozen
  // last frame. Track onmute/onended are unreliable on Android, so the
  // explicit `video-state` signal is the source of truth (mirrors web).
  const [remoteVideoOff, setRemoteVideoOff] = useState(false);
  // Peer mute indicator (driven by the explicit `audio-state` signal, mirrors
  // web's peerMuted + remoteMuteBadge).
  const [peerMuted, setPeerMuted] = useState(false);
  // Call duration is owned by the isolated <CallDuration /> component so its
  // per-second tick never re-renders this screen (and the video surfaces).
  // Connection quality derived from getStats() — good | fair | poor | unknown.
  // Mirrors the web CallOverlay NetworkStats badge.
  const [connectionQuality, setConnectionQuality] =
    useState<CallQuality>("unknown");
  // The PEER's self-reported connection quality (received via the `quality-state`
  // signal). Drives a Teams-style "<name>'s connection is unstable" banner so
  // the user knows a freeze/stutter is the OTHER side's network, not theirs.
  const [peerQuality, setPeerQuality] = useState<CallQuality>("unknown");
  // Last quality value we SENT to the peer — used to only emit `quality-state`
  // on a real change (not every 3s sample) so we don't spam the relay.
  const lastSentQualityRef = useRef<string | null>(null);
  const [onHold, setOnHold] = useState(false);
  const holdSnapshotRef = useRef<{ muted: boolean; videoOff: boolean } | null>(
    null,
  );
  const [noiseSuppressionEnabled, setNoiseSuppressionEnabled] = useState(true);
  const [recording, setRecording] = useState(false);
  // Video calls default to the loudspeaker; voice calls to the earpiece. The
  // audio-output toggle flips `speakerOn`, and the audio-mode effect below
  // routes accordingly for both call types.
  const [speakerOn, setSpeakerOn] = useState(callType === "video");
  const [showMore, setShowMore] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [chatText, setChatText] = useState("");
  const [chatUnread, setChatUnread] = useState(0);
  const [callMessages, setCallMessages] = useState<CallMessage[]>([]);
  // Seed the in-call chat panel with the conversation's existing history so
  // opening chat mid-call shows prior messages — web parity: the web
  // CallOverlay is handed the live conversation `messages`, whereas here the
  // panel previously only held messages that arrived DURING the call (via the
  // `chat_message` realtime handler below). Live messages keep flowing through
  // that handler; we dedupe by id and prepend history (the REST endpoint
  // returns oldest→newest, same order the chat thread uses).
  const chatHistoryLoadedRef = useRef(false);
  useEffect(() => {
    if (!conversationId || Number.isNaN(conversationId)) return;
    if (chatHistoryLoadedRef.current) return;
    chatHistoryLoadedRef.current = true;
    let cancelled = false;
    getMessages(conversationId)
      .then(({ data }) => {
        if (cancelled || !Array.isArray(data)) return;
        const seeded = data
          .filter((m) => m.format_type !== "system" && !m.deleted_at)
          .map((m) => ({
            id: m.id,
            senderId: m.sender_id,
            senderName: m.sender_name,
            content: m.content,
            createdAt: m.created_at,
          }));
        if (seeded.length === 0) return;
        setCallMessages((prev) => {
          const seen = new Set(prev.map((m) => String(m.id)));
          return [...seeded.filter((m) => !seen.has(String(m.id))), ...prev];
        });
      })
      .catch((err: unknown) => {
        // Allow a later retry (e.g. reconnect) if the initial hydrate failed.
        chatHistoryLoadedRef.current = false;
        console.warn("[call] chat history load failed:", errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  const [floatingReactions, setFloatingReactions] = useState<
    FloatingReaction[]
  >([]);
  const [showAddParticipant, setShowAddParticipant] = useState(false);
  const [addParticipantQuery, setAddParticipantQuery] = useState("");
  const [addParticipantSearching, setAddParticipantSearching] = useState(false);
  const [addParticipantResults, setAddParticipantResults] = useState<
    {
      id: number;
      full_name?: string;
      username?: string;
      avatar?: string | null;
    }[]
  >([]);
  const addParticipantTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  useEffect(
    () => () => {
      if (addParticipantTimerRef.current) {
        clearTimeout(addParticipantTimerRef.current);
      }
    },
    [],
  );
  const [notificationPrefs, setNotificationPrefs] = useState(
    DEFAULT_NOTIFICATION_PREFS,
  );
  // Picture-in-Picture (Android). True while the call window is shrunk into the
  // OS PiP tile (user left the app mid-call). Drives the collapsed layout below
  // (remote video / avatar only, no controls) — Signal-Android parity.
  const [isInPip, setIsInPip] = useState(false);
  // Auto-hide call chrome (peer name, duration, status/quality badges and the
  // control bar) after a few seconds of no touch — WhatsApp/Signal parity and
  // mirrors the web client's `controlsVisible` behaviour. Only active while the
  // call is CONNECTED (during ringing/incoming the accept/decline controls must
  // always stay visible). A tap anywhere on the call surface toggles the chrome
  // back on and re-arms the idle timer.
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const ringPlayer = useAudioPlayer();
  const ringStatus = useAudioPlayerStatus(ringPlayer);
  const ringToneKeyRef = useRef<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const callIdRef = useRef<number | null>(
    params.callId ? Number(params.callId) : null,
  );
  const initiateClientMsgIdRef = useRef(
    `call-initiate:${conversationId}:${Date.now()}`,
  );
  const endClientMsgIdRef = useRef<string | null>(null);
  // Caller-abort bookkeeping. `initiatedRef` flips true once call_initiate has
  // been attempted; `ringTimeoutRef` is the no-answer timer; `cancelClientMsgId`
  // dedupes the call_cancel we send when the caller backs out before a callId
  // exists (i.e. before call_started arrives).
  const initiatedRef = useRef(false);
  const cancelClientMsgIdRef = useRef<string | null>(null);
  const ringTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const peerIdRef = useRef<number | null>(
    params.peerId ? Number(params.peerId) : null,
  );
  const iceServersRef = useRef<IceServer[]>(FALLBACK_ICE);
  const iceConfigLoadedRef = useRef(false);
  // P1.8 — whether the CURRENTLY-loaded ICE config carries real, provisioned
  // TURN (Cloudflare/coturn/static) rather than the public Open Relay / STUN
  // fallback. Drives the deterministic gate in waitForIceConfig so the FIRST
  // negotiation never proceeds against the public-only fallback when real TURN
  // is still in flight.
  const iceHasRealTurnRef = useRef(false);
  // P1.9 — whether the server permits the public Open Relay TURN fallback for
  // this client. Defaults to true (backwards-compat for older servers that
  // don't send `allowPublicFallback`). When the loaded config says false, we
  // strip the public openrelay.metered.ca TURN entries from whatever ICE list
  // we hand to RTCPeerConnection (STUN is always kept).
  const iceAllowPublicRef = useRef(true);
  // P1.8 — set once the very first offer/answer for this screen has begun
  // negotiating. After that we no longer block on real-TURN arrival (a later
  // ICE-restart / renegotiation must proceed promptly with whatever creds we
  // have); only the FIRST connection is gated on genuine TURN.
  const firstNegotiationStartedRef = useRef(false);
  const pendingIce = useRef<IceCandidateLike[]>([]);
  const startedAt = useRef<number>(0);
  // Recovery state — mirrors the proven web client. relayOnly forces TURN-only
  // after a UDP/STUN ICE failure; the timers/flags coordinate ICE-restart and
  // a connection-timeout safety net so calls recover instead of dropping.
  const relayOnlyRef = useRef(false);
  const iceRestartAttemptedRef = useRef(false);
  const negotiationDoneRef = useRef(false);
  // ── Perfect Negotiation (glare handling) ───────────────────────────────────
  // Both peers can emit an offer at the same time (the caller's initial offer,
  // an ICE-restart from either side, or a post-resume renegotiation). Without
  // this, an offer arriving while we already have a local offer in flight threw
  // "Failed to set remote description: wrong state" and the call hung. We adopt
  // the standard polite/impolite pattern: the callee is POLITE (rolls its own
  // offer back and accepts the incoming one on collision); the caller is
  // IMPOLITE (ignores the colliding offer and keeps its own). `makingOfferRef`
  // marks the window where we are creating/applying our own offer so an
  // incoming offer in that window is detected as a collision.
  // Reconnect acts as the POLITE answerer: it waits for the peer to send a
  // fresh offer (driven by our `call_reconnect`) and answers it, so on an offer
  // collision it rolls back and accepts theirs (same as an incoming callee).
  const politeRef = useRef(mode === "incoming" || isReconnect);
  const makingOfferRef = useRef(false);
  // True once THIS session has accepted the incoming call (or is the caller).
  // The server echoes `call_handled_elsewhere` back to the accepter's own user
  // so their OTHER ringing devices dismiss the PiP. On web that echo is handled
  // only by the global incoming-call PiP (CallContext) and ignored by the
  // active CallOverlay. On mobile this single screen serves BOTH roles, so
  // without this guard the accepting device tore down the very call it just
  // accepted (looked like a crash: media acquired, screen vanishes, no PC).
  const acceptedRef = useRef(mode === "outgoing");
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Bounded-reconnect safety net (Signal-Android parity). Armed after we send
  // `call_reconnect`; if the peer never re-offers (so no PC is ever built and
  // the per-PC connect timeout never arms), this fires and ends the call rather
  // than leaving the screen stuck on "Reconnecting…" forever.
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // P0.5 — Callee auto re-offer recovery. Armed right after acceptIncoming()
  // succeeds: if no OFFER ever arrives (so no PC is built) within a short grace
  // window, we ask the caller to re-offer via `call_reconnect`. This recovers
  // the case where the caller's OFFER was emitted/dropped before we finished
  // accepting (push / cold-start / lock-screen answer) AND the P0.4
  // `call_ready` → `call_peer_ready` re-offer also failed to land. Cleared the
  // moment a PC is created (createPC) and on teardown/unmount.
  const acceptReofferTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // P1.10 — Black-video watchdog (see onconnectionstatechange + request-video-state).
  const remoteVideoWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const videoStateRequestedRef = useRef(false);
  // P-RELIABILITY — Signal-style RELAY-FIRST fast retry. ICE can sit in
  // "checking" for a long time on a relay-required network WITHOUT ever
  // transitioning to "failed" (so the failed-state recovery ladder never
  // fires) — the call just hangs on "Connecting…". Signal bounds this: if the
  // very first negotiation hasn't reached "connected" within a few seconds, it
  // rebuilds the PeerConnection TURN-only (iceTransportPolicy:"relay") against
  // the provisioned Cloudflare TURN so the relay path is tried promptly instead
  // of waiting out a long host/srflx candidate-gathering stall. Armed once per
  // call when the first PC is created; cleared on connect and teardown.
  const relayFastRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const relayFastRetryUsedRef = useRef(false);
  // P0.7 — Reliable local-ICE transport. Bare `socket.send` silently drops a
  // candidate whenever the WS is momentarily not OPEN (foreground reconnect,
  // brief mobile/VPN blip). A dropped local ICE candidate can be the ONE
  // candidate that would have completed the pairing, leaving the call stuck on
  // "Connecting…". Instead we push every local candidate onto an ordered queue
  // that flushes via `sendWithBackoff` (which reconnects + retries) and
  // re-flushes itself on a short timer until the socket is back, so no
  // candidate is lost across a transient WS outage. Cleared on unmount.
  const iceOutQueueRef = useRef<
    { targetUserId: number; candidate: IceCandidateLike }[]
  >([]);
  const iceFlushingRef = useRef(false);
  const iceFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const createPCRef = useRef<
    | ((
        stream: MediaStream | null,
        targetUserId: number,
        addTracksNow?: boolean,
      ) => RTCPeerConnection)
    | null
  >(null);
  // Stable ref to recoverDeadVideoTrack so the connection-state handler
  // (created before the callback is defined below) can invoke the LATEST
  // version without a stale closure.
  const recoverDeadVideoTrackRef = useRef<(() => Promise<boolean>) | null>(
    null,
  );
  // ── Signal serialization queue (mirrors the web client's buffered, ordered
  // signal handling). Every incoming WS signal used to spawn an UNORDERED
  // async IIFE: while the offer handler was awaiting getUserMedia/ICE-config,
  // a concurrently-arriving answer or renegotiation offer would race against
  // a half-built peer connection — setRemoteDescription threw in the wrong
  // state, the rejection was unhandled, and the call silently hung on
  // "Connecting…" forever. Chaining every signal task on one promise makes
  // processing strictly sequential, so that interleaving is impossible.
  const signalChainRef = useRef<Promise<void>>(Promise.resolve());
  const seenSignalIdsRef = useRef(new Set<string>());
  const runSerialized = useCallback((task: () => Promise<void>) => {
    signalChainRef.current = signalChainRef.current
      .then(task)
      .catch((err: unknown) => {
        console.warn("[call] signaling task failed:", errorMessage(err));
      });
    return signalChainRef.current;
  }, []);

  const endAndLeave = useCallback(
    (sendEnd: boolean) => {
      // Always clear the no-answer ring timer so a late fire can't re-enter.
      if (ringTimeoutRef.current) {
        clearTimeout(ringTimeoutRef.current);
        ringTimeoutRef.current = null;
      }
      if (sendEnd && callIdRef.current) {
        if (!endClientMsgIdRef.current) {
          endClientMsgIdRef.current = `call-end:${callIdRef.current}:${conversationId}`;
        }
        // Capture the callId now — the refs below are nulled synchronously as we
        // tear the call down, but the async WS/HTTP end must still reference it.
        const endCallId = callIdRef.current;
        // Send the WS `call_end`, then GUARANTEE the server actually committed
        // the end via an HTTP fallback. If the WS frame is dropped (socket
        // briefly down on hang-up, app killed right after) the `call_logs` row
        // would otherwise stick at `answered` forever — which kept the "Ongoing
        // call — Return" banner re-appearing after the call had really ended.
        // The HTTP endpoint mirrors the WS transition and is idempotent, so
        // firing it unconditionally after the WS attempt is safe.
        void (async () => {
          let wsOk = false;
          try {
            wsOk = await socket.sendCallActionWithRetry(
              "end",
              {
                callId: endCallId,
                conversationId,
                clientMsgId: endClientMsgIdRef.current!,
              },
              {
                timeoutMs: 3500,
                maxAttempts: 5,
                initialBackoffMs: 120,
                maxBackoffMs: 700,
              },
            );
          } catch {
            wsOk = false;
          }
          // Always confirm via HTTP. Even when the WS send "succeeded" (frame
          // written to the socket) the server may not have applied the
          // transition; the idempotent endpoint makes the end authoritative.
          try {
            await endCallHttp(endCallId, conversationId);
          } catch (err: unknown) {
            if (!wsOk) {
              console.warn(
                "[call] HTTP end fallback failed:",
                errorMessage(err),
              );
            }
          }
        })();
      } else if (
        sendEnd &&
        !callIdRef.current &&
        mode === "outgoing" &&
        initiatedRef.current
      ) {
        // Caller aborted (or the ring timed out) BEFORE call_started returned a
        // callId. Send call_cancel so the server marks the ringing call as
        // missed and stops the callee's ring + native push. Keyed by
        // conversation since we have no callId yet. No-op server-side if the
        // initiate frame never actually reached the server.
        if (!cancelClientMsgIdRef.current) {
          cancelClientMsgIdRef.current = `call-cancel:${conversationId}:${Date.now()}`;
        }
        void socket.sendWithBackoff(
          "call_cancel",
          {
            conversationId,
            clientMsgId: cancelClientMsgIdRef.current,
          },
          {
            timeoutMs: 3500,
            maxAttempts: 5,
            initialBackoffMs: 120,
            maxBackoffMs: 700,
          },
        );
      }
      try {
        localStreamRef.current?.getTracks().forEach((t) => t.stop());
      } catch {
        /* ignore */
      }
      try {
        pcRef.current?.close();
      } catch {
        /* ignore */
      }
      pcRef.current = null;
      localStreamRef.current = null;
      remoteStreamRef.current = null;
      seenSignalIdsRef.current.clear();
      // Return the app BEHIND the lock screen now that the call is over. While
      // the call UI was up we enabled show-over-lock-screen; disabling it here
      // (and on unmount below) ensures the device must be unlocked to use the
      // app again — fixes "app usable over lock screen after call ends".
      setShowWhenLocked(false);
      // Release the cross-path navigation guard so a future call can present
      // the call screen again (see src/realtime/callRouting.ts).
      endCallNavigation();
      // The call screen can be the ROOT route on a cold call launch (locked
      // device / killed app → index.tsx redirects straight here, with no
      // dashboard beneath). In that case router.back() has nowhere to go and
      // would exit the app; replace into the tabs instead so ending/declining
      // lands cleanly on the dashboard.
      if (router.canGoBack()) {
        router.back();
      } else {
        router.replace("/(tabs)");
      }
    },
    [conversationId, router, mode],
  );

  // Native runtime-permission pre-flight (Android). react-native-webrtc's
  // getUserMedia does NOT reliably trigger the Android permission dialog on
  // every device/OS version — when the permission is simply "not granted yet"
  // it can fail immediately, which made outgoing/incoming calls silently
  // never connect. Mirrors the videosdk-rtc-react-native example, which
  // explicitly requests CAMERA + RECORD_AUDIO before touching WebRTC.
  const ensurePermissions = useCallback(async (): Promise<boolean> => {
    if (Platform.OS !== "android") return true;
    try {
      const perms = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
      if (callType === "video") {
        perms.push(PermissionsAndroid.PERMISSIONS.CAMERA);
      }
      const result = await PermissionsAndroid.requestMultiple(perms);
      return perms.every(
        (p) =>
          (result as Record<string, string>)[p] ===
          PermissionsAndroid.RESULTS.GRANTED,
      );
    } catch {
      // If the native module errs, fall through and let getUserMedia try.
      return true;
    }
  }, [callType]);

  const getMedia = useCallback(
    async (silent = false): Promise<MediaStream | null> => {
      // Reuse an existing stream (e.g. from the ringing pre-warm) so two
      // concurrent acquisitions never race for the camera.
      if (localStreamRef.current) return localStreamRef.current;

      const permitted = await ensurePermissions();
      if (!permitted) {
        if (!silent) {
          Alert.alert(
            "Permission required",
            callType === "video"
              ? "Camera and microphone access are required for video calls. Enable them in Settings and try again."
              : "Microphone access is required for calls. Enable it in Settings and try again.",
          );
        }
        return null;
      }

      // Progressively-relaxed constraint profiles (mirrors the web
      // buildMediaConstraintProfiles): the ideal profile first, then plain
      // defaults, then audio-only as a last resort for video calls. On many
      // low-end Android cameras the exact 1280×720@30 profile is rejected
      // outright — previously that single failure aborted the whole call.
      const audio = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      const profiles: MediaConstraintProfile[] =
        callType === "video"
          ? [
              {
                audio,
                video: {
                  facingMode: "user",
                  width: { ideal: 1280, max: 1280 },
                  height: { ideal: 720, max: 720 },
                  frameRate: { ideal: 30, max: 30 },
                },
              },
              {
                audio,
                video: {
                  facingMode: "user",
                  width: { ideal: 640 },
                  height: { ideal: 480 },
                  frameRate: { ideal: 24, max: 30 },
                },
              },
              { audio, video: true },
              { audio, video: false },
            ]
          : [
              { audio, video: false },
              { audio: true, video: false },
            ];

      for (const constraints of profiles) {
        try {
          const stream = await mediaDevices.getUserMedia(
            constraints as Parameters<typeof mediaDevices.getUserMedia>[0],
          );
          // Some devices can return a stream without an audio track for
          // video constraints. Ensure we always publish a microphone track.
          if (stream.getAudioTracks().length === 0) {
            try {
              const audioOnly = await mediaDevices.getUserMedia({
                audio: true,
                video: false,
              });
              const track = audioOnly.getAudioTracks()[0];
              if (track) stream.addTrack(track);
            } catch {
              /* fall through; existing permission error is handled below */
            }
          }
          // Tell the encoder this is MOTION content (a talking head with a
          // moving background), not a static screen share. With the default
          // hint the encoder biases toward preserving detail and drops frames
          // when the uplink tightens — which is exactly the stutter/freeze the
          // user sees. "motion" makes it preserve the frame rate and soften
          // detail instead.
          for (const track of stream.getVideoTracks()) {
            try {
              // `contentHint` is a standard MediaStreamTrack property that
              // react-native-webrtc does not declare in its .d.ts — write it
              // through a narrow structural view rather than widening to any.
              (track as unknown as { contentHint?: string }).contentHint =
                "motion";
            } catch {
              /* not supported on this platform build — ignore */
            }
          }
          localStreamRef.current = stream;
          setLocalStream(stream);
          return stream;
        } catch {
          /* try the next, more relaxed profile */
        }
      }
      if (!silent) {
        Alert.alert(
          "Cannot start call",
          callType === "video"
            ? "Could not access the camera/microphone. Make sure no other app is using them and permissions are granted."
            : "Could not access the microphone. Make sure no other app is using it and the permission is granted.",
        );
      }
      return null;
    },
    [callType, ensurePermissions],
  );

  useEffect(() => {
    let active = true;
    getNotificationPrefs()
      .then((r) => {
        if (!active) return;
        const merged = mergeNotificationPrefs(r.data || {});
        setNotificationPrefs(merged);
        // Cache the call-relevant prefs so the KILLED/headless Notifee path can
        // honour `muteAll` AND the user's SELECTED ringtone without an
        // authenticated API call (see callPrefsStore + notifeeService
        // .displayIncomingCall, which posts on the per-tone channel matching
        // this ringtone id so the status-bar ring uses the user's choice).
        void persistCallPrefs({
          muteAll: !!merged.muteAll,
          ringtone: merged.ringtone || "classic",
        });
      })
      .catch(() => {
        if (!active) return;
        setNotificationPrefs(mergeNotificationPrefs());
      });
    return () => {
      active = false;
    };
  }, []);

  // Incoming call surfaced: the call SCREEN now owns the ring (it plays the
  // user's SELECTED ringtone and respects `muteAll`). Dismiss any system
  // full-screen-intent call notification Notifee posted for this same call so
  // we don't DOUBLE-RING (Notifee's looped system sound + the screen's selected
  // ringtone). Safe no-op when there is no such notification (app was already
  // foreground / Expo Go). Runs once on mount for incoming calls.
  useEffect(() => {
    if (mode !== "incoming") return;
    const cid = params.callId;
    const conv = params.conversationId;
    if (!cid || !conv) return;
    void notifeeService.cancelCall(String(cid), String(conv));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    const applyAudioMode = async () => {
      try {
        await setAudioModeAsync({
          playsInSilentMode: true,
          allowsRecording: status !== "ringing",
          shouldPlayInBackground: false,
          interruptionMode: "doNotMix",
          shouldRouteThroughEarpiece: status !== "ringing" ? !speakerOn : false,
        });
      } catch {
        /* ignore runtime routing failures */
      }
    };
    applyAudioMode();
  }, [callType, speakerOn, status]);

  useEffect(() => {
    return () => {
      setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: false,
        shouldPlayInBackground: false,
        interruptionMode: "doNotMix",
        shouldRouteThroughEarpiece: false,
      }).catch(() => {});
    };
  }, []);

  const ringingCategory = mode === "incoming" ? "ringtone" : "outgoing";
  const ringingToneId =
    ringingCategory === "ringtone"
      ? notificationPrefs.ringtone ||
        DEFAULT_NOTIFICATION_PREFS.ringtone ||
        "classic"
      : notificationPrefs.outgoingTone ||
        DEFAULT_NOTIFICATION_PREFS.outgoingTone ||
        "ringback";
  const shouldPlayRingingTone =
    status === "ringing" &&
    !notificationPrefs.muteAll &&
    ringingToneId !== "none";

  useEffect(() => {
    if (!shouldPlayRingingTone) {
      ringToneKeyRef.current = null;
      try {
        ringPlayer.pause();
        ringPlayer.seekTo(0);
      } catch {
        /* no-op */
      }
      return;
    }
    const uri = getNotificationPreviewDataUri(ringingCategory, ringingToneId);
    if (!uri) return;
    const key = `${ringingCategory}:${ringingToneId}`;
    if (ringToneKeyRef.current !== key) {
      ringPlayer.replace({ uri });
      ringToneKeyRef.current = key;
    }
    setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
      shouldPlayInBackground: false,
      interruptionMode: "doNotMix",
      shouldRouteThroughEarpiece: false,
    })
      .then(() => {
        ringPlayer.play();
      })
      .catch(() => {
        /* no-op */
      });
  }, [ringPlayer, ringingCategory, ringingToneId, shouldPlayRingingTone]);

  useEffect(() => {
    if (!shouldPlayRingingTone || !ringStatus?.didJustFinish) return;
    try {
      ringPlayer.seekTo(0);
      ringPlayer.play();
    } catch {
      /* no-op */
    }
  }, [ringPlayer, ringStatus?.didJustFinish, shouldPlayRingingTone]);

  useEffect(
    () => () => {
      try {
        ringPlayer.pause();
        ringPlayer.seekTo(0);
      } catch {
        /* no-op */
      }
    },
    [ringPlayer],
  );

  // Incoming-call vibration loop. While an INCOMING call is ringing (and the
  // user has not muted everything) buzz the device in a repeating pattern like
  // a real phone call, alongside the ringtone. Stops the moment the call is
  // answered/declined/cancelled (status leaves "ringing") and on unmount. The
  // looped Notifee vibration only runs in the killed/background pre-mount window
  // and is cancelled when this screen mounts (see the cancelCall effect above),
  // so there is no double-buzz once the call UI owns the ring.
  const shouldVibrateRinging =
    mode === "incoming" && status === "ringing" && !notificationPrefs.muteAll;
  useEffect(() => {
    if (!shouldVibrateRinging) {
      try {
        Vibration.cancel();
      } catch {
        /* no-op */
      }
      return;
    }
    try {
      // Repeating pattern: wait 0ms, buzz 700ms, pause 1500ms, then repeat.
      // The `true` second arg loops until Vibration.cancel(). iOS ignores the
      // pattern timings (fixed buzz) but still repeats — acceptable parity.
      Vibration.vibrate([0, 700, 1500], true);
    } catch {
      /* best-effort — never let a vibration error crash the call screen */
    }
    return () => {
      try {
        Vibration.cancel();
      } catch {
        /* no-op */
      }
    };
  }, [shouldVibrateRinging]);

  // ── ADAPTIVE VIDEO QUALITY ────────────────────────────────────────────────
  // All encoder control now lives in `src/calls/shared/callQuality.ts`, which
  // is the byte-for-byte twin of the web client's controller (the repo has no
  // shared web/native package; parity is by duplication). That module fixes the
  // four things that made 1:1 video calls stutter and freeze on this screen:
  //
  //   1. The old classifier computed loss from the SINCE-CALL-START counters,
  //      so one early burst pinned the encoder low for the rest of the call.
  //   2. It graded RTT against ABSOLUTE thresholds (`rtt < 0.15 → good`), which
  //      is meaningless on a Cloudflare-TURN-relayed path where a healthy call
  //      sits at 60-150 ms — so it oscillated across the boundary every sample.
  //   3. Each oscillation flipped `scaleResolutionDownBy` between 1 and 2, and
  //      every resolution change reinitialises the encoder and forces a
  //      keyframe: a visible freeze pulse, every few seconds.
  //   4. Ramp timers and the stats loop both called `setParameters()` on the
  //      same sender concurrently. `getParameters()` hands back a snapshot with
  //      a `transactionId`; the loser of that race throws InvalidStateError,
  //      and the old `.catch?.(() => {})` swallowed it — so ramp steps were
  //      silently dropped and the encoder could stay stuck at the 300 kbps
  //      connect cap for the whole call.
  const qualityControllerRef = useRef<QualityController | null>(null);
  const cancelBitrateRampRef = useRef<(() => void) | null>(null);

  const getQualityController = useCallback(() => {
    if (!qualityControllerRef.current) {
      qualityControllerRef.current = createQualityController({
        isMobile: true,
      });
    }
    return qualityControllerRef.current;
  }, []);

  const applySenderEncodingLimits = useCallback(
    (pc: RTCPeerConnection) => {
      // Conservative cap for a fast, stable connect. The connect-time ramp
      // (below) opens it up once the link is actually established.
      const controller = getQualityController();
      controller.setTierIndex(RAMP_START_TIER_INDEX);
      void applyVideoEncodingTier(
        pc as unknown as PeerConnectionLike,
        controller.getTier(),
      );
      // Cap Opus separately so video adaptation can never starve audio.
      void applyAudioEncodingCap(pc as unknown as PeerConnectionLike);
    },
    [getQualityController],
  );

  const applyBitrateRampUp = useCallback(
    (pc: RTCPeerConnection) => {
      cancelBitrateRampRef.current?.();
      // Walks the SAME ladder the adaptive controller uses and shares its
      // position with it, so the ramp and the controller can never disagree
      // about what the encoder is doing — and the ramp aborts the moment the
      // controller has stepped DOWN, instead of fighting a genuinely bad link
      // back up (which is what produced the connect-time freeze pulses).
      cancelBitrateRampRef.current = startBitrateRampUp(
        pc as unknown as PeerConnectionLike,
        getQualityController(),
      );
    },
    [getQualityController],
  );

  // Briefly wait for the real ICE config (TURN creds) so the connection is
  // established over a relay when needed instead of racing with the fallback
  // STUN-only servers. Fast-exits the moment the config has loaded.
  //
  // Matches the web client's 2000ms wait: giving the real TURN credentials a
  // fair chance to arrive avoids negotiating with the STUN-only fallback on
  // networks that require a relay (where the call then never connects).
  // Fast-exits the moment the config has loaded.
  const waitForIceConfig = useCallback(async (timeoutMs?: number) => {
    // P1.8 — DETERMINISTIC ICE-CONFIG GATING. There are two distinct waits:
    //   1. Wait for ANY config to load (cache/live fetch finished).
    //   2. On the FIRST negotiation, ADDITIONALLY wait (bounded) for REAL,
    //      provisioned TURN to arrive — never negotiate the first offer/answer
    //      against the public Open Relay / STUN-only fallback. On a network
    //      that requires a relay, doing so makes the first call hang
    //      ("Connecting…") even though a retry works once the real creds are
    //      cached (the classic "fresh install: first call doesn't connect").
    //      A later ICE-restart / renegotiation (firstNegotiationStarted) must
    //      proceed promptly with whatever creds we have, so only the FIRST
    //      connection is gated on genuine TURN.
    const start = Date.now();

    // Stage 1 — ensure SOME config is loaded.
    if (!iceConfigLoadedRef.current) {
      // ADAPTIVE WAIT: on a FRESH INSTALL the TURN-credential fetch
      // (warmIceConfig at app start + the per-screen getIceConfig) may not have
      // completed yet. When the real config has NOT loaded yet we wait
      // substantially longer (up to 5s) for the genuine TURN creds; once loaded
      // a later call returns immediately. A caller-supplied timeout still wins.
      const effectiveTimeout =
        timeoutMs ?? (getCachedIceConfig() ? 1200 : 5000);
      while (
        !iceConfigLoadedRef.current &&
        Date.now() - start < effectiveTimeout
      ) {
        // Opportunistically adopt the warmed cache the instant it lands so we
        // stop waiting as soon as the real TURN creds are available.
        const cached = getCachedIceConfig();
        if (cached?.iceServers?.length) {
          iceServersRef.current = cached.iceServers;
          iceConfigLoadedRef.current = true;
          iceHasRealTurnRef.current = hasRealTurn(cached);
          // P1.9 — honour the server's public-TURN policy from the cache.
          iceAllowPublicRef.current = cached.allowPublicFallback !== false;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    // Stage 2 — FIRST-negotiation real-TURN gate. Only blocks the very first
    // offer/answer of this call screen, and only when we don't already have
    // provisioned TURN. We keep polling the warmed cache in case the real creds
    // land a beat after the (possibly fallback) config was first adopted. A
    // hard cap keeps the connect deterministic: if real TURN never shows up in
    // time we proceed with what we have (STUN/public fallback) rather than
    // hanging forever — the recovery ladder (relay-only rebuild) still applies.
    if (
      !firstNegotiationStartedRef.current &&
      !iceHasRealTurnRef.current &&
      timeoutMs == null
    ) {
      // P-RELIABILITY — Cloudflare TURN creds are minted+cached server-side
      // (warmIceConfig at app start + on app-foreground + on call_incoming), so
      // the genuine TURN config is almost always already warm by the time we
      // negotiate. We therefore cap the first-negotiation real-TURN wait at a
      // TIGHT ~1.5s (down from 6s) so we NEVER eat into the ring/connect budget
      // waiting for creds that are usually already here — the long 6s wait was a
      // primary cause of "sometimes the call doesn't connect". If real TURN
      // still hasn't landed we proceed with whatever we have; the relay-first
      // fast-retry ladder (below) then rebuilds TURN-only the instant ICE
      // stalls, so a relay-required network still connects promptly.
      const REAL_TURN_DEADLINE_MS = 1500;
      while (Date.now() - start < REAL_TURN_DEADLINE_MS) {
        const cached = getCachedIceConfig();
        if (cached?.iceServers?.length && hasRealTurn(cached)) {
          iceServersRef.current = cached.iceServers;
          iceConfigLoadedRef.current = true;
          iceHasRealTurnRef.current = true;
          // P1.9 — honour the server's public-TURN policy from the cache.
          iceAllowPublicRef.current = cached.allowPublicFallback !== false;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    // Mark that the first negotiation has begun — subsequent waits skip the
    // real-TURN gate so recovery offers proceed immediately.
    firstNegotiationStartedRef.current = true;
  }, []);

  // Attach local tracks AFTER setRemoteDescription on the answerer so they bind
  // to the transceivers the offer created (mirrors web's attachLocalTracks).
  //
  // CRITICAL: on react-native-webrtc, calling addTrack() after
  // setRemoteDescription(offer) frequently creates a NEW, unmatched m-line
  // instead of reusing the recvonly transceiver the offer created. That makes
  // the answer SDP no longer line up with the offer → ICE never settles, the
  // call connects slowly, stalls, or drops. We instead find the offer's
  // matching transceiver by kind and replaceTrack onto it (upgrading the
  // direction to sendrecv), only falling back to addTrack when there is no
  // matching transceiver — exactly what the proven web client does.
  const attachLocalTracks = useCallback(async (stream: MediaStream | null) => {
    const pc = pcRef.current;
    if (!pc || !stream) return;
    const transceivers =
      typeof pc.getTransceivers === "function" ? pc.getTransceivers() : [];
    const used = new Set<(typeof transceivers)[number]>();

    for (const track of stream.getTracks()) {
      // Skip if this exact track is already on some sender.
      const alreadyAttached = transceivers.some(
        (t) => t.sender?.track && t.sender.track.id === track.id,
      );
      if (alreadyAttached) continue;

      // Find an unused transceiver of MATCHING kind created by the remote
      // offer (its receiver track kind reflects what was offered).
      const matchingTr = transceivers.find((t) => {
        if (used.has(t)) return false;
        if (t.sender?.track) return false; // already in use
        const trKind = t.receiver?.track?.kind;
        return trKind === track.kind;
      });

      if (matchingTr) {
        used.add(matchingTr);
        try {
          await matchingTr.sender.replaceTrack(track);
          // Upgrade direction so we actually SEND media on this m-line.
          try {
            matchingTr.direction = "sendrecv";
          } catch {
            /* not always settable */
          }
        } catch {
          // replaceTrack failed — fall back to addTrack.
          try {
            pc.addTrack(track, stream);
          } catch {
            /* ignore */
          }
        }
      } else {
        // No matching transceiver from the offer — addTrack (creates a new
        // m-line + triggers renegotiation if needed).
        try {
          pc.addTrack(track, stream);
        } catch {
          /* ignore */
        }
      }
    }
  }, []);

  const createPC = useCallback(
    (stream: MediaStream | null, targetUserId: number, addTracksNow = true) => {
      // When relayOnlyRef is set (after a UDP/STUN ICE failure) we force
      // TURN-only so even networks that block UDP entirely can complete the
      // call by relaying every byte over TCP/TLS. This is the key recovery
      // path for restrictive mobile carriers / corporate Wi-Fi.
      const pcConfig: ConstructorParameters<typeof RTCPeerConnection>[0] = {
        // P1.9 — strip the public Open Relay TURN entries when the server
        // forbids the public fallback (DISABLE_PUBLIC_TURN=true). STUN is kept.
        iceServers: applyPublicTurnPolicy(
          iceServersRef.current,
          iceAllowPublicRef.current,
        ),
        // Pre-gather candidates + fewer ports → faster, firewall-friendlier
        // connection setup (matches web config).
        iceCandidatePoolSize: 10,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require",
        ...(relayOnlyRef.current
          ? { iceTransportPolicy: "relay" as const }
          : null),
      };
      const pc = new RTCPeerConnection(pcConfig);
      pcRef.current = pc;

      // P0.5 — a PC now exists, so the callee auto re-offer recovery timer is no
      // longer needed: an offer DID arrive (or we are re-offering). Clearing it
      // here covers EVERY path that builds a PC (incoming-offer answer, reconnect
      // re-offer, relay-only rebuild) so the recovery `call_reconnect` never
      // fires once negotiation is underway.
      if (acceptReofferTimeoutRef.current) {
        clearTimeout(acceptReofferTimeoutRef.current);
        acceptReofferTimeoutRef.current = null;
      }

      // For the OFFERER tracks must exist before createOffer. For the ANSWERER
      // tracks are attached AFTER setRemoteDescription so they bind to the
      // offer's transceivers instead of creating extra unmatched m-lines
      // (which breaks media negotiation — the remote video never renders).
      if (stream && addTracksNow) {
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      }

      // Safety net: if we never reach "connected" within 30s, the negotiation
      // stalled (lost candidate, blocked TURN). Tear down so the user isn't
      // stuck on an endless "Connecting…" screen. Send call_end (idempotent)
      // so the server commits the terminal state — previously this tore down
      // LOCALLY only, leaving the call_logs row stuck at `answered`, which
      // kept the stale "Ongoing call — Return" banner haunting the chat list.
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
      }
      connectionTimeoutRef.current = setTimeout(() => {
        if (pcRef.current !== pc) return;
        if (pc.connectionState !== "connected") {
          endAndLeave(true);
        }
      }, 30000);

      // P-RELIABILITY — Signal-style RELAY-FIRST fast retry. ICE can sit in
      // "checking" for many seconds on a relay-required network WITHOUT ever
      // reaching "failed" (so the failed-state recovery ladder never fires) —
      // the call just hangs on "Connecting…" until the 30s timeout gives up.
      // Bound that: if this FIRST connection hasn't reached "connected" within
      // ~5s and we are NOT already relay-only, rebuild TURN-only against the
      // provisioned Cloudflare TURN so the relay path is tried promptly. Armed
      // once per call (relayFastRetryUsedRef), and only on the initial PC (not
      // the relay-only rebuild itself, which sets relayOnlyRef first).
      if (!relayOnlyRef.current && !relayFastRetryUsedRef.current) {
        if (relayFastRetryRef.current) clearTimeout(relayFastRetryRef.current);
        relayFastRetryRef.current = setTimeout(() => {
          relayFastRetryRef.current = null;
          if (pcRef.current !== pc) return;
          if (pc.connectionState === "connected") return;
          if (relayOnlyRef.current || relayFastRetryUsedRef.current) return;
          relayFastRetryUsedRef.current = true;
          relayOnlyRef.current = true;
          iceRestartAttemptedRef.current = false;
          const localStr = localStreamRef.current;
          if (mode === "outgoing" || isReconnect) {
            // Caller/reconnecter OWNS the offer → tear down + rebuild relay-only
            // and re-offer immediately (same as the failed-state escalation).
            dispatchCall({ type: "PC_RECONNECTING" });
            try {
              pc.close();
            } catch {
              /* ignore */
            }
            pcRef.current = null;
            (async () => {
              try {
                const builder = createPCRef.current;
                if (!builder || !localStr) return;
                const newPc = builder(localStr, targetUserId, true);
                applySenderEncodingLimits(newPc);
                const offer = await newPc.createOffer({
                  offerToReceiveAudio: true,
                  offerToReceiveVideo: callType === "video",
                });
                const local = await setLocalDescriptionWithFec(newPc, offer);
                socket.send("call_signal", {
                  conversationId,
                  callId: callIdRef.current,
                  targetUserId,
                  signal: { type: "offer", sdp: local.sdp },
                });
              } catch {
                /* the 30s connect timeout still owns the hard deadline */
              }
            })();
          } else {
            // Callee waits for the offer → ask the caller to re-offer via
            // `call_reconnect`. relayOnlyRef is now set, so when their fresh
            // offer arrives the call_signal(offer) handler builds our PC
            // relay-only too and both sides negotiate over Cloudflare TURN.
            const callId = callIdRef.current;
            if (callId && Number.isFinite(conversationId)) {
              void socket.sendWithBackoff(
                "call_reconnect",
                { callId, conversationId },
                {
                  timeoutMs: 4000,
                  maxAttempts: 5,
                  initialBackoffMs: 120,
                  maxBackoffMs: 800,
                  ensureConnected: true,
                },
              );
            }
          }
        }, 5000);
      }

      const handlers = pcHandlers(pc);

      handlers.onicecandidate = (e) => {
        if (e.candidate) {
          // P0.7 — enqueue for reliable, ordered delivery (retries over a
          // transient WS blip) instead of a bare fire-and-forget socket.send
          // that is silently lost whenever the socket is momentarily closed.
          enqueueLocalIce(targetUserId, e.candidate.toJSON());
        }
      };

      handlers.ontrack = (e) => {
        // Defensively build the remote stream: react-native-webrtc may fire
        // ontrack once per kind (audio, then video) and `e.streams` can be
        // empty. Add each track to the SAME stream so we never drop one.
        let remote: MediaStream | null = remoteStreamRef.current;
        if (e.streams && e.streams[0]) {
          remote = e.streams[0];
        } else if (!remote) {
          remote = new MediaStream();
        }
        const incoming = e.track;
        if (
          incoming &&
          remote &&
          !remote.getTracks().some((t) => t.id === incoming.id)
        ) {
          try {
            remote.addTrack(incoming);
          } catch {
            /* ignore */
          }
        }
        remoteStreamRef.current = remote;
        setRemoteStream(remote);
        if (incoming?.kind === "video") setRemoteVideoOff(false);
      };

      // Fast proactive ICE restart on a brief mobile/VPN network blip — try to
      // re-establish before connectionState escalates to "failed".
      handlers.oniceconnectionstatechange = () => {
        const ice = pc.iceConnectionState;
        if (
          ice === "disconnected" &&
          negotiationDoneRef.current &&
          !iceRestartAttemptedRef.current
        ) {
          setTimeout(() => {
            const cur = pc.iceConnectionState;
            if (
              (cur === "disconnected" || cur === "failed") &&
              pcRef.current === pc
            ) {
              iceRestartAttemptedRef.current = true;
              (async () => {
                try {
                  const offer = await pc.createOffer({
                    iceRestart: true,
                    offerToReceiveAudio: true,
                    offerToReceiveVideo: callType === "video",
                  });
                  await setLocalDescriptionWithFec(pc, offer);
                  socket.send("call_signal", {
                    conversationId,
                    callId: callIdRef.current,
                    targetUserId,
                    signal: {
                      type: "offer",
                      sdp: pc.localDescription?.sdp,
                    },
                  });
                } catch {
                  /* ignore — connectionState handler will escalate */
                }
              })();
            }
          }, 2000);
        }
      };

      handlers.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === "connected") {
          startedAt.current = Date.now();
          negotiationDoneRef.current = true;
          iceRestartAttemptedRef.current = false;
          if (connectionTimeoutRef.current) {
            clearTimeout(connectionTimeoutRef.current);
            connectionTimeoutRef.current = null;
          }
          if (disconnectTimerRef.current) {
            clearTimeout(disconnectTimerRef.current);
            disconnectTimerRef.current = null;
          }
          // P-RELIABILITY — connected: cancel the relay-first fast retry so it
          // can't tear down a freshly-connected PC.
          if (relayFastRetryRef.current) {
            clearTimeout(relayFastRetryRef.current);
            relayFastRetryRef.current = null;
          }
          dispatchCall({ type: "PC_CONNECTED" });
          // Ramp the video bitrate up now that the link is established
          // (mirrors web applyBitrateRampUp).
          applyBitrateRampUp(pc);
          // SELF-VIEW watchdog: if this is a video call with the camera ON but
          // our local video track is dead/missing at connect time (camera came
          // up behind the keyguard, or another surface briefly stole the
          // exclusive Android camera), re-acquire and republish it. Previously
          // this recovery only ran on an AppState resume — a call that
          // connected while already foregrounded never healed, leaving the
          // self preview invisible for the whole call.
          if (recoverDeadVideoTrackRef.current) {
            void recoverDeadVideoTrackRef.current();
          }
          // P1.10 watchdog armed: if a video call still has no live remote
          // video a few seconds after connect, ask the peer to re-announce.
          if (callType === "video" && !videoStateRequestedRef.current) {
            if (remoteVideoWatchdogRef.current) {
              clearTimeout(remoteVideoWatchdogRef.current);
            }
            remoteVideoWatchdogRef.current = setTimeout(() => {
              remoteVideoWatchdogRef.current = null;
              if (pcRef.current !== pc) return;
              if (videoStateRequestedRef.current) return;
              const remote = remoteStreamRef.current;
              const liveRemoteVideo =
                !!remote &&
                remote.getVideoTracks().some((t) => t.readyState !== "ended");
              if (liveRemoteVideo) return;
              videoStateRequestedRef.current = true;
              const tgt = peerIdRef.current;
              if (!tgt) return;
              socket.send("call_signal", {
                conversationId,
                callId: callIdRef.current,
                targetUserId: tgt,
                signal: { type: "request-video-state" },
              });
            }, 3000);
          }
        } else if (st === "disconnected") {
          // Grace period: a temporary network hiccup is common on mobile.
          // Wait before tearing the call down so it can self-heal.
          if (disconnectTimerRef.current) {
            clearTimeout(disconnectTimerRef.current);
          }
          disconnectTimerRef.current = setTimeout(() => {
            if (pcRef.current === pc && pc.connectionState !== "connected") {
              // Failure teardown must be authoritative: tell the server the
              // call ended (idempotent) or the `answered` row lingers and the
              // stale "Return to call" banner re-appears after the drop.
              endAndLeave(true);
            }
          }, 8000);
        } else if (st === "failed") {
          if (disconnectTimerRef.current) {
            clearTimeout(disconnectTimerRef.current);
            disconnectTimerRef.current = null;
          }
          // Recovery ladder: ICE restart → relay-only rebuild → give up.
          if (!iceRestartAttemptedRef.current && negotiationDoneRef.current) {
            iceRestartAttemptedRef.current = true;
            (async () => {
              try {
                const offer = await pc.createOffer({
                  iceRestart: true,
                  offerToReceiveAudio: true,
                  offerToReceiveVideo: callType === "video",
                });
                await setLocalDescriptionWithFec(pc, offer);
                socket.send("call_signal", {
                  conversationId,
                  callId: callIdRef.current,
                  targetUserId,
                  signal: {
                    type: "offer",
                    sdp: pc.localDescription?.sdp,
                  },
                });
              } catch {
                endAndLeave(true);
              }
            })();
          } else if (!relayOnlyRef.current) {
            // ICE restart didn't help — escalate to TURN-only and rebuild.
            relayOnlyRef.current = true;
            iceRestartAttemptedRef.current = false;
            dispatchCall({ type: "PC_RECONNECTING" });
            const localStr = localStreamRef.current;
            try {
              pc.close();
            } catch {
              /* ignore */
            }
            pcRef.current = null;
            // P1.4: DO NOT clear pendingIce here. Remote ICE candidates buffered
            // before the new remote description still describe the peer's
            // relay-only transport and remain valid for the rebuilt PC.
            // flushIce() drains them after setRemoteDescription on the answer
            // for this new offer. Polite/impolite + makingOffer glare guards
            // stay active across the rebuild.
            (async () => {
              try {
                const builder = createPCRef.current;
                if (!builder || !localStr) return endAndLeave(true);
                const newPc = builder(localStr, targetUserId, true);
                // Apply the conservative initial encoding cap on the rebuilt PC
                // too. The relay-only rebuild previously skipped this, so the
                // fresh connection negotiated with NO bitrate ceiling — a sudden
                // high-bitrate burst over a TURN relay on an already-degraded
                // network tended to stall/freeze. The connect-time ramp then
                // re-runs from onconnectionstatechange("connected").
                applySenderEncodingLimits(newPc);
                const offer = await newPc.createOffer({
                  offerToReceiveAudio: true,
                  offerToReceiveVideo: callType === "video",
                });
                const local = await setLocalDescriptionWithFec(newPc, offer);
                socket.send("call_signal", {
                  conversationId,
                  callId: callIdRef.current,
                  targetUserId,
                  signal: { type: "offer", sdp: local.sdp },
                });
              } catch {
                endAndLeave(true);
              }
            })();
          } else {
            endAndLeave(true);
          }
        } else if (st === "closed") {
          // Only end for a SPONTANEOUS close of the CURRENT PC. We close stale
          // PCs ourselves during the relay-only rebuild / reconnect re-offer —
          // their late "closed" event must not tear down the fresh call.
          if (pcRef.current === pc) {
            endAndLeave(true);
          }
        }
      };

      return pc;
    },
    // The remaining referenced values are refs (stable) or values captured from
    // the route params, which never change for the lifetime of this screen:
    // `mode`, `isReconnect` and `callType` are derived from `useLocalSearchParams`
    // once, and `applySenderEncodingLimits` / `applyBitrateRampUp` /
    // `enqueueLocalIce` are `useCallback`s whose own deps are stable. Adding
    // them would recreate `createPC` mid-call and orphan the live PeerConnection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationId, endAndLeave],
  );

  // Keep a stable ref to createPC so the relay-only rebuild path inside the
  // connection-state handler can recreate the PC without a stale closure.
  createPCRef.current = createPC;

  const flushIce = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) return;
    const list = pendingIce.current.splice(0);
    for (const c of list) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(c));
      } catch {
        /* ignore */
      }
    }
  }, []);

  // P0.7 — Reliable LOCAL ICE transport. Drain the outbound-ICE queue over the
  // WS, retrying via `sendWithBackoff` (which reconnects + backs off) so a
  // candidate is never lost when the socket is momentarily down. Single-flight
  // (`iceFlushingRef`) so concurrent onicecandidate fires + the periodic
  // re-flush timer never double-process the same candidate. Anything that fails
  // to send this pass stays at the FRONT of the queue (FIFO order preserved)
  // and a short timer schedules another attempt until the socket is back.
  const flushIceOutQueue = useCallback(async () => {
    if (iceFlushingRef.current) return;
    if (iceOutQueueRef.current.length === 0) return;
    iceFlushingRef.current = true;
    try {
      while (iceOutQueueRef.current.length > 0) {
        const item = iceOutQueueRef.current[0];
        const ok = await socket.sendWithBackoff(
          "call_signal",
          {
            conversationId,
            callId: callIdRef.current,
            targetUserId: item.targetUserId,
            signal: { type: "ice-candidate", candidate: item.candidate },
          },
          {
            timeoutMs: 4000,
            maxAttempts: 5,
            initialBackoffMs: 120,
            maxBackoffMs: 800,
            ensureConnected: true,
          },
        );
        if (!ok) break; // leave this + the rest queued; the timer retries.
        iceOutQueueRef.current.shift();
      }
    } finally {
      iceFlushingRef.current = false;
    }
    // If anything is still queued (a send failed), schedule a retry so a
    // transient WS outage self-heals without dropping candidates.
    if (iceOutQueueRef.current.length > 0 && !iceFlushTimerRef.current) {
      iceFlushTimerRef.current = setTimeout(() => {
        iceFlushTimerRef.current = null;
        void flushIceOutQueue();
      }, 1000);
    }
  }, [conversationId]);

  // P0.7 — Enqueue a local ICE candidate for reliable, ordered delivery instead
  // of a bare fire-and-forget `socket.send` (which silently drops on a closed
  // socket). Kicks the flusher immediately; the flusher's retry timer covers a
  // down socket.
  const enqueueLocalIce = useCallback(
    (targetUserId: number, candidate: IceCandidateLike) => {
      iceOutQueueRef.current.push({ targetUserId, candidate });
      void flushIceOutQueue();
    },
    [flushIceOutQueue],
  );

  // Show the app OVER the lock screen (and turn the screen on) ONLY while the
  // call UI is mounted. The native module toggles the Activity flags at
  // runtime; we disable them on unmount so the app returns behind the lock
  // screen the moment the call screen goes away. No-op on iOS / Expo Go.
  useEffect(() => {
    setShowWhenLocked(true);
    return () => {
      setShowWhenLocked(false);
    };
  }, []);

  // Clear all recovery timers when the screen unmounts so a late-firing
  // timeout can't tear down a fresh call or call endAndLeave after navigation.
  useEffect(() => {
    // Capture the dedupe Set NOW. The lint rule's general concern (a ref read
    // in a cleanup closure sees whatever it points at at unmount) doesn't
    // apply here: `seenSignalIdsRef` is initialised once via
    // `useRef(new Set())` and never reassigned, so this IS the live Set —
    // and clearing it is exactly the intent.
    const seenSignalIds = seenSignalIdsRef.current;
    return () => {
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
      if (disconnectTimerRef.current) {
        clearTimeout(disconnectTimerRef.current);
        disconnectTimerRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (acceptReofferTimeoutRef.current) {
        clearTimeout(acceptReofferTimeoutRef.current);
        acceptReofferTimeoutRef.current = null;
      }
      // P-RELIABILITY — stop the relay-first fast-retry timer on unmount.
      if (relayFastRetryRef.current) {
        clearTimeout(relayFastRetryRef.current);
        relayFastRetryRef.current = null;
      }
      // P1.10 — stop the black-video watchdog so it can't fire post-unmount.
      if (remoteVideoWatchdogRef.current) {
        clearTimeout(remoteVideoWatchdogRef.current);
        remoteVideoWatchdogRef.current = null;
      }
      // P0.7 — stop the ICE re-flush timer + drop any still-queued local
      // candidates so a late fire can't try to send after teardown.
      if (iceFlushTimerRef.current) {
        clearTimeout(iceFlushTimerRef.current);
        iceFlushTimerRef.current = null;
      }
      iceOutQueueRef.current = [];
      cancelBitrateRampRef.current?.();
      cancelBitrateRampRef.current = null;
      qualityControllerRef.current?.reset();
      // MEDIA / PEER-CONNECTION teardown safety net. endAndLeave() normally
      // stops the tracks and closes the PC, but this screen can unmount via
      // paths that BYPASS it (navigation replace/reset, a surviving duplicate
      // mount being reconciled away, parent teardown). Without this, the mic/
      // camera and the native WebRTC session kept running with NO UI — the
      // "call screen disappeared but I can still talk, had to reboot" bug.
      try {
        localStreamRef.current?.getTracks().forEach((t) => t.stop());
      } catch {
        /* ignore */
      }
      try {
        pcRef.current?.close();
      } catch {
        /* ignore */
      }
      pcRef.current = null;
      localStreamRef.current = null;
      remoteStreamRef.current = null;
      seenSignalIds.clear();
      // The active-call foreground service + PiP flags have their own unmount
      // effects; the lock-screen flag likewise. Nothing further to stop here.
      // Safety net: always release the navigation guard on unmount, even if the
      // screen was dismissed without going through endAndLeave.
      endCallNavigation();
    };
  }, []);

  // Load ICE config up front. Prefer the in-memory cache warmed at app start
  // (see app/_layout.tsx → warmIceConfig) so the TURN creds are available
  // INSTANTLY and waitForIceConfig() never has to poll — shaving the per-call
  // connection delay. Fall back to a live fetch when the cache is cold/stale.
  useEffect(() => {
    const cached = getCachedIceConfig();
    if (cached?.iceServers?.length) {
      iceServersRef.current = cached.iceServers;
      iceConfigLoadedRef.current = true;
      // P1.8 — record whether the warmed cache already carries real TURN so the
      // first-negotiation gate in waitForIceConfig can fast-exit.
      iceHasRealTurnRef.current = hasRealTurn(cached);
      // P1.9 — honour the server's public-TURN policy from the warmed cache.
      iceAllowPublicRef.current = cached.allowPublicFallback !== false;
      return;
    }
    getIceConfig()
      .then((r) => {
        if (r.data?.iceServers?.length) {
          iceServersRef.current = r.data.iceServers;
          // P1.8 — flag real-TURN availability from the live fetch too.
          iceHasRealTurnRef.current = hasRealTurn(r.data);
          // P1.9 — honour the server's public-TURN policy from the live fetch.
          iceAllowPublicRef.current = r.data.allowPublicFallback !== false;
        }
      })
      .catch(() => {})
      .finally(() => {
        iceConfigLoadedRef.current = true;
      });
  }, []);

  // Outgoing: acquire media + send call_initiate.
  // IMPORTANT: socket.send() silently returns false when the WS isn't open
  // (e.g. right after the app returns to the foreground and the socket is
  // still reconnecting). Previously the initiate frame was dropped and the
  // call never started with zero feedback — a major "call not connecting at
  // all" cause on mobile. We now retry for up to 5s and surface an error.
  useEffect(() => {
    if (mode !== "outgoing") return;
    // GUARD: a malformed route param (e.g. the string "null"/"undefined" from
    // an upstream entry point carrying a null conversation_id) parses to NaN.
    // Sending call_initiate with it was silently dropped by the server, so the
    // caller rang for the full 35s no-answer timeout while the receiver never
    // rang. Bail out with a clear error instead.
    if (!Number.isFinite(conversationId) || conversationId <= 0) {
      Alert.alert(
        "Cannot start call",
        "This conversation could not be found. Open the chat and try again.",
      );
      endAndLeave(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const stream = await getMedia();
      if (cancelled) return;
      if (!stream) {
        endAndLeave(false);
        return;
      }
      // Mark that we've attempted to initiate so a pre-call_started abort can
      // send call_cancel (see endAndLeave) and stop the callee's ring.
      initiatedRef.current = true;
      const sent = cancelled
        ? false
        : await socket.sendWithBackoff(
            "call_initiate",
            {
              conversationId,
              callType,
              clientMsgId: initiateClientMsgIdRef.current,
            },
            {
              timeoutMs: 7000,
              maxAttempts: 7,
              initialBackoffMs: 140,
              maxBackoffMs: 1000,
              jitterRatio: 0.1,
              ensureConnected: true,
            },
          );
      if (!sent && !cancelled) {
        Alert.alert(
          "Connection error",
          "Could not reach the server to start the call. Check your connection and try again.",
        );
        endAndLeave(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-line react-hooks/exhaustive-deps
  }, [mode, conversationId, callType, getMedia, endAndLeave]);

  // Outgoing ring timeout: if the callee never answers within ~35s, stop
  // ringing and end the call as "No answer" (mirrors Slack/Teams/Meet). The
  // existing connectionTimeout only arms AFTER the call is accepted, so without
  // this an unanswered outgoing call rang forever with no feedback. endAndLeave
  // sends call_end when a callId is known, else call_cancel (pre-accept).
  useEffect(() => {
    if (mode !== "outgoing" || status !== "ringing") {
      if (ringTimeoutRef.current) {
        clearTimeout(ringTimeoutRef.current);
        ringTimeoutRef.current = null;
      }
      return;
    }
    ringTimeoutRef.current = setTimeout(() => {
      ringTimeoutRef.current = null;
      dispatchCall({ type: "RING_TIMEOUT" });
      Alert.alert("No answer", "The person you called didn't pick up.");
      endAndLeave(true);
    }, 35000);
    return () => {
      if (ringTimeoutRef.current) {
        clearTimeout(ringTimeoutRef.current);
        ringTimeoutRef.current = null;
      }
    };
  }, [mode, status, endAndLeave]);

  // Reconnect: REJOIN a still-active call (mirrors the web useCallState
  // refresh-rejoin). We acquire media, load ICE config, then tell the server
  // `call_reconnect` so the OTHER party re-offers; we behave as the polite
  // answerer and the existing call_signal(offer) handler does the rest. No
  // ringing, no call_initiate. Runs once on mount when launched in reconnect
  // mode (OngoingCallBanner → /call/[conversationId]?mode=reconnect).
  useEffect(() => {
    if (!isReconnect) return;
    let cancelled = false;
    (async () => {
      const stream = await getMedia();
      if (cancelled) return;
      if (!stream) {
        endAndLeave(false);
        return;
      }
      await waitForIceConfig();
      if (cancelled) return;
      const callId = callIdRef.current;
      if (!callId) {
        // Without a callId the server can't locate the active call to relay the
        // reconnect — bail back to the dashboard.
        endAndLeave(false);
        return;
      }
      // Ask the server to tell the other participant(s) to re-offer to us. The
      // peer's `call_reconnect` handler (below) creates a fresh offer; our
      // existing call_signal(offer) handler answers it and the call re-binds.
      await socket.sendWithBackoff(
        "call_reconnect",
        { callId, conversationId },
        {
          timeoutMs: 6000,
          maxAttempts: 6,
          initialBackoffMs: 140,
          maxBackoffMs: 1000,
          ensureConnected: true,
        },
      );
      // BOUNDED RECONNECT (Signal-Android parity). After announcing
      // `call_reconnect` we wait for the peer to send a FRESH offer; the
      // call_signal(offer) handler then builds the PC + answers, and
      // onconnectionstatechange arms the normal 30s connect timeout. But if the
      // peer never re-offers (they actually left, or the relay dropped the
      // reconnect), NO peer connection is ever created — so the per-PC connect
      // timeout never arms and this screen would sit on "Reconnecting…"
      // forever. Signal bounds its reconnect window and drops the call when it
      // can't re-establish. Mirror that: if we are still reconnecting (no PC
      // built) after a grace window, end cleanly instead of hanging. Cleared
      // automatically the moment a PC is created (pcRef set by createPC).
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      reconnectTimeoutRef.current = setTimeout(() => {
        if (cancelled) return;
        // A PC exists → the peer re-offered and negotiation is underway; the
        // per-PC 30s connect timeout (in createPC) now owns the deadline.
        if (pcRef.current) return;
        // The peer never re-offered — the call is effectively dead. Commit the
        // end server-side (idempotent) so the `answered` row can't keep the
        // stale "Return to call" banner alive.
        endAndLeave(true);
      }, 20000);
    })();
    return () => {
      cancelled = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReconnect]);

  // Incoming: PRE-WARM camera/mic while the phone is still ringing (mirrors
  // the web client's pre-warm path). Acquiring media only after the user taps
  // Accept added 2–5s before the offer/answer could even start — one of the
  // main reasons mobile→desktop calls took 10–20s to connect.
  useEffect(() => {
    if (mode !== "incoming") return;
    let cancelled = false;
    (async () => {
      if (localStreamRef.current) return;
      // silent: don't pop permission/availability alerts while still ringing
      // — the user may simply reject the call. acceptIncoming() retries
      // loudly if this pre-warm failed.
      const stream = await getMedia(true);
      // If the user already rejected / left while we were acquiring, release.
      if (cancelled && stream) {
        try {
          stream.getTracks().forEach((t) => t.stop());
        } catch {
          /* ignore */
        }
        localStreamRef.current = null;
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Re-acquire a DEAD/MISSING video track and republish it. On a background or
  // over-the-lock-screen answer the camera can come up as an ended/disabled
  // track (Android won't start the camera while the keyguard is up) — the
  // stream object exists but carries no LIVE video, so getMedia() returns it
  // unchanged and BOTH the local self-view AND the peer keep seeing a BLACK
  // frame even after the activity resumes. This helper (run on resume for video
  // calls) grabs a fresh camera track and replaceTrack()s it onto the existing
  // video sender — renegotiating only when no sender exists yet — then
  // re-announces our camera state. Returns true if it republished a track.
  const recoverDeadVideoTrack = useCallback(async (): Promise<boolean> => {
    if (callType !== "video" || videoOff) return false;
    const stream = localStreamRef.current;
    if (!stream) return false;
    const liveVideo = stream
      .getVideoTracks()
      .some((t) => t.readyState !== "ended" && t.enabled !== false);
    if (liveVideo) return false; // already have a usable camera track

    try {
      const fresh = await mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: usingFrontCamera ? "user" : "environment",
          width: { ideal: 1280, max: 1280 },
          height: { ideal: 720, max: 720 },
          frameRate: { ideal: 30, max: 30 },
        },
      });
      const newTrack = fresh.getVideoTracks()[0];
      if (!newTrack) return false;

      // Swap the stale/ended video track in our published stream for the fresh
      // one so the local self-view (RTCView) repaints LIVE video immediately.
      stream.getVideoTracks().forEach((t) => {
        try {
          if (t.readyState === "ended") stream.removeTrack(t);
        } catch {
          /* ignore */
        }
      });
      try {
        stream.addTrack(newTrack);
      } catch {
        /* ignore — may already be present */
      }
      setLocalStream(stream);

      const pc = pcRef.current;
      const target = peerIdRef.current;
      if (pc) {
        const senders =
          typeof pc.getSenders === "function" ? pc.getSenders() : [];
        const videoSender = senders.find((s) => s.track?.kind === "video");
        if (videoSender && typeof videoSender.replaceTrack === "function") {
          // Swap the dead track for the live one — no renegotiation needed.
          await videoSender.replaceTrack(newTrack);
        } else if (pc.signalingState === "stable") {
          // No video sender yet — add the track + renegotiate so the peer
          // starts receiving our camera.
          try {
            pc.addTrack(newTrack, stream);
          } catch {
            /* ignore */
          }
          if (target) {
            runSerialized(async () => {
              try {
                const offer = await pc.createOffer({
                  offerToReceiveAudio: true,
                  offerToReceiveVideo: true,
                });
                const local = await setLocalDescriptionWithFec(pc, offer);
                await socket.sendWithBackoff(
                  "call_signal",
                  {
                    conversationId,
                    callId: callIdRef.current,
                    targetUserId: target,
                    signal: { type: "offer", sdp: local.sdp },
                  },
                  {
                    timeoutMs: 4000,
                    maxAttempts: 5,
                    initialBackoffMs: 120,
                    maxBackoffMs: 800,
                  },
                );
              } catch (err: unknown) {
                console.warn(
                  "[call] dead-video recovery renegotiation failed:",
                  errorMessage(err),
                );
              }
            });
          }
        }
        // Re-announce camera ON so the peer flips from avatar → our live video.
        if (target) {
          socket.send("call_signal", {
            conversationId,
            callId: callIdRef.current,
            targetUserId: target,
            signal: { type: "video-state", videoOff: false },
          });
        }
      }
      return true;
    } catch (err: unknown) {
      console.warn(
        "[call] failed to recover dead video track:",
        errorMessage(err),
      );
      return false;
    }
  }, [callType, videoOff, usingFrontCamera, conversationId, runSerialized]);

  // Keep the ref current so createPC's connected handler always calls the
  // latest recovery closure (videoOff/camera state can change mid-call).
  recoverDeadVideoTrackRef.current = recoverDeadVideoTrack;

  // AppState-resume media retry. When a call is answered while the app is
  // backgrounded or over the lock screen, Android cannot show the runtime
  // permission dialog and `getUserMedia` fails — leaving a black self-view and
  // no outbound video/audio. Once the activity actually resumes to the
  // foreground we retry acquiring media so the camera/mic come up as soon as
  // possible (and re-attach the tracks to a live peer connection if one exists).
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      if (status === "ended" || status === "rejected") return;
      // If we already have a stream BUT its video track is dead (camera came up
      // behind the keyguard), recover that track instead of bailing — otherwise
      // the self-view + peer stay black. recoverDeadVideoTrack no-ops for voice
      // calls / when video is intentionally off / when a live track exists.
      if (localStreamRef.current) {
        // Invoke through the ref, not the closure: the recovery callback is
        // recreated whenever `videoOff` / the camera facing changes, and going
        // via the ref always runs the LATEST version without forcing this
        // AppState subscription to tear down and re-register on every toggle.
        void recoverDeadVideoTrackRef.current?.();
        return;
      }
      (async () => {
        const stream = await getMedia(true);
        if (!stream) return;
        // Force a re-render so the PiP/self-view RTCView remounts with the
        // freshly-acquired stream (fixes the "self-view is black" case where
        // media came up only after the activity resumed). getMedia already
        // setLocalStream(stream), but set it again defensively in case the ref
        // was populated by the ringing pre-warm without a state update.
        setLocalStream(stream);
        // If we already have a peer connection (offer/answer happened while
        // media was missing), attach the freshly-acquired tracks so the peer
        // starts receiving our audio/video without needing a fresh call.
        const pc = pcRef.current;
        if (pc) {
          try {
            // Snapshot sender count BEFORE attaching so we can detect whether
            // attachLocalTracks had to ADD a brand-new transceiver (no matching
            // recvonly transceiver existed because the PC was built track-less
            // while media was unavailable). A newly-added transceiver requires
            // RENEGOTIATION — without a fresh offer our audio/video never flows
            // and the peer keeps seeing a black frame (the "caller sees black"
            // bug on lock-screen / background answer).
            const countAttachedSenders = () =>
              typeof pc.getSenders === "function"
                ? pc.getSenders().filter((s) => s.track).length
                : 0;
            const sendersBefore = countAttachedSenders();
            await attachLocalTracks(stream);
            const sendersAfter = countAttachedSenders();
            const target = peerIdRef.current;

            const needsRenegotiation = sendersAfter > sendersBefore;
            if (
              needsRenegotiation &&
              target &&
              pc.signalingState === "stable"
            ) {
              // Create + send a fresh offer so the newly-added media m-line is
              // negotiated and the peer starts receiving our tracks.
              runSerialized(async () => {
                try {
                  const offer = await pc.createOffer({
                    offerToReceiveAudio: true,
                    offerToReceiveVideo: callType === "video",
                  });
                  const local = await setLocalDescriptionWithFec(pc, offer);
                  await socket.sendWithBackoff(
                    "call_signal",
                    {
                      conversationId,
                      callId: callIdRef.current,
                      targetUserId: target,
                      signal: { type: "offer", sdp: local.sdp },
                    },
                    {
                      timeoutMs: 4000,
                      maxAttempts: 5,
                      initialBackoffMs: 120,
                      maxBackoffMs: 800,
                    },
                  );
                } catch (err: unknown) {
                  console.warn(
                    "[call] post-resume renegotiation failed:",
                    errorMessage(err),
                  );
                }
              });
            }

            // Always re-announce our camera state so the peer flips from the
            // avatar placeholder to our live video (or vice versa) correctly.
            if (target) {
              socket.send("call_signal", {
                conversationId,
                callId: callIdRef.current,
                targetUserId: target,
                signal: { type: "video-state", videoOff },
              });
            }
          } catch (err: unknown) {
            console.warn(
              "[call] failed to attach tracks after resume:",
              errorMessage(err),
            );
          }
        }
      })();
    });
    return () => sub.remove();
  }, [
    status,
    getMedia,
    attachLocalTracks,
    conversationId,
    videoOff,
    callType,
    runSerialized,
  ]);

  // P0.4 — Reliable-delivery handshake (callee / reconnect side). The moment
  // this screen mounts AND is subscribed to `call_signal`, tell the server we
  // are listening so it (1) replays any OFFER/ICE buffered while we had no
  // socket and (2) asks the caller to (re)send its offer via `call_peer_ready`.
  // Without this, an offer the caller fired before our screen mounted
  // (push / cold-start / lock-screen answer) was dropped and the call hung on
  // "Connecting…". Only the ANSWERING side (incoming or reconnect) subscribes;
  // the caller waits for `call_peer_ready` and re-offers. Idempotent + once.
  const subscribedRef = useRef(false);
  useEffect(() => {
    // Pure outgoing caller never subscribes (it is the offerer).
    if (mode === "outgoing" && !isReconnect) return;
    if (subscribedRef.current) return;
    const callId = callIdRef.current;
    if (!callId || !Number.isFinite(conversationId)) return;
    subscribedRef.current = true;
    void socket.sendWithBackoff(
      "call_subscribe",
      { callId, conversationId },
      {
        timeoutMs: 4000,
        maxAttempts: 5,
        initialBackoffMs: 120,
        maxBackoffMs: 800,
        ensureConnected: true,
      },
    );
  }, [mode, isReconnect, conversationId]);

  // Reconnect-resilient readiness. If the WS drops mid-negotiation (a flaky
  // push / cold-start / lock-screen answer is the worst case — the "shows
  // Connecting… then drops" / "never connects" symptom), the single subscribe
  // above is not enough: a fresh offer/ICE buffered by the server while we were
  // briefly offline would never be replayed. So on EVERY socket (re)open, until
  // the call is actually connected, re-announce that we are listening (and, if
  // we have already accepted, that our PC is ready). The server replays buffered
  // signals and re-asks the caller to re-offer on each of these — idempotent via
  // Perfect Negotiation.
  useEffect(() => {
    if (mode === "outgoing" && !isReconnect) return;
    const off = socket.onOpen(() => {
      const callId = callIdRef.current;
      if (!callId || !Number.isFinite(conversationId)) return;
      const phase = statusRef.current;
      if (phase === "connected" || phase === "ended" || phase === "rejected") {
        return;
      }
      void socket.sendWithBackoff(
        "call_subscribe",
        { callId, conversationId },
        {
          timeoutMs: 4000,
          maxAttempts: 5,
          initialBackoffMs: 120,
          maxBackoffMs: 800,
          ensureConnected: true,
        },
      );
      if (acceptedRef.current) {
        void socket.sendWithBackoff(
          "call_ready",
          { callId, conversationId },
          {
            timeoutMs: 4000,
            maxAttempts: 5,
            initialBackoffMs: 120,
            maxBackoffMs: 800,
            ensureConnected: true,
          },
        );
      }
    });
    return off;
  }, [mode, isReconnect, conversationId]);

  // Signaling listener.
  useEffect(() => {
    const off = socket.subscribe((msg) => {
      const d = msg.data || {};
      switch (msg.type) {
        case "call_started":
          callIdRef.current = d.callId;
          break;
        case "call_accepted": {
          // Caller side: peer accepted → create offer to them. Runs on the
          // serialized signal queue so an early-arriving answer/ICE candidate
          // can never interleave with offer creation (the cause of silent
          // "wrong state" failures that left the call stuck on Connecting…).
          if (mode !== "outgoing") return;
          peerIdRef.current = d.userId;
          if (d.userAvatar) setPeerAvatar(String(d.userAvatar));
          dispatchCall({ type: "PEER_ACCEPTED" });
          runSerialized(async () => {
            try {
              const stream = localStreamRef.current || (await getMedia());
              if (!stream) return endAndLeave(false);
              await waitForIceConfig();
              const pc = createPC(stream, d.userId, true);
              applySenderEncodingLimits(pc);
              // CRITICAL: react-native-webrtc can emit sendonly m-lines when
              // createOffer is called with an empty options object (the offerer
              // has tracks but never asks to RECEIVE). The web/desktop answerer
              // then has nothing to answer recv on, ICE never nominates a pair,
              // and the call hangs on "Connecting…" forever — the exact
              // mobile→desktop "never connects" bug. Explicitly request
              // bidirectional media so the SDP advertises sendrecv.
              // makingOfferRef marks this offer-in-flight window so a colliding
              // inbound offer is detected as glare (see Perfect Negotiation).
              makingOfferRef.current = true;
              let offer;
              try {
                offer = await pc.createOffer({
                  offerToReceiveAudio: true,
                  offerToReceiveVideo: callType === "video",
                });
                offer = await setLocalDescriptionWithFec(pc, offer);
              } finally {
                makingOfferRef.current = false;
              }
              const offerSent = await socket.sendWithBackoff(
                "call_signal",
                {
                  conversationId,
                  callId: callIdRef.current,
                  targetUserId: d.userId,
                  signal: { type: "offer", sdp: offer.sdp },
                },
                {
                  timeoutMs: 4500,
                  maxAttempts: 5,
                  initialBackoffMs: 120,
                  maxBackoffMs: 800,
                },
              );
              if (!offerSent) {
                throw new Error("failed to deliver offer");
              }
              // Tell the peer our current camera state immediately so they
              // render avatar vs. video correctly from the start (mirrors the
              // answerer path, which already sends this).
              await socket.sendWithBackoff(
                "call_signal",
                {
                  conversationId,
                  callId: callIdRef.current,
                  targetUserId: d.userId,
                  signal: { type: "video-state", videoOff },
                },
                {
                  timeoutMs: 2200,
                  maxAttempts: 4,
                  initialBackoffMs: 100,
                  maxBackoffMs: 450,
                },
              );
            } catch (err: unknown) {
              // Fatal negotiation error — end cleanly instead of hanging.
              console.warn("[call] offer creation failed:", errorMessage(err));
              endAndLeave(false);
            }
          });
          break;
        }
        case "call_signal": {
          if (Number(d.conversationId) !== conversationId) return;
          const signal = d.signal as CallSignal;
          const from = d.fromUserId as number | undefined;
          if (from != null) peerIdRef.current = from;
          // Serialized: signals are processed strictly in arrival order so an
          // ICE candidate / answer can never race a half-finished offer
          // handler (which awaits getUserMedia + ICE config for seconds).
          runSerialized(async () => {
            if (!rememberInboundSignal(signal, seenSignalIdsRef.current)) {
              // A replayed signal is expected (the server re-delivers buffered
              // frames whenever we re-subscribe); log at `warn` so it stays
              // visible without tripping the production-noise console rule.
              console.warn("[call] ignored replayed signal:", signal.type);
              return;
            }
            let pc = pcRef.current;
            if (signal.type === "offer") {
              try {
                // If a fresh offer arrives while our PC is dead (the peer escalated
                // to a relay-only rebuild), tear ours down and rebuild in relay
                // mode too so both sides negotiate over TURN.
                if (pc) {
                  const cs = pc.connectionState;
                  const ics = pc.iceConnectionState;
                  if (
                    cs === "failed" ||
                    cs === "closed" ||
                    ics === "failed" ||
                    ics === "closed"
                  ) {
                    relayOnlyRef.current = true;
                    iceRestartAttemptedRef.current = false;
                    try {
                      pc.close();
                    } catch {
                      /* ignore */
                    }
                    pcRef.current = null;
                    pc = null;
                    // P1.4: DO NOT clear pendingIce here. Remote ICE candidates
                    // buffered before the new remote description still describe
                    // the peer's relay-only transport and remain valid for the
                    // rebuilt PC. flushIce() below drains them after the new
                    // setRemoteDescription(offer). Polite/impolite + makingOffer
                    // glare guards stay active across the rebuild.
                  }
                }
                // Callee side: build PC WITHOUT tracks, set remote, THEN attach
                // local tracks so they bind to the offer's transceivers.
                const stream = localStreamRef.current || (await getMedia());
                if (!stream) return endAndLeave(false);
                await waitForIceConfig();
                // The relay always stamps `fromUserId`; fall back to the peer
                // we already know so a malformed frame can't build a PC with an
                // undefined signaling target (which would silently never send).
                const offerFrom = from ?? peerIdRef.current;
                if (offerFrom == null) {
                  console.warn("[call] offer without a sender id — ignoring");
                  return;
                }
                pc = pcRef.current || createPC(stream, offerFrom, false);
                // Perfect Negotiation glare guard: an offer arriving while we
                // have our own offer in flight (or are mid-creation) is a
                // collision. The IMPOLITE peer (caller) ignores it and keeps
                // its own offer; the POLITE peer (callee) rolls its offer back
                // and accepts theirs. Without this, setRemoteDescription threw
                // "wrong state" and the call hung when both sides offered at
                // once (ICE-restart / post-resume renegotiation races).
                const offerCollision =
                  makingOfferRef.current || pc.signalingState !== "stable";
                if (offerCollision) {
                  if (!politeRef.current) {
                    console.warn(
                      "[call] ignoring colliding offer (impolite peer)",
                    );
                    return;
                  }
                  try {
                    // "rollback" is a valid setLocalDescription type per the
                    // WebRTC spec but is absent from react-native-webrtc's
                    // RTCSessionDescriptionInit, whose `sdp` is non-optional.
                    await pc.setLocalDescription({
                      type: "rollback",
                      sdp: "",
                    });
                  } catch {
                    /* some impls auto-rollback on setRemoteDescription(offer) */
                  }
                }
                await pc.setRemoteDescription(
                  new RTCSessionDescription({
                    type: signal.type,
                    sdp: signal.sdp ?? "",
                  }),
                );
                // Must await: tracks have to be bound to the offer's
                // transceivers BEFORE createAnswer so the answer SDP advertises
                // sendrecv media. Otherwise the peer never receives our audio/
                // video and the connection appears to "not connect".
                await attachLocalTracks(stream);
                applySenderEncodingLimits(pc);
                await flushIce();
                const answer = await pc.createAnswer();
                const localAnswer = await setLocalDescriptionWithFec(
                  pc,
                  answer,
                );
                socket.send("call_signal", {
                  conversationId,
                  callId: callIdRef.current,
                  targetUserId: from,
                  signal: { type: "answer", sdp: localAnswer.sdp },
                });
                // Tell the peer our current camera state immediately so they
                // render avatar vs. video correctly from the start.
                socket.send("call_signal", {
                  conversationId,
                  callId: callIdRef.current,
                  targetUserId: from,
                  signal: { type: "video-state", videoOff },
                });
              } catch (err: unknown) {
                forgetInboundSignal(signal, seenSignalIdsRef.current);
                // A fatal error while answering (bad SDP / wrong state) used
                // to be an unhandled rejection that left the call hanging on
                // "Connecting…" forever. End cleanly instead.
                console.warn(
                  "[call] offer handling failed:",
                  errorMessage(err),
                );
                endAndLeave(false);
              }
            } else if (signal.type === "answer") {
              if (!pc) return;
              // Ignore stray answers when we are not expecting one — avoids
              // "Failed to set remote answer sdp: Called in wrong state"
              // killing the negotiation (mirrors the web client's guard).
              if (pc.signalingState !== "have-local-offer") {
                console.warn(
                  "[call] ignoring answer in state:",
                  pc.signalingState,
                );
                return;
              }
              try {
                await pc.setRemoteDescription(
                  new RTCSessionDescription({
                    type: signal.type,
                    sdp: signal.sdp ?? "",
                  }),
                );
                await flushIce();
              } catch (err: unknown) {
                forgetInboundSignal(signal, seenSignalIdsRef.current);
                console.warn(
                  "[call] answer handling failed:",
                  errorMessage(err),
                );
              }
            } else if (signal.type === "ice-candidate") {
              const raw = signal.candidate;
              if (raw == null || typeof raw === "string") return;
              if (pc && pc.remoteDescription) {
                try {
                  await pc.addIceCandidate(new RTCIceCandidate(raw));
                } catch {
                  forgetInboundSignal(signal, seenSignalIdsRef.current);
                }
              } else {
                pendingIce.current.push(raw);
              }
            } else if (signal.type === "video-state") {
              // Peer toggled their camera. This explicit signal — not the
              // unreliable track.onmute — drives whether we show their video
              // or the avatar + black screen.
              setRemoteVideoOff(!!signal.videoOff);
            } else if (signal.type === "request-video-state") {
              // P1.10 — Black-video hardening. The peer's watchdog fired: a few
              // seconds after `connected` it still had no live remote video, so
              // it asked us to re-announce our camera state. Reply with the
              // ground truth derived from our LIVE local video track (enabled +
              // not ended) rather than a possibly-stale `videoOff` closure, so a
              // dropped/late original `video-state` self-heals.
              const tgt = from ?? peerIdRef.current;
              if (tgt) {
                const localStr = localStreamRef.current;
                const liveLocalVideo =
                  callType === "video" &&
                  !!localStr &&
                  localStr
                    .getVideoTracks()
                    .some(
                      (t) => t.readyState !== "ended" && t.enabled !== false,
                    );
                socket.send("call_signal", {
                  conversationId,
                  callId: callIdRef.current,
                  targetUserId: tgt,
                  signal: { type: "video-state", videoOff: !liveLocalVideo },
                });
              }
            } else if (signal.type === "audio-state") {
              // Peer toggled their mic — surface a mute badge (mirrors web's
              // peerMuted + remoteMuteBadge). The explicit signal is reliable
              // where track.onmute is not on react-native-webrtc.
              setPeerMuted(!!signal.muted);
            } else if (signal.type === "quality-state") {
              // Peer reported THEIR measured connection quality. Drives the
              // "<name>'s connection is unstable" banner so a freeze/stutter is
              // attributed to the correct side (Teams/Meet behaviour).
              const q = signal.quality;
              if (
                q === "good" ||
                q === "fair" ||
                q === "poor" ||
                q === "unknown"
              ) {
                setPeerQuality(q);
              }
            }
          });
          break;
        }
        case "call_reconnect": {
          // The OTHER party rejoined the call (their app/page came back). The
          // server asks US to re-offer so their fresh session re-binds media.
          // Mirrors the web useWebRTC `reconnectTo` effect: close the stale PC
          // and create + send a brand-new offer to the reconnecting peer. Our
          // existing call_signal(answer/ice) handlers complete the handshake.
          if (Number(d.conversationId) !== conversationId) break;
          const targetUserId = Number(d.userId);
          if (!targetUserId) break;
          peerIdRef.current = targetUserId;
          runSerialized(async () => {
            try {
              const stream = localStreamRef.current || (await getMedia());
              if (!stream) return;
              await waitForIceConfig();
              // Tear down the stale peer connection — the reconnecting side has
              // a brand-new PeerConnection, so ours must be rebuilt to match.
              try {
                pcRef.current?.close();
              } catch {
                /* ignore */
              }
              pcRef.current = null;
              // Reset recovery flags for the fresh negotiation.
              iceRestartAttemptedRef.current = false;
              negotiationDoneRef.current = false;
              dispatchCall({ type: "PEER_RECONNECT" });
              const pc = createPC(stream, targetUserId, true);
              applySenderEncodingLimits(pc);
              makingOfferRef.current = true;
              let offer;
              try {
                offer = await pc.createOffer({
                  offerToReceiveAudio: true,
                  offerToReceiveVideo: callType === "video",
                });
                offer = await setLocalDescriptionWithFec(pc, offer);
              } finally {
                makingOfferRef.current = false;
              }
              await socket.sendWithBackoff(
                "call_signal",
                {
                  conversationId,
                  callId: callIdRef.current,
                  targetUserId,
                  signal: { type: "offer", sdp: offer.sdp },
                },
                {
                  timeoutMs: 4500,
                  maxAttempts: 5,
                  initialBackoffMs: 120,
                  maxBackoffMs: 800,
                },
              );
              // Re-announce our camera state so the reconnecting peer renders
              // avatar vs. video correctly from the first frame.
              socket.send("call_signal", {
                conversationId,
                callId: callIdRef.current,
                targetUserId,
                signal: { type: "video-state", videoOff },
              });
            } catch (err: unknown) {
              console.warn(
                "[call] reconnect re-offer failed:",
                errorMessage(err),
              );
            }
          });
          break;
        }
        case "call_peer_ready": {
          // P0.4 — the OTHER party's call screen has mounted + subscribed (or
          // signalled ready). The server asks US, the CALLER, to (re)send our
          // offer so a cross-instance / never-buffered offer is (re)delivered
          // the moment the callee is actually listening. This is the core fix
          // for "answered but never connects": the caller fires its offer the
          // instant `call_accepted` arrives, but the callee's screen needs
          // 1–5s to mount + subscribe (push/cold-start/lock-screen answer).
          // Re-sending is idempotent via Perfect Negotiation (the callee is
          // POLITE and rolls back on a glare), so a duplicate is harmless.
          if (Number(d.conversationId) !== conversationId) break;
          if (
            d.callId != null &&
            callIdRef.current != null &&
            Number(d.callId) !== callIdRef.current
          ) {
            break;
          }
          // Only the CALLER re-offers. The callee waits for the offer.
          if (mode !== "outgoing") break;
          const pc = pcRef.current;
          const target = peerIdRef.current;
          if (pc && target && pc.localDescription?.type === "offer") {
            socket.send("call_signal", {
              conversationId,
              callId: callIdRef.current,
              targetUserId: target,
              signal: {
                type: "offer",
                sdp: pc.localDescription.sdp,
              },
            });
          }
          break;
        }
        case "call_reaction": {
          if (Number(d.conversationId) !== conversationId) return;
          if (!d.emoji) break;
          const id = Date.now() + Math.random();
          setFloatingReactions((prev) => [
            ...prev,
            { id, emoji: String(d.emoji), fromSelf: false },
          ]);
          setTimeout(
            () =>
              setFloatingReactions((prev) => prev.filter((r) => r.id !== id)),
            2500,
          );
          break;
        }
        case "chat_message": {
          if (Number(d.conversationId) !== conversationId) return;
          // Ignore system rows (e.g. the inline call-history event the server
          // emits as the call tears down) — they belong in the chat thread, not
          // the in-call chat panel.
          if (d.formatType === "system" || d.format_type === "system") break;
          const msgId =
            d.id ?? d.clientMsgId ?? `${Date.now()}-${Math.random()}`;
          setCallMessages((prev) => {
            if (prev.some((m) => String(m.id) === String(msgId))) return prev;
            return [
              ...prev,
              {
                id: msgId,
                senderId: d.senderId,
                senderName: d.senderName,
                content: d.content,
                createdAt: d.createdAt,
              },
            ];
          });
          if (Number(d.senderId) !== Number(peerIdRef.current)) break;
          if (!showChat) setChatUnread((c) => c + 1);
          break;
        }
        case "call_ended":
          if (Number(d.conversationId) === conversationId) {
            dispatchCall({ type: "REMOTE_ENDED" });
            endAndLeave(false);
          }
          break;
        case "call_rejected":
          if (Number(d.conversationId) === conversationId) {
            dispatchCall({ type: "REMOTE_REJECTED" });
            setTimeout(() => endAndLeave(false), 800);
          }
          break;
        case "call_error":
          // Server NACK for our call_initiate (invalid payload / we are not a
          // participant of this conversation). Without this the screen sat on
          // "Ringing…" until the 35s no-answer timeout even though the server
          // never rang anyone.
          if (
            mode === "outgoing" &&
            (d.conversationId == null ||
              Number(d.conversationId) === conversationId)
          ) {
            Alert.alert(
              "Call failed",
              d.reason === "not_participant"
                ? "You are no longer a member of this conversation."
                : "The call could not be started. Please try again.",
            );
            endAndLeave(false);
          }
          break;
        case "call_busy":
          // P0.3 — the 1:1 callee is already on another call. The server
          // refused to ring them; tell the user and tear down our outgoing
          // call.
          if (Number(d.conversationId) === conversationId) {
            dispatchCall({ type: "REMOTE_BUSY" });
            Alert.alert("On another call", `${peerName} is on another call.`);
            endAndLeave(false);
          }
          break;
        case "call_handled_elsewhere":
          // The user answered/rejected this call on ANOTHER device (web/
          // desktop), so dismiss this still-ringing incoming screen.
          //
          // CRITICAL: the server also echoes this event back to the very
          // session that accepted/rejected (so a multi-device user's OTHER
          // devices stop ringing). If THIS session is the one that accepted
          // (acceptedRef = true), we must NOT tear the call down — otherwise
          // the device that just accepted immediately ends the call it is
          // trying to join (the "call crashes right after accept" bug). The
          // web client avoids this by handling the echo only in the global
          // incoming-call PiP (CallContext), not the active CallOverlay.
          if (acceptedRef.current) break;
          if (
            Number(d.conversationId) === conversationId ||
            (d.callId != null && d.callId === callIdRef.current)
          ) {
            endAndLeave(false);
          }
          break;
      }
    });
    return off;
  }, [
    mode,
    conversationId,
    getMedia,
    createPC,
    attachLocalTracks,
    applySenderEncodingLimits,
    flushIce,
    endAndLeave,
    waitForIceConfig,
    videoOff,
    runSerialized,
    showChat,
    // Route-derived constants for this screen's lifetime; listed so the
    // handlers that read them (`createOffer`'s offerToReceiveVideo, the
    // busy-call alert) can never close over a stale value.
    callType,
    peerName,
  ]);

  // ── Active-call foreground service (Signal ActiveCallManager model) ─────────
  // While the call is connecting/connected we run an ongoing-call foreground
  // service (FOREGROUND_SERVICE_TYPE_MICROPHONE [+ CAMERA for video]) so the OS
  // keeps the process at foreground priority for the call's lifetime. Without
  // it Android can doze/throttle the app mid-call (especially when the screen
  // is interacted with or briefly backgrounded), which surfaces as stutter,
  // lag and freezes. Stopped on teardown (endAndLeave) and on unmount below.
  // No-op on iOS / Expo Go / non-prebuilt builds.
  useEffect(() => {
    if (status === "connecting" || status === "connected") {
      startActiveCall({
        callType,
        title: peerName,
        body:
          callType === "video" ? "Ongoing video call" : "Ongoing voice call",
        scheme: "aino",
      });
    } else {
      stopActiveCall();
    }
    // `callType` and `peerName` are derived once from the route params and are
    // constant for this screen's lifetime, so they are listed here purely to
    // satisfy the exhaustive-deps rule — they never actually retrigger the
    // effect (which would restart the foreground service mid-call).
  }, [status, callType, peerName]);

  // Always release the active-call foreground service on unmount so a stale
  // ongoing-call notification can never linger after the screen is gone.
  useEffect(() => {
    return () => {
      stopActiveCall();
    };
  }, []);

  // ── Picture-in-Picture (Signal-Android parity) ──────────────────────────────
  // Subscribe to OS PiP-mode changes for the whole call lifetime so the layout
  // collapses to video/avatar-only when shrunk and restores when expanded.
  // No-op on iOS / Expo Go / non-prebuilt builds.
  useEffect(() => {
    const off = addPipModeListener((inPip) => {
      setIsInPip(inPip);
      // Entering PiP should always collapse transient UI so the floating tile
      // never shows controls/modals; they stay closed when expanded again.
      if (inPip) {
        setShowMore(false);
        setShowReactionPicker(false);
        setShowChat(false);
      }
    });
    return off;
  }, []);

  // Arm/disarm native PiP based on call phase. While the call is live
  // (connecting/connected — BOTH video AND voice) we mark the call active so the
  // injected onUserLeaveHint enters PiP on API 26–30, AND enable seamless
  // auto-enter on API 31+. The aspect ratio is 9:16 for video (matches a phone
  // camera frame) and 1:1 for voice (a compact square tile for the avatar). The
  // flag is cleared the moment the call is no longer live (and on unmount below)
  // so leaving the app afterwards behaves normally — no stray PiP.
  useEffect(() => {
    if (!isPipSupported()) return;
    const live = status === "connecting" || status === "connected";
    const aspectW = callType === "video" ? 9 : 1;
    const aspectH = callType === "video" ? 16 : 1;
    setPipCallActive(live);
    setPipAutoEnter(live, aspectW, aspectH);
  }, [status, callType]);

  // Clear the PiP active flag + auto-enter on unmount so a leave-app after the
  // call screen is gone never shrinks an unrelated screen into PiP.
  useEffect(() => {
    return () => {
      setPipCallActive(false);
      setPipAutoEnter(false);
    };
  }, []);

  // ── Connection-quality monitor via getStats() ──────────────────────────────
  // Samples every 2s (was 3s: a 3s loop reacts to a freeze about a second after
  // the user has already seen it) and hands the RAW CUMULATIVE counters to the
  // shared controller, which differences them, smooths them, grades RTT against
  // the learned path baseline, and returns at most a ONE-RUNG ladder move. We
  // only touch the encoder when `decision.changed` — the old loop re-derived a
  // target on every tick and thrashed `setParameters` between three fixed
  // bitrate/resolution pairs, which is what produced the periodic freeze pulses.
  useEffect(() => {
    if (status !== "connected") {
      setConnectionQuality("unknown");
      return;
    }
    let lastQuality: CallQuality = "unknown";
    const interval = setInterval(async () => {
      const pc = pcRef.current;
      if (!pc || typeof pc.getStats !== "function") return;
      try {
        // `getStats()` is declared as `Promise<any>` by react-native-webrtc;
        // `collectStatsSample` only needs the `forEach` iteration contract.
        const stats: { forEach: (cb: (report: object) => void) => void } =
          await pc.getStats();
        const sample = collectStatsSample(stats);
        const decision = getQualityController().observe(sample);

        // Voice calls have no video sender, so the tier write is a no-op there.
        if (callType === "video" && decision.changed) {
          void applyVideoEncodingTier(
            pc as unknown as PeerConnectionLike,
            decision.tier,
          );
        }

        const q = decision.quality;
        if (q !== lastQuality) {
          lastQuality = q;
          setConnectionQuality(q);
        }
        // Tell the peer OUR measured quality so THEY can surface a
        // "<name>'s connection is unstable" banner — exactly how Teams/Meet
        // attribute a freeze to the right side. Only emit on a real change so
        // we don't spam the relay.
        if (q !== "unknown" && lastSentQualityRef.current !== q) {
          lastSentQualityRef.current = q;
          const target = peerIdRef.current;
          if (target) {
            socket.send("call_signal", {
              conversationId,
              callId: callIdRef.current,
              targetUserId: target,
              signal: { type: "quality-state", quality: q },
            });
          }
        }
      } catch {
        /* stats unavailable this tick */
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [status, conversationId, callType, getQualityController]);

  // Incoming: accept handler. Send call_accept IMMEDIATELY (don't serialize
  // behind getUserMedia) — the caller starts building its offer right away
  // while we finish acquiring media in parallel. Combined with the ringing
  // pre-warm above this shaves seconds off the connect time.
  const acceptIncoming = useCallback(async () => {
    // Mark THIS session as the accepter so the `call_handled_elsewhere` echo
    // the server sends back to our own user (to dismiss our OTHER devices'
    // ring UI) does not tear down the call we are about to join.
    acceptedRef.current = true;
    dispatchCall({ type: "ACCEPT" });
    const sent = await socket.sendCallActionWithRetry(
      "accept",
      {
        callId: callIdRef.current,
        conversationId,
      },
      { timeoutMs: 4000, retryEveryMs: 150 },
    );
    // If the realtime channel could not deliver the accept (slow/unavailable
    // WS — common right after a cold/lock-screen/background launch, when the
    // socket is still reconnecting), fall back to the idempotent HTTP endpoint
    // so the call is ALWAYS accepted server-side (mirrors rejectIncoming's HTTP
    // fallback). Only abort with the error alert when BOTH transports fail.
    if (!sent) {
      let httpOk = false;
      if (callIdRef.current) {
        try {
          await acceptCallHttp(callIdRef.current, conversationId);
          httpOk = true;
        } catch (err: unknown) {
          console.warn(
            "[call] HTTP accept fallback failed:",
            errorMessage(err),
          );
        }
      }
      if (!httpOk) {
        Alert.alert(
          "Connection error",
          "Could not accept this call because realtime connection is unavailable.",
        );
        return endAndLeave(false);
      }
    }
    if (!localStreamRef.current) {
      const stream = await getMedia();
      if (!stream) return endAndLeave(false);
    }
    // P0.4 — now that media is acquired and our PC will be built when the offer
    // arrives, tell the server we are READY to receive it so the caller
    // (re)sends its offer immediately via `call_peer_ready` (idempotent via
    // Perfect Negotiation). This closes the window where the caller fired its
    // offer before we were listening (push/cold-start/lock-screen answer).
    void socket.sendWithBackoff(
      "call_ready",
      { callId: callIdRef.current, conversationId },
      {
        timeoutMs: 4000,
        maxAttempts: 5,
        initialBackoffMs: 120,
        maxBackoffMs: 800,
        ensureConnected: true,
      },
    );
    // The caller will now send us an offer (handled in call_signal).
    //
    // P0.5 — Callee auto re-offer recovery. The `call_ready` above asks the
    // caller to (re)send its offer via `call_peer_ready`. If BOTH the caller's
    // original offer AND that re-offer fail to land (caller was cross-instance /
    // briefly offline, or both signals were dropped), no offer ever arrives, no
    // PC is built, and this screen would hang on "Connecting…" forever. Arm a
    // short grace timer: if `pcRef.current` is still null after ~4s, request a
    // FRESH offer via `call_reconnect` (the server relays it to the caller, who
    // re-offers — see their `call_reconnect` handler). The timer is cleared the
    // instant a PC is created (createPC) so it only fires on the stuck path.
    if (acceptReofferTimeoutRef.current) {
      clearTimeout(acceptReofferTimeoutRef.current);
    }
    acceptReofferTimeoutRef.current = setTimeout(() => {
      acceptReofferTimeoutRef.current = null;
      // A PC already exists → the offer arrived and negotiation is underway;
      // the per-PC 30s connect timeout owns the deadline from here.
      if (pcRef.current) return;
      const callId = callIdRef.current;
      if (!callId || !Number.isFinite(conversationId)) return;
      void socket.sendWithBackoff(
        "call_reconnect",
        { callId, conversationId },
        {
          timeoutMs: 4000,
          maxAttempts: 5,
          initialBackoffMs: 120,
          maxBackoffMs: 800,
          ensureConnected: true,
        },
      );
    }, 4000);
  }, [conversationId, endAndLeave, getMedia]);

  const rejectIncoming = useCallback(async () => {
    const sent = await socket.sendCallActionWithRetry(
      "reject",
      { callId: callIdRef.current, conversationId },
      { timeoutMs: 2000, retryEveryMs: 120 },
    );
    // If the realtime channel could not deliver the reject (slow/unavailable
    // WS — common right after a cold/lock-screen launch), fall back to the HTTP
    // endpoint so the caller ALWAYS stops ringing (fixes "declined but the
    // caller screen keeps ringing").
    if (!sent && callIdRef.current) {
      try {
        await rejectCallHttp(callIdRef.current, conversationId);
      } catch (err: unknown) {
        console.warn("[call] HTTP reject fallback failed:", errorMessage(err));
      }
    }
    endAndLeave(false);
  }, [conversationId, endAndLeave]);

  useEffect(() => {
    if (mode !== "incoming" || !autoAnswer || status !== "ringing") return;
    // The notification tap that carried autoAnswer=1 may ALSO have recorded
    // the choice in the native PendingCallActionStore (60s TTL). Clear it now
    // that the params-path is handling the answer — otherwise a NEW call in
    // the same conversation within that window would be silently auto-answered
    // by the killed-state safety net below.
    try {
      clearPendingCallAction();
    } catch {
      /* best-effort */
    }
    acceptIncoming().catch(() => {});
  }, [acceptIncoming, autoAnswer, mode, status]);

  // Answer-intent bridge. When the user taps "Answer" on the status-bar /
  // full-screen call notification while THIS call screen is ALREADY mounted in
  // the ringing state (the websocket IncomingCallListener pushed it on
  // `call_incoming`), the notification handler can't navigate — the screen is
  // already up. Instead nativeCallService.handleAction("answer") emits an
  // answer intent which we consume here to actually run acceptIncoming(). This
  // is what fixes "tapping Answer just shows the ringing UI and never connects".
  // We also synchronously consume any latched intent on mount in case it was
  // emitted in the tick before this subscription wired up.
  useEffect(() => {
    if (mode !== "incoming") return;
    const callId = callIdRef.current;
    if (callId == null || !Number.isFinite(conversationId)) return;
    // Belt-and-suspenders: pick up an intent emitted just before subscribe.
    if (consumeAnswerIntent(callId, conversationId)) {
      acceptIncoming().catch(() => {});
    }
    const unsub = subscribeAnswerIntent(callId, conversationId, () => {
      // Only accept while still ringing — ignore a late intent after the call
      // has already moved on (connecting/connected/ended).
      if (status === "ringing") acceptIncoming().catch(() => {});
    });
    return unsub;
    // status is intentionally read inside the callback (not a dep) so the
    // subscription is stable for the call's lifetime; callIdRef is a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, conversationId, acceptIncoming]);

  // Clear any latched answer intent on unmount so it can't auto-accept a future
  // unrelated call screen that happens to mount afterwards.
  useEffect(() => {
    return () => {
      clearAnswerIntent();
    };
  }, []);

  // Auto-decline when launched from the notification's "Decline" action.
  useEffect(() => {
    if (mode !== "incoming" || !autoDecline || status !== "ringing") return;
    // Mirror the autoAnswer path: clear the native pending action so a stale
    // decline can never affect a later unrelated call in this conversation.
    try {
      clearPendingCallAction();
    } catch {
      /* best-effort */
    }
    rejectIncoming().catch(() => {});
  }, [autoDecline, mode, rejectIncoming, status]);

  // KILLED-STATE ANSWER/DECLINE SAFETY NET. When the user taps Answer/Decline
  // on the native CallStyle notification while the app is KILLED, the choice is
  // recorded natively (PendingCallActionStore) but the deep link carrying
  // `autoAnswer=1` / `action=decline` can be LOST on the cold start (expo-router
  // isn't mounted yet). If the cold-start routing then reaches this screen via a
  // fallback path — the SecureStore route persisted at RING time (autoAnswer=0),
  // the websocket re-delivering `call_incoming`, or PendingCallNavigator — the
  // screen mounts in plain RINGING mode and the user is forced to answer a
  // SECOND time. Consume the native action here on mount: if it matches THIS
  // call, apply it (accept/reject) and clear it so a stale tap can never affect
  // a later unrelated call (the store also has a 60s native TTL).
  useEffect(() => {
    if (mode !== "incoming" || status !== "ringing") return;
    // The route params already carry the action → the effects above handle it.
    if (autoAnswer || autoDecline) return;
    try {
      const nativeAction = getPendingCallAction();
      if (!nativeAction) return;
      const callId = callIdRef.current;
      if (
        String(nativeAction.conversationId) !== String(conversationId) ||
        (callId != null && String(nativeAction.callId) !== String(callId))
      ) {
        return;
      }
      clearPendingCallAction();
      if (nativeAction.action === "answer") {
        acceptIncoming().catch(() => {});
      } else if (nativeAction.action === "decline") {
        rejectIncoming().catch(() => {});
      }
    } catch {
      // best-effort — the user can still answer manually from the ringing UI
    }
    // Run once when the screen reaches the ringing state; acceptIncoming/
    // rejectIncoming are stable callbacks and callIdRef is a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, status, autoAnswer, autoDecline, conversationId]);

  const {
    toggleMute,
    toggleVideo,
    switchCamera,
    toggleHold,
    toggleNoiseSuppression,
    toggleRecording,
    toggleSpeaker,
    sendReaction,
    sendChat,
    toggleChatPanel,
    openChatPanel,
    closeChatPanel,
    openMorePanel,
    closeMorePanel,
    openReactionPickerFromMore,
    closeReactionPicker,
  } = useMobileCallControls({
    conversationId,
    callType,
    chatText,
    noiseSuppressionEnabled,
    muted,
    videoOff,
    onHold,
    localStreamRef,
    peerIdRef,
    callIdRef,
    holdSnapshotRef,
    sendSocket: socket.send,
    // Retrying sender for must-deliver state signals (video/audio state and
    // reactions). `sendWithRetry` reconnects + re-sends if the socket was
    // momentarily down, so a camera-off never leaves a frozen frame on the peer
    // and reactions reliably reach the other screen.
    sendSocketReliable: (event, payload) =>
      socket.sendWithRetry(event, payload, {
        timeoutMs: 4000,
        retryEveryMs: 200,
        ensureConnected: true,
      }),
    setOnHold,
    setMuted,
    setVideoOff,
    setUsingFrontCamera,
    setNoiseSuppressionEnabled,
    setRecording,
    setSpeakerOn,
    setFloatingReactions,
    setShowReactionPicker,
    setShowMore,
    setChatText,
    setShowChat,
    setChatUnread,
  });

  const statusLabel =
    status === "ringing"
      ? mode === "incoming"
        ? "Incoming call…"
        : "Ringing…"
      : status === "connecting"
        ? "Connecting…"
        : status === "reconnecting"
          ? "Reconnecting…"
          : status === "connected"
            ? "Connected"
            : status === "rejected"
              ? "Call declined"
              : "Call ended";

  const showVideo = callType === "video";
  // Only paint the remote video when the peer actually has their camera on AND
  // a live video track is present. Relying on `!remoteVideoOff` alone meant a
  // missed/late `video-state` signal left us painting a black RTCView with no
  // avatar (the "avatar not visible when camera off" bug). Requiring a live
  // track makes the avatar the reliable fallback.
  const hasLiveRemoteVideo =
    !!remoteStream &&
    remoteStream.getVideoTracks().some((t) => t.readyState !== "ended");
  const showRemoteVideo = showVideo && hasLiveRemoteVideo && !remoteVideoOff;

  // WhatsApp-style video UX (BOTH outgoing AND incoming): before the call is
  // connected with the peer's video, show OUR OWN camera FULL-SCREEN behind the
  // peer name + status (Ringing…/Connecting…) and the call controls. The moment
  // the peer's remote video arrives on the main stage (showRemoteVideo), the
  // SAME local stream object is reused so the self-view seamlessly shrinks into
  // the PiP corner and the peer's video takes the main screen — no camera
  // flicker, no re-acquire.
  //   • Outgoing: as soon as we initiate, the pre-acquired camera fills the
  //     screen while it rings, exactly like WhatsApp. On connect it drops to PiP.
  //   • Incoming: the pre-warmed camera fills the screen while ringing, then
  //     drops to PiP on answer.
  // Require a LIVE local video track (not just a stream object). On a
  // background/lock-screen answer the stream can exist while its camera track
  // is still ended/not-yet-acquired — rendering that produced a BLACK self-view
  // tile. Gating on a live track makes us fall back to the avatar/no-tile until
  // real video frames are available (mirrors the hasLiveRemoteVideo guard).
  const hasLiveLocalVideo =
    !!localStream &&
    localStream
      .getVideoTracks()
      .some((t) => t.readyState !== "ended" && t.enabled !== false);
  const showFullScreenSelfPreview =
    showVideo &&
    hasLiveLocalVideo &&
    !videoOff &&
    // Only while the peer's video is NOT yet on the main stage — once it is, the
    // self-view remaps to the PiP corner (peer video takes the main screen).
    !showRemoteVideo &&
    // Pre-connected phases only (covers BOTH outgoing ringing AND incoming
    // ringing, plus the brief connecting window before remote frames arrive).
    (status === "ringing" || status === "connecting");
  // The small PiP self-view is shown for the connecting/connected phases (NOT
  // while ringing, where the self-view is full-screen instead).
  const showPipSelfPreview =
    showVideo && hasLiveLocalVideo && !videoOff && !showFullScreenSelfPreview;

  // (Call-duration formatting now lives inside the isolated <CallDuration />
  // component so the per-second tick never re-renders this screen.)

  // Memoize the stream URLs so toURL() is only called when the underlying stream
  // OBJECT changes — not on every re-render. A fresh toURL() string each render
  // would make the (now memoized) RTCView components see a new prop and reattach
  // their native surface (the flicker/freeze cause). Mirrors Signal binding a
  // track to a renderer once rather than recomputing a handle per frame.
  const remoteURL = useMemo(
    () => remoteStream?.toURL() ?? null,
    [remoteStream],
  );
  const localURL = useMemo(() => localStream?.toURL() ?? null, [localStream]);

  const qualityColor =
    connectionQuality === "good"
      ? "#22c55e"
      : connectionQuality === "fair"
        ? "#f59e0b"
        : connectionQuality === "poor"
          ? "#ef4444"
          : "rgba(255,255,255,0.5)";
  const qualityLabel =
    connectionQuality === "good"
      ? "Good"
      : connectionQuality === "fair"
        ? "Fair"
        : connectionQuality === "poor"
          ? "Poor"
          : "…";
  const peerAvatarUrl =
    peerAvatar && peerAvatar.startsWith("http")
      ? peerAvatar
      : peerAvatar
        ? `${SERVER_ORIGIN}${peerAvatar.startsWith("/") ? "" : "/"}${peerAvatar}`
        : null;

  // ── Auto-hide call chrome after 4s idle (WhatsApp/Signal + web parity) ─────
  const CONTROLS_IDLE_MS = 4000;
  // Show the chrome and (re)arm the 4s idle timer. Only auto-hides while the
  // call is CONNECTED and not in PiP — during ringing/incoming the controls
  // must always stay visible so the user can accept/decline/hang up.
  const resetControlsTimer = useCallback(() => {
    setControlsVisible(true);
    if (controlsHideTimerRef.current) {
      clearTimeout(controlsHideTimerRef.current);
      controlsHideTimerRef.current = null;
    }
    if (status === "connected" && !isInPip) {
      controlsHideTimerRef.current = setTimeout(() => {
        setControlsVisible(false);
      }, CONTROLS_IDLE_MS);
    }
  }, [status, isInPip]);

  // Tap anywhere on the call surface toggles the chrome: if it's currently
  // visible, hide it immediately; otherwise show it and re-arm the idle timer.
  const handleSurfaceTap = useCallback(() => {
    if (status !== "connected" || isInPip) return;
    if (controlsVisible) {
      if (controlsHideTimerRef.current) {
        clearTimeout(controlsHideTimerRef.current);
        controlsHideTimerRef.current = null;
      }
      setControlsVisible(false);
    } else {
      resetControlsTimer();
    }
  }, [status, isInPip, controlsVisible, resetControlsTimer]);

  // Arm the idle timer when the call becomes connected; keep the chrome always
  // visible (and the timer cleared) in every other phase and while in PiP.
  useEffect(() => {
    if (status === "connected" && !isInPip) {
      setControlsVisible(true);
      if (controlsHideTimerRef.current) {
        clearTimeout(controlsHideTimerRef.current);
      }
      controlsHideTimerRef.current = setTimeout(() => {
        setControlsVisible(false);
      }, CONTROLS_IDLE_MS);
    } else {
      setControlsVisible(true);
      if (controlsHideTimerRef.current) {
        clearTimeout(controlsHideTimerRef.current);
        controlsHideTimerRef.current = null;
      }
    }
    return () => {
      if (controlsHideTimerRef.current) {
        clearTimeout(controlsHideTimerRef.current);
        controlsHideTimerRef.current = null;
      }
    };
  }, [status, isInPip]);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Tap-to-toggle surface: a transparent full-screen layer BEHIND the
          overlay chrome that captures taps on empty areas of the call to
          show/hide the controls (WhatsApp/Signal style). Only active while the
          call is connected and not in PiP. */}
      {status === "connected" && !isInPip ? (
        <Pressable style={styles.tapToToggleLayer} onPress={handleSurfaceTap} />
      ) : null}

      <CallMediaStage
        styles={styles}
        isInPip={isInPip}
        showRemoteVideo={showRemoteVideo}
        remoteURL={remoteURL}
        showFullScreenSelfPreview={showFullScreenSelfPreview}
        localURL={localURL}
        usingFrontCamera={usingFrontCamera}
        peerAvatarUrl={peerAvatarUrl}
        peerName={peerName}
        showPipSelfPreview={showPipSelfPreview}
        insets={insets}
        status={status}
        statusLabel={statusLabel}
      />

      <CallScreenOverlay
        styles={styles}
        insets={insets}
        isInPip={isInPip}
        controlsVisible={controlsVisible}
        status={status}
        mode={mode}
        statusLabel={statusLabel}
        peerName={peerName}
        peerId={peerIdRef.current ? Number(peerIdRef.current) : null}
        showVideo={showVideo}
        callType={callType}
        muted={muted}
        videoOff={videoOff}
        speakerOn={speakerOn}
        onHold={onHold}
        showChat={showChat}
        showMore={showMore}
        chatUnread={chatUnread}
        noiseSuppressionEnabled={noiseSuppressionEnabled}
        recording={recording}
        peerMuted={peerMuted}
        peerQuality={peerQuality}
        qualityColor={qualityColor}
        qualityLabel={qualityLabel}
        floatingReactions={floatingReactions}
        showReactionPicker={showReactionPicker}
        callMessages={callMessages}
        chatText={chatText}
        onChangeChatText={setChatText}
        onRejectIncoming={rejectIncoming}
        onAcceptIncoming={acceptIncoming}
        onToggleMute={toggleMute}
        onToggleVideo={toggleVideo}
        onSwitchCamera={switchCamera}
        onToggleSpeaker={toggleSpeaker}
        onToggleHold={toggleHold}
        onOpenMore={openMorePanel}
        onCloseMore={closeMorePanel}
        onToggleChat={toggleChatPanel}
        onOpenChat={openChatPanel}
        onCloseChat={closeChatPanel}
        onOpenReactionPicker={openReactionPickerFromMore}
        onCloseReactionPicker={closeReactionPicker}
        isGroupCall={isGroupCall}
        onAddParticipant={() => {
          setShowMore(false);
          setShowAddParticipant(true);
        }}
        onToggleNoiseSuppression={toggleNoiseSuppression}
        onToggleRecording={toggleRecording}
        onSendReaction={sendReaction}
        onSendChat={sendChat}
        onEndCall={() => endAndLeave(true)}
        CallDurationComponent={CallDuration}
      />
      <Modal
        visible={showAddParticipant}
        transparent
        animationType="slide"
        onRequestClose={() => setShowAddParticipant(false)}
      >
        <Pressable
          style={{
            flex: 1,
            backgroundColor: "rgba(0,0,0,0.5)",
            justifyContent: "flex-end",
          }}
          onPress={() => setShowAddParticipant(false)}
        >
          <Pressable
            style={{
              backgroundColor: theme.bgElevated || theme.surface || "#111827",
              borderTopLeftRadius: 18,
              borderTopRightRadius: 18,
              padding: 16,
              maxHeight: "72%",
            }}
            onPress={(e) => e.stopPropagation()}
          >
            <Text
              style={{
                color: theme.text,
                fontSize: 17,
                fontFamily: theme.fontBold,
                marginBottom: 12,
              }}
            >
              Add participant
            </Text>
            <View
              style={{
                borderWidth: 1,
                borderColor: theme.glassBorder || theme.border,
                borderRadius: 12,
                paddingHorizontal: 12,
                paddingVertical: 6,
                marginBottom: 10,
              }}
            >
              <TextInput
                value={addParticipantQuery}
                onChangeText={(val) => {
                  setAddParticipantQuery(val);
                  if (addParticipantTimerRef.current) {
                    clearTimeout(addParticipantTimerRef.current);
                  }
                  if (val.trim().length < 2) {
                    setAddParticipantResults([]);
                    setAddParticipantSearching(false);
                    return;
                  }
                  addParticipantTimerRef.current = setTimeout(async () => {
                    setAddParticipantSearching(true);
                    try {
                      const r = await searchChatUsers(val.trim());
                      const selfId = Number(user?.id || 0);
                      const currentPeerId = Number(peerIdRef.current || 0);
                      const rows = (r.data || []).filter((u) => {
                        const uid = Number(u.id);
                        return (
                          uid > 0 && uid !== selfId && uid !== currentPeerId
                        );
                      });
                      setAddParticipantResults(rows);
                    } catch {
                      setAddParticipantResults([]);
                    } finally {
                      setAddParticipantSearching(false);
                    }
                  }, 300);
                }}
                placeholder="Search people…"
                placeholderTextColor={theme.textMuted}
                style={{ color: theme.text, fontSize: 15 }}
              />
            </View>
            {addParticipantSearching ? (
              <View style={{ paddingVertical: 14, alignItems: "center" }}>
                <ActivityIndicator color={theme.primary} />
              </View>
            ) : null}
            <ScrollView>
              {addParticipantResults.map((u) => (
                <Pressable
                  key={String(u.id)}
                  style={{
                    paddingVertical: 12,
                    borderBottomWidth: 1,
                    borderBottomColor: theme.border,
                  }}
                  onPress={() => {
                    if (!callIdRef.current) {
                      Alert.alert(
                        "Can't add participant",
                        "The call is not connected yet.",
                      );
                      return;
                    }
                    socket.send("call_add_participant", {
                      callId: callIdRef.current,
                      conversationId,
                      targetUserId: Number(u.id),
                    });
                    setShowAddParticipant(false);
                    setAddParticipantQuery("");
                    setAddParticipantResults([]);
                  }}
                >
                  <Text
                    style={{
                      color: theme.text,
                      fontSize: 15,
                      fontFamily: theme.fontMedium,
                    }}
                  >
                    {u.full_name || u.username || "User"}
                  </Text>
                  {u.username ? (
                    <Text style={{ color: theme.textMuted, fontSize: 12 }}>
                      @{u.username}
                    </Text>
                  ) : null}
                </Pressable>
              ))}
              {!addParticipantSearching &&
              addParticipantQuery.trim().length >= 2 &&
              addParticipantResults.length === 0 ? (
                <Text
                  style={{
                    color: theme.textMuted,
                    textAlign: "center",
                    paddingVertical: 16,
                  }}
                >
                  No matching users
                </Text>
              ) : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
