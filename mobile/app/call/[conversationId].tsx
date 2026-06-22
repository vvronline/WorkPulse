import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  Alert,
  AppState,
  Image,
  Modal,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  Vibration,
  View,
  Dimensions,
} from "react-native";
import {
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
} from "expo-audio";
import { useKeepAwake } from "expo-keep-awake";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import {
  mediaDevices,
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  RTCView,
  MediaStream,
} from "react-native-webrtc";
import {
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Video as VideoIcon,
  VideoOff,
  SwitchCamera,
  Signal,
  MessageSquare,
  MoreVertical,
  Pause,
  Play,
  Volume2,
} from "lucide-react-native";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { socket } from "../../src/realtime/socket";
import { endCallNavigation } from "../../src/realtime/callRouting";
import {
  getIceConfig,
  getCachedIceConfig,
  getNotificationPrefs,
  rejectCallHttp,
  endCallHttp,
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
} from "../../modules/call-ringer";
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

const FALLBACK_ICE = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  // Multiple TURN transports so the call can still relay when mobile UDP is
  // blocked. The TCP/TLS (443?transport=tcp) entry is the lifeline on
  // restrictive mobile carriers / corporate Wi-Fi where UDP/STUN never works.
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

// P1.8 — Deterministic ICE-config gating. A config has "real" (provisioned)
// TURN only when the server returned managed credentials (Cloudflare Calls /
// self-hosted coturn / a static 3rd-party provider) rather than the public
// Open Relay fallback or STUN-only. The server's `mode` is authoritative
// (cloudflare-calls | coturn-rest | static = real; public-fallback | stun-only
// = fallback). When `mode` is absent (older server) we sniff the URLs for a
// non-openrelay turn:/turns: entry. The FIRST offer/answer must never be
// negotiated against the public-only fallback: on a network that requires a
// relay this makes the first call hang ("Connecting…") even though a retry
// works once the real creds are cached — the classic "fresh install: first
// call doesn't connect" bug.
const REAL_TURN_MODES = new Set(["cloudflare-calls", "coturn-rest", "static"]);
function hasRealTurn(
  cfg: { mode?: string; iceServers?: any[] } | null | undefined,
): boolean {
  if (!cfg) return false;
  if (cfg.mode && REAL_TURN_MODES.has(cfg.mode)) return true;
  const servers = cfg.iceServers || [];
  for (const s of servers) {
    const urls = Array.isArray(s?.urls) ? s.urls : [s?.urls];
    for (const u of urls) {
      if (typeof u !== "string") continue;
      const lower = u.toLowerCase();
      if (
        (lower.startsWith("turn:") || lower.startsWith("turns:")) &&
        !lower.includes("openrelay.metered.ca")
      ) {
        return true;
      }
    }
  }
  return false;
}

// P1.9 — Gate the public Open Relay TURN fallback. The server's /ice-config
// returns `allowPublicFallback`; when it is FALSE the client must NOT relay
// through the public openrelay.metered.ca service (a deployment that disabled
// DISABLE_PUBLIC_TURN must not be silently bypassed by the client's hard-coded
// FALLBACK_ICE). STUN is ALWAYS allowed; only public TURN URLs are stripped.
// Returns the servers unchanged when public fallback is allowed.
function applyPublicTurnPolicy(servers: any[], allowPublic: boolean): any[] {
  if (allowPublic) return servers;
  const out: any[] = [];
  for (const s of servers || []) {
    const urls = Array.isArray(s?.urls) ? s.urls : [s?.urls];
    const kept = urls.filter(
      (u: any) =>
        typeof u === "string" &&
        !u.toLowerCase().includes("openrelay.metered.ca"),
    );
    if (kept.length === 0) continue; // entry was entirely public TURN — drop it
    out.push({ ...s, urls: kept.length === 1 ? kept[0] : kept });
  }
  return out;
}

type CallStatus =
  | "ringing"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "ended"
  | "rejected";

// ── Decoupled video renderers (Signal-Android model) ─────────────────────────
// On react-native-webrtc each <RTCView> is backed by an Android SurfaceView/EGL
// surface. Re-rendering it churns that native surface → flicker, dropped frames
// and momentary freezes. Signal isolates its renderer from UI state so routine
// updates (call timer, network badge, reactions) never touch the surface. We do
// the same by extracting the surfaces into React.memo leaf components that take
// ONLY primitive, stable props — so the per-second duration tick and the 3s
// stats tick can never re-render the video surfaces.
type VideoStyle = ReturnType<typeof makeStyles>["remoteVideo"];

const RemoteVideo = memo(function RemoteVideo(props: {
  url: string;
  style: VideoStyle;
}) {
  return (
    <RTCView
      streamURL={props.url}
      style={props.style}
      objectFit="cover"
      // Never mirror the remote feed — only a front-camera self-view should be
      // mirrored. WebRTC transmits the TRUE (un-mirrored) image already.
      mirror={false}
      // Remote = base layer (zOrder 0); the PiP self-view sits above it.
      zOrder={0}
    />
  );
});

const FullScreenSelfView = memo(function FullScreenSelfView(props: {
  url: string;
  mirror: boolean;
  style: VideoStyle;
}) {
  return (
    <RTCView
      streamURL={props.url}
      style={props.style}
      objectFit="cover"
      // Front-camera self-view → mirror like a real mirror (WhatsApp style).
      mirror={props.mirror}
      zOrder={0}
    />
  );
});

const PipSelfView = memo(function PipSelfView(props: {
  url: string;
  mirror: boolean;
  style: any;
}) {
  return (
    <RTCView
      streamURL={props.url}
      style={props.style}
      objectFit="cover"
      mirror={props.mirror}
      // zOrder MUST stay 0 here. On react-native-webrtc a non-zero zOrder forces
      // an Android SurfaceView with setZOrderMediaOverlay(true), which paints on
      // its own hardware layer OUTSIDE the parent's rounded-corner clip — that is
      // exactly why the self preview showed SQUARE corners no matter how the
      // parent was rounded. zOrder={0} uses a TextureView, which composites in
      // the normal view hierarchy and therefore RESPECTS the parent's
      // `overflow:"hidden"` + `borderRadius` (rounded corners actually clip the
      // video). The tile is still kept ABOVE the remote feed because its wrapper
      // (`pipStyles.wrap`) carries `elevation: 8` + `zIndex: 5` AND is rendered
      // AFTER the remote view in the tree — so dropping the media zOrder does not
      // hide the self preview.
      zOrder={0}
    />
  );
});

// ── Draggable PiP self-view (Signal model) ───────────────────────────────────
// Signal lets you DRAG the local self-preview tile around and it SNAPS to the
// nearest corner. We replicate that with react-native-gesture-handler (Pan) +
// react-native-reanimated shared values. CRITICAL for the flicker fix: the drag
// runs entirely on the UI thread via useAnimatedStyle, so moving the tile NEVER
// re-renders the memoized <PipSelfView> (RTCView) underneath — the native video
// surface is never reattached, so there is no flicker/freeze while dragging
// (the whole reason the surfaces were isolated in the first place).
const PIP_W = 110;
const PIP_H = 160;
const PIP_MARGIN = 16;
// Vertical clearance above the bottom controls bar so a bottom-snapped tile
// never overlaps the call buttons.
const PIP_BOTTOM_CLEARANCE = 120;

const PIP_RADIUS = 18;

const pipStyles = StyleSheet.create({
  wrap: {
    position: "absolute",
    top: 0,
    left: 0,
    width: PIP_W,
    height: PIP_H,
    borderRadius: PIP_RADIUS,
    backgroundColor: "transparent",
    // zIndex alone does NOT lift a view above a sibling on Android — elevation
    // is required, otherwise the full-screen remote video paints over the
    // self-preview once the call connects and the local tile "disappears".
    zIndex: 5,
    elevation: 8,
    // IMPORTANT: do NOT put a borderWidth on this OUTER wrap. On Android the
    // RTCView is backed by a SurfaceView/TextureView that paints OUTSIDE the
    // parent's rounded-corner clip, so a square video peeked out past the
    // rounded border (the "square corners around a rounded video" bug). The
    // rounding + clipping + border now live on the `inner` view that DIRECTLY
    // wraps the surface so the corners are actually clipped.
  },
  inner: {
    width: "100%",
    height: "100%",
    // Clip the RTCView surface to rounded corners HERE — on the view that
    // directly contains it — so Android actually rounds the video instead of
    // leaving a square surface inside a rounded frame.
    borderRadius: PIP_RADIUS,
    overflow: "hidden",
    backgroundColor: "#000",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
  },
});

const DraggablePipSelfView = memo(function DraggablePipSelfView(props: {
  url: string;
  mirror: boolean;
  topInset: number;
  bottomInset: number;
}) {
  const { width: screenW, height: screenH } = Dimensions.get("window");
  // The four snap targets (top/bottom × left/right), clamped to safe-area.
  const topY = props.topInset + 50;
  const bottomY = screenH - props.bottomInset - PIP_H - PIP_BOTTOM_CLEARANCE;
  const leftX = PIP_MARGIN;
  const rightX = screenW - PIP_W - PIP_MARGIN;

  // Start in the top-right corner (matches the previous fixed position).
  const translateX = useSharedValue(rightX);
  const translateY = useSharedValue(topY);
  const startX = useSharedValue(rightX);
  const startY = useSharedValue(topY);

  const pan = Gesture.Pan()
    .onStart(() => {
      startX.value = translateX.value;
      startY.value = translateY.value;
    })
    .onUpdate((e) => {
      translateX.value = startX.value + e.translationX;
      translateY.value = startY.value + e.translationY;
    })
    .onEnd(() => {
      // Snap to the NEAREST corner by comparing the tile centre to the screen
      // midpoints (Signal behaviour). Spring for a natural settle.
      const centreX = translateX.value + PIP_W / 2;
      const centreY = translateY.value + PIP_H / 2;
      const snapX = centreX < screenW / 2 ? leftX : rightX;
      const snapY = centreY < screenH / 2 ? topY : bottomY;
      translateX.value = withSpring(snapX, { damping: 18, stiffness: 220 });
      translateY.value = withSpring(snapY, { damping: 18, stiffness: 220 });
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
    ],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[pipStyles.wrap, animatedStyle]}>
        <PipSelfView url={props.url} mirror={props.mirror} style={pipStyles.inner} />
      </Animated.View>
    </GestureDetector>
  );
});

// Self-contained call-duration timer. Owning its own state + interval here means
// the once-per-second tick re-renders ONLY this tiny text node — never the
// parent CallScreen (and therefore never the memoized video surfaces above).
// This is the single biggest fix for the "connected video flickers/freezes"
// bug, mirroring Signal keeping the renderer untouched by UI-state churn.
const CallDuration = memo(function CallDuration(props: {
  active: boolean;
  style: any;
}) {
  const [duration, setDuration] = useState(0);
  useEffect(() => {
    if (!props.active) return;
    setDuration(0);
    const t = setInterval(() => setDuration((d) => d + 1), 1000);
    return () => clearInterval(t);
  }, [props.active]);
  const m = Math.floor(duration / 60);
  const s = duration % 60;
  return <Text style={props.style}>{`${m}:${String(s).padStart(2, "0")}`}</Text>;
});

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
    useState<"good" | "fair" | "poor" | "unknown">("unknown");
  // The PEER's self-reported connection quality (received via the `quality-state`
  // signal). Drives a Teams-style "<name>'s connection is unstable" banner so
  // the user knows a freeze/stutter is the OTHER side's network, not theirs.
  const [peerQuality, setPeerQuality] =
    useState<"good" | "fair" | "poor" | "unknown">("unknown");
  // Last quality value we SENT to the peer — used to only emit `quality-state`
  // on a real change (not every 3s sample) so we don't spam the relay.
  const lastSentQualityRef = useRef<string | null>(null);
  const [onHold, setOnHold] = useState(false);
  const holdSnapshotRef = useRef<{ muted: boolean; videoOff: boolean } | null>(
    null,
  );
  const [noiseSuppressionEnabled, setNoiseSuppressionEnabled] = useState(true);
  const [recording, setRecording] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [chatText, setChatText] = useState("");
  const [chatUnread, setChatUnread] = useState(0);
  const [callMessages, setCallMessages] = useState<
    Array<{
      id: string | number;
      senderId?: number;
      senderName?: string;
      content?: string;
      createdAt?: string;
    }>
  >([]);
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  const [floatingReactions, setFloatingReactions] = useState<
    Array<{ id: number; emoji: string; fromSelf: boolean }>
  >([]);
  const [notificationPrefs, setNotificationPrefs] = useState(
    DEFAULT_NOTIFICATION_PREFS,
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
  const iceServersRef = useRef<any[]>(FALLBACK_ICE);
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
  const pendingIce = useRef<any[]>([]);
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
  // P0.7 — Reliable local-ICE transport. Bare `socket.send` silently drops a
  // candidate whenever the WS is momentarily not OPEN (foreground reconnect,
  // brief mobile/VPN blip). A dropped local ICE candidate can be the ONE
  // candidate that would have completed the pairing, leaving the call stuck on
  // "Connecting…". Instead we push every local candidate onto an ordered queue
  // that flushes via `sendWithBackoff` (which reconnects + retries) and
  // re-flushes itself on a short timer until the socket is back, so no
  // candidate is lost across a transient WS outage. Cleared on unmount.
  const iceOutQueueRef = useRef<
    Array<{ targetUserId: number; candidate: any }>
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
  // ── Signal serialization queue (mirrors the web client's buffered, ordered
  // signal handling). Every incoming WS signal used to spawn an UNORDERED
  // async IIFE: while the offer handler was awaiting getUserMedia/ICE-config,
  // a concurrently-arriving answer or renegotiation offer would race against
  // a half-built peer connection — setRemoteDescription threw in the wrong
  // state, the rejection was unhandled, and the call silently hung on
  // "Connecting…" forever. Chaining every signal task on one promise makes
  // processing strictly sequential, so that interleaving is impossible.
  const signalChainRef = useRef<Promise<void>>(Promise.resolve());
  const runSerialized = useCallback((task: () => Promise<void>) => {
    signalChainRef.current = signalChainRef.current.then(task).catch((err) => {
      console.warn("[call] signaling task failed:", err?.message || err);
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
          } catch (err: any) {
            if (!wsOk) {
              console.warn(
                "[call] HTTP end fallback failed:",
                err?.message || err,
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
      const audio: any = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      const profiles: any[] =
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
          const stream = await mediaDevices.getUserMedia(constraints);
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
          localStreamRef.current = stream as MediaStream;
          setLocalStream(stream as MediaStream);
          return stream as MediaStream;
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
          shouldRouteThroughEarpiece:
            status !== "ringing" && callType === "voice" ? !speakerOn : false,
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
      ? notificationPrefs.ringtone || DEFAULT_NOTIFICATION_PREFS.ringtone || "classic"
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
  }, [
    ringPlayer,
    ringingCategory,
    ringingToneId,
    shouldPlayRingingTone,
  ]);

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
    mode === "incoming" &&
    status === "ringing" &&
    !notificationPrefs.muteAll;
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

  // Bitrate ramp-up (ported from the web useWebRTC applyBitrateRampUp):
  // start LOW (~300 kbps) so the connection establishes fast on a mobile
  // uplink, then ramp to the target (~800 kbps) over 3s once connected.
  // A static high cap caused stalls/freezes at connect time on congested
  // networks — part of why calls to desktop/web felt slow and unstable.
  const bitrateRampTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Tracks the bitrate we last asked the encoder for, so the adaptive
  // controller (in the getStats loop) can ramp DOWN on a degrading link and
  // back UP on recovery without re-applying the same value every 3s sample.
  const currentVideoBitrateRef = useRef<number>(300_000);
  const setVideoBitrate = useCallback(
    (
      pc: RTCPeerConnection,
      bitrate: number,
      // Optional resolution downscale (1 = full, 2 = half each dimension, …).
      // On a POOR link, halving resolution is what stops the freezes: a smaller
      // frame fits the available bandwidth, so the encoder keeps a steady frame
      // flowing instead of stalling trying to push full-res frames it can't.
      scaleResolutionDownBy = 1,
    ) => {
      try {
        const senders =
          typeof (pc as any).getSenders === "function"
            ? (pc as any).getSenders()
            : [];
        for (const sender of senders) {
          if (sender?.track?.kind !== "video") continue;
          const params = sender.getParameters?.();
          if (!params) continue;
          if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
          }
          params.encodings[0].maxBitrate = bitrate;
          params.encodings[0].maxFramerate = 30;
          params.encodings[0].scaleResolutionDownBy = scaleResolutionDownBy;
          // "balanced" lets the encoder trade BOTH resolution and framerate as
          // the link degrades, softening gracefully instead of freezing. The
          // old "maintain-framerate" forced full FPS on a weak uplink, which
          // starved quality and produced the stutter/freeze the user reported.
          (params as any).degradationPreference = "balanced";
          sender.setParameters?.(params).catch?.(() => {});
        }
        currentVideoBitrateRef.current = bitrate;
      } catch {
        /* setParameters not critical — ignore */
      }
    },
    [],
  );

  const applySenderEncodingLimits = useCallback(
    (pc: RTCPeerConnection) => {
      // Initial conservative cap for fast, stable connect.
      setVideoBitrate(pc, 300_000);
    },
    [setVideoBitrate],
  );

  const applyBitrateRampUp = useCallback(
    (pc: RTCPeerConnection) => {
      // Start LOW for a fast, stable connect, then ramp to the target over 3s.
      // The ceiling was raised from 800 kbps → 1.2 Mbps to close the quality gap
      // with the web/desktop client (1.5 Mbps). 1.2 Mbps keeps headroom for a
      // mobile UPLINK (typically the bottleneck) while delivering noticeably
      // sharper video to desktop peers. The ramp still protects connect time.
      const INITIAL = 300_000;
      const TARGET = 1_200_000;
      const STEPS = 3;
      const STEP_MS = 1000;
      bitrateRampTimersRef.current.forEach((t) => clearTimeout(t));
      bitrateRampTimersRef.current = [];
      setVideoBitrate(pc, INITIAL);
      for (let step = 1; step <= STEPS; step++) {
        const timer = setTimeout(() => {
          if ((pc as any).connectionState !== "connected") return;
          const bitrate = Math.round(
            INITIAL + ((TARGET - INITIAL) * step) / STEPS,
          );
          setVideoBitrate(pc, bitrate);
        }, STEP_MS * step);
        bitrateRampTimersRef.current.push(timer);
      }
    },
    [setVideoBitrate],
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
      // Allow up to ~6s total (from the start of this wait) for genuine TURN.
      const REAL_TURN_DEADLINE_MS = 6000;
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
      typeof (pc as any).getTransceivers === "function"
        ? (pc as any).getTransceivers()
        : [];
    const used = new Set<any>();

    for (const track of stream.getTracks()) {
      // Skip if this exact track is already on some sender.
      const alreadyAttached = transceivers.some(
        (t: any) => t.sender?.track && t.sender.track.id === track.id,
      );
      if (alreadyAttached) continue;

      // Find an unused transceiver of MATCHING kind created by the remote
      // offer (its receiver track kind reflects what was offered).
      const matchingTr = transceivers.find((t: any) => {
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
      const pcConfig: any = {
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
      };
      if (relayOnlyRef.current) {
        pcConfig.iceTransportPolicy = "relay";
      }
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
      // stuck on an endless "Connecting…" screen.
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
      }
      connectionTimeoutRef.current = setTimeout(() => {
        if ((pc as any).connectionState !== "connected") {
          endAndLeave(false);
        }
      }, 30000);

      (pc as any).onicecandidate = (e: any) => {
        if (e.candidate) {
          // P0.7 — enqueue for reliable, ordered delivery (retries over a
          // transient WS blip) instead of a bare fire-and-forget socket.send
          // that is silently lost whenever the socket is momentarily closed.
          enqueueLocalIce(targetUserId, e.candidate.toJSON());
        }
      };

      (pc as any).ontrack = (e: any) => {
        // Defensively build the remote stream: react-native-webrtc may fire
        // ontrack once per kind (audio, then video) and `e.streams` can be
        // empty. Add each track to the SAME stream so we never drop one.
        let stream: MediaStream | null = remoteStreamRef.current;
        if (e.streams && e.streams[0]) {
          stream = e.streams[0];
        } else if (!stream) {
          stream = new MediaStream();
        }
        if (
          e.track &&
          stream &&
          !stream.getTracks().some((t) => t.id === e.track.id)
        ) {
          try {
            stream.addTrack(e.track);
          } catch {
            /* ignore */
          }
        }
        remoteStreamRef.current = stream;
        setRemoteStream(stream);
        if (e.track?.kind === "video") setRemoteVideoOff(false);
      };

      // Fast proactive ICE restart on a brief mobile/VPN network blip — try to
      // re-establish before connectionState escalates to "failed".
      (pc as any).oniceconnectionstatechange = () => {
        const ice = (pc as any).iceConnectionState;
        if (
          ice === "disconnected" &&
          negotiationDoneRef.current &&
          !iceRestartAttemptedRef.current
        ) {
          setTimeout(() => {
            const cur = (pc as any).iceConnectionState;
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
                  await pc.setLocalDescription(offer);
                  socket.send("call_signal", {
                    conversationId,
                    callId: callIdRef.current,
                    targetUserId,
                    signal: {
                      type: "offer",
                      sdp: (pc as any).localDescription?.sdp,
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

      (pc as any).onconnectionstatechange = () => {
        const st = (pc as any).connectionState;
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
          dispatchCall({ type: "PC_CONNECTED" });
          // Ramp the video bitrate up now that the link is established
          // (mirrors web applyBitrateRampUp).
          applyBitrateRampUp(pc);
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
                remote
                  .getVideoTracks()
                  .some((t) => (t as any).readyState !== "ended");
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
            if (
              pcRef.current === pc &&
              (pc as any).connectionState !== "connected"
            ) {
              endAndLeave(false);
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
                await pc.setLocalDescription(offer);
                socket.send("call_signal", {
                  conversationId,
                  callId: callIdRef.current,
                  targetUserId,
                  signal: {
                    type: "offer",
                    sdp: (pc as any).localDescription?.sdp,
                  },
                });
              } catch {
                endAndLeave(false);
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
                if (!builder || !localStr) return endAndLeave(false);
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
                await newPc.setLocalDescription(offer);
                socket.send("call_signal", {
                  conversationId,
                  callId: callIdRef.current,
                  targetUserId,
                  signal: { type: "offer", sdp: offer.sdp },
                });
              } catch {
                endAndLeave(false);
              }
            })();
          } else {
            endAndLeave(false);
          }
        } else if (st === "closed") {
          endAndLeave(false);
        }
      };

      return pc;
    },
    [conversationId, endAndLeave],
  );

  // Keep a stable ref to createPC so the relay-only rebuild path inside the
  // connection-state handler can recreate the PC without a stale closure.
  createPCRef.current = createPC;

  const flushIce = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || !(pc as any).remoteDescription) return;
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
    (targetUserId: number, candidate: any) => {
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
      bitrateRampTimersRef.current.forEach((t) => clearTimeout(t));
      bitrateRampTimersRef.current = [];
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
        endAndLeave(false);
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
      .some((t) => (t as any).readyState !== "ended" && t.enabled !== false);
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
          if ((t as any).readyState === "ended") stream.removeTrack(t);
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
          typeof (pc as any).getSenders === "function"
            ? (pc as any).getSenders()
            : [];
        const videoSender = senders.find(
          (s: any) => s.track?.kind === "video",
        );
        if (videoSender && typeof videoSender.replaceTrack === "function") {
          // Swap the dead track for the live one — no renegotiation needed.
          await videoSender.replaceTrack(newTrack);
        } else if ((pc as any).signalingState === "stable") {
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
                await pc.setLocalDescription(offer);
                await socket.sendWithBackoff(
                  "call_signal",
                  {
                    conversationId,
                    callId: callIdRef.current,
                    targetUserId: target,
                    signal: { type: "offer", sdp: offer.sdp },
                  },
                  {
                    timeoutMs: 4000,
                    maxAttempts: 5,
                    initialBackoffMs: 120,
                    maxBackoffMs: 800,
                  },
                );
              } catch (err: any) {
                console.warn(
                  "[call] dead-video recovery renegotiation failed:",
                  err?.message || err,
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
    } catch (err: any) {
      console.warn(
        "[call] failed to recover dead video track:",
        err?.message || err,
      );
      return false;
    }
  }, [callType, videoOff, usingFrontCamera, conversationId, runSerialized]);

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
        void recoverDeadVideoTrack();
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
            const sendersBefore =
              typeof (pc as any).getSenders === "function"
                ? (pc as any).getSenders().filter((s: any) => s.track).length
                : 0;
            await attachLocalTracks(stream);
            const sendersAfter =
              typeof (pc as any).getSenders === "function"
                ? (pc as any).getSenders().filter((s: any) => s.track).length
                : 0;
            const target = peerIdRef.current;

            const needsRenegotiation = sendersAfter > sendersBefore;
            if (
              needsRenegotiation &&
              target &&
              (pc as any).signalingState === "stable"
            ) {
              // Create + send a fresh offer so the newly-added media m-line is
              // negotiated and the peer starts receiving our tracks.
              runSerialized(async () => {
                try {
                  const offer = await pc.createOffer({
                    offerToReceiveAudio: true,
                    offerToReceiveVideo: callType === "video",
                  });
                  await pc.setLocalDescription(offer);
                  await socket.sendWithBackoff(
                    "call_signal",
                    {
                      conversationId,
                      callId: callIdRef.current,
                      targetUserId: target,
                      signal: { type: "offer", sdp: offer.sdp },
                    },
                    {
                      timeoutMs: 4000,
                      maxAttempts: 5,
                      initialBackoffMs: 120,
                      maxBackoffMs: 800,
                    },
                  );
                } catch (err: any) {
                  console.warn(
                    "[call] post-resume renegotiation failed:",
                    err?.message || err,
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
          } catch (err: any) {
            console.warn(
              "[call] failed to attach tracks after resume:",
              err?.message || err,
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
                await pc.setLocalDescription(offer);
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
            } catch (err: any) {
              // Fatal negotiation error — end cleanly instead of hanging.
              console.warn(
                "[call] offer creation failed:",
                err?.message || err,
              );
              endAndLeave(false);
            }
          });
          break;
        }
        case "call_signal": {
          if (Number(d.conversationId) !== conversationId) return;
          const signal = d.signal;
          const from = d.fromUserId;
          if (from != null) peerIdRef.current = from;
          // Serialized: signals are processed strictly in arrival order so an
          // ICE candidate / answer can never race a half-finished offer
          // handler (which awaits getUserMedia + ICE config for seconds).
          runSerialized(async () => {
            let pc = pcRef.current;
            if (signal.type === "offer") {
              try {
                // If a fresh offer arrives while our PC is dead (the peer escalated
                // to a relay-only rebuild), tear ours down and rebuild in relay
                // mode too so both sides negotiate over TURN.
                if (pc) {
                  const cs = (pc as any).connectionState;
                  const ics = (pc as any).iceConnectionState;
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
                pc = pcRef.current || createPC(stream, from, false);
                // Perfect Negotiation glare guard: an offer arriving while we
                // have our own offer in flight (or are mid-creation) is a
                // collision. The IMPOLITE peer (caller) ignores it and keeps
                // its own offer; the POLITE peer (callee) rolls its offer back
                // and accepts theirs. Without this, setRemoteDescription threw
                // "wrong state" and the call hung when both sides offered at
                // once (ICE-restart / post-resume renegotiation races).
                const offerCollision =
                  makingOfferRef.current ||
                  (pc as any).signalingState !== "stable";
                if (offerCollision) {
                  if (!politeRef.current) {
                    console.warn(
                      "[call] ignoring colliding offer (impolite peer)",
                    );
                    return;
                  }
                  try {
                    await pc.setLocalDescription({
                      type: "rollback",
                    } as any);
                  } catch {
                    /* some impls auto-rollback on setRemoteDescription(offer) */
                  }
                }
                await pc.setRemoteDescription(
                  new RTCSessionDescription(signal),
                );
                // Must await: tracks have to be bound to the offer's
                // transceivers BEFORE createAnswer so the answer SDP advertises
                // sendrecv media. Otherwise the peer never receives our audio/
                // video and the connection appears to "not connect".
                await attachLocalTracks(stream);
                applySenderEncodingLimits(pc);
                await flushIce();
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                socket.send("call_signal", {
                  conversationId,
                  callId: callIdRef.current,
                  targetUserId: from,
                  signal: { type: "answer", sdp: answer.sdp },
                });
                // Tell the peer our current camera state immediately so they
                // render avatar vs. video correctly from the start.
                socket.send("call_signal", {
                  conversationId,
                  callId: callIdRef.current,
                  targetUserId: from,
                  signal: { type: "video-state", videoOff },
                });
              } catch (err: any) {
                // A fatal error while answering (bad SDP / wrong state) used
                // to be an unhandled rejection that left the call hanging on
                // "Connecting…" forever. End cleanly instead.
                console.warn(
                  "[call] offer handling failed:",
                  err?.message || err,
                );
                endAndLeave(false);
              }
            } else if (signal.type === "answer") {
              if (!pc) return;
              // Ignore stray answers when we are not expecting one — avoids
              // "Failed to set remote answer sdp: Called in wrong state"
              // killing the negotiation (mirrors the web client's guard).
              if ((pc as any).signalingState !== "have-local-offer") {
                console.warn(
                  "[call] ignoring answer in state:",
                  (pc as any).signalingState,
                );
                return;
              }
              try {
                await pc.setRemoteDescription(
                  new RTCSessionDescription(signal),
                );
                await flushIce();
              } catch (err: any) {
                console.warn(
                  "[call] answer handling failed:",
                  err?.message || err,
                );
              }
            } else if (signal.type === "ice-candidate") {
              if (signal.candidate == null) return;
              if (pc && (pc as any).remoteDescription) {
                try {
                  await pc.addIceCandidate(
                    new RTCIceCandidate(signal.candidate),
                  );
                } catch {
                  /* ignore */
                }
              } else {
                pendingIce.current.push(signal.candidate);
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
                      (t) =>
                        (t as any).readyState !== "ended" &&
                        t.enabled !== false,
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
                await pc.setLocalDescription(offer);
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
            } catch (err: any) {
              console.warn(
                "[call] reconnect re-offer failed:",
                err?.message || err,
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
          if (
            pc &&
            target &&
            (pc as any).localDescription?.type === "offer"
          ) {
            socket.send("call_signal", {
              conversationId,
              callId: callIdRef.current,
              targetUserId: target,
              signal: {
                type: "offer",
                sdp: (pc as any).localDescription.sdp,
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
          const msgId = d.id ?? d.clientMsgId ?? `${Date.now()}-${Math.random()}`;
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
        body: callType === "video" ? "Ongoing video call" : "Ongoing voice call",
        scheme: "workpulse",
      });
    } else {
      stopActiveCall();
    }
  }, [status, callType, peerName]);

  // Always release the active-call foreground service on unmount so a stale
  // ongoing-call notification can never linger after the screen is gone.
  useEffect(() => {
    return () => {
      stopActiveCall();
    };
  }, []);

  // ── Connection-quality monitor via getStats() (mirrors web NetworkStats) ───
  useEffect(() => {
    if (status !== "connected") {
      setConnectionQuality("unknown");
      return;
    }
    const interval = setInterval(async () => {
      const pc = pcRef.current;
      if (!pc || typeof (pc as any).getStats !== "function") return;
      try {
        const stats = await pc.getStats();
        let rtt: number | null = null;
        // Aggregate packet loss across BOTH inbound audio AND video streams.
        // Previously only audio was sampled, so a video call could be visibly
        // stuttering (heavy video loss) while still reporting "Good" because the
        // audio stream was clean. Summing both kinds reflects the real felt
        // quality on a video call (mirrors how Teams/Meet grade the link).
        let packetsLost = 0;
        let packetsReceived = 0;
        stats.forEach((report: any) => {
          if (
            report.type === "candidate-pair" &&
            (report.state === "succeeded" || report.nominated)
          ) {
            if (typeof report.currentRoundTripTime === "number") {
              rtt = report.currentRoundTripTime;
            }
          }
          if (
            report.type === "inbound-rtp" &&
            (report.kind === "audio" || report.kind === "video")
          ) {
            packetsLost += report.packetsLost || 0;
            packetsReceived += report.packetsReceived || 0;
          }
        });
        const lossRate =
          packetsReceived > 0
            ? packetsLost / (packetsLost + packetsReceived)
            : 0;
        let q: "good" | "fair" | "poor" | "unknown" = "unknown";
        if (rtt !== null && rtt < 0.15 && lossRate < 0.02) {
          q = "good";
        } else if (rtt !== null && rtt < 0.4 && lossRate < 0.05) {
          q = "fair";
        } else if (rtt !== null) {
          q = "poor";
        }
        if (q !== "unknown") {
          // ── ADAPTIVE BITRATE (Signal-style sender throttle) ──────────────
          // Feed the measured quality back into the ENCODER so a degrading link
          // is met by SENDING LESS, not by freezing. Previously the encoder only
          // ever ramped UP to a fixed 1.2 Mbps ceiling and never backed off —
          // overwhelming a weak mobile uplink, which is exactly what produced
          // the stutter/lag/freeze + "Poor"/"unstable" badge the user saw.
          //   • poor → 200 kbps + half-resolution (keeps a steady, smaller frame
          //     flowing instead of stalling on full-res frames it can't push)
          //   • fair → 500 kbps, full resolution
          //   • good → restore toward the 1.2 Mbps ceiling, full resolution
          // We only call setParameters when the TARGET actually changes (the
          // currentVideoBitrateRef guard) so we never thrash the encoder on
          // every 3s sample. Voice calls have no video sender → this no-ops.
          if (callType === "video") {
            let targetBitrate: number;
            let scale: number;
            if (q === "poor") {
              targetBitrate = 200_000;
              scale = 2;
            } else if (q === "fair") {
              targetBitrate = 500_000;
              scale = 1;
            } else {
              targetBitrate = 1_200_000;
              scale = 1;
            }
            if (currentVideoBitrateRef.current !== targetBitrate) {
              setVideoBitrate(pc, targetBitrate, scale);
            }
          }
          setConnectionQuality(q);
          // Tell the peer OUR measured quality so THEY can surface a
          // "<name>'s connection is unstable" banner — exactly how Teams/Meet
          // attribute a freeze to the right side. Only emit on a real change
          // (not every 3s sample) to avoid spamming the relay. Reuses the
          // existing call_signal channel; web ignores unknown signal types so
          // this is forward-compatible.
          if (lastSentQualityRef.current !== q) {
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
        }
      } catch {
        /* stats unavailable this tick */
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [status, conversationId]);

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
    if (!sent) {
      Alert.alert(
        "Connection error",
        "Could not accept this call because realtime connection is unavailable.",
      );
      return endAndLeave(false);
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
      } catch (err: any) {
        console.warn(
          "[call] HTTP reject fallback failed:",
          err?.message || err,
        );
      }
    }
    endAndLeave(false);
  }, [conversationId, endAndLeave]);

  useEffect(() => {
    if (mode !== "incoming" || !autoAnswer || status !== "ringing") return;
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
    rejectIncoming().catch(() => {});
  }, [autoDecline, mode, rejectIncoming, status]);

  function toggleMute() {
    setOnHold(false);
    holdSnapshotRef.current = null;
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !muted;
    stream.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
    setMuted(next);
    const target = peerIdRef.current;
    if (target) {
      socket.send("call_signal", {
        conversationId,
        callId: callIdRef.current,
        targetUserId: target,
        signal: { type: "audio-state", muted: next },
      });
    }
  }

  function toggleVideo() {
    setOnHold(false);
    holdSnapshotRef.current = null;
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !videoOff;
    stream.getVideoTracks().forEach((t) => {
      t.enabled = !next;
    });
    setVideoOff(next);
    // Inform the peer so they render avatar/black instead of a frozen frame.
    const target = peerIdRef.current;
    if (target) {
      socket.send("call_signal", {
        conversationId,
        callId: callIdRef.current,
        targetUserId: target,
        signal: { type: "video-state", videoOff: next },
      });
    }
  }

  function switchCamera() {
    const stream = localStreamRef.current;
    stream?.getVideoTracks().forEach((t) => {
      // react-native-webrtc track exposes _switchCamera()
      (t as any)._switchCamera?.();
    });
    // Track facing so the self-view only mirrors for the front camera.
    setUsingFrontCamera((v) => !v);
  }

  function toggleHold() {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !onHold;
    if (next) {
      holdSnapshotRef.current = { muted, videoOff };
      stream.getAudioTracks().forEach((t) => {
        t.enabled = false;
      });
      stream.getVideoTracks().forEach((t) => {
        t.enabled = false;
      });
      setMuted(true);
      setVideoOff(true);
    } else {
      const snap = holdSnapshotRef.current || { muted: false, videoOff: true };
      stream.getAudioTracks().forEach((t) => {
        t.enabled = !snap.muted;
      });
      stream.getVideoTracks().forEach((t) => {
        t.enabled = !snap.videoOff;
      });
      setMuted(snap.muted);
      setVideoOff(snap.videoOff);
    }
    const target = peerIdRef.current;
    if (target) {
      socket.send("call_signal", {
        conversationId,
        callId: callIdRef.current,
        targetUserId: target,
        signal: { type: "audio-state", muted: next ? true : muted },
      });
      socket.send("call_signal", {
        conversationId,
        callId: callIdRef.current,
        targetUserId: target,
        signal: { type: "video-state", videoOff: next ? true : videoOff },
      });
    }
    setOnHold(next);
  }

  function toggleNoiseSuppression() {
    const next = !noiseSuppressionEnabled;
    const stream = localStreamRef.current;
    if (stream) {
      stream.getAudioTracks().forEach((track) => {
        track
          .applyConstraints?.({
            echoCancellation: true,
            autoGainControl: true,
            noiseSuppression: next,
          } as any)
          .catch(() => {});
      });
    }
    setNoiseSuppressionEnabled(next);
  }

  function toggleRecording() {
    setRecording((v) => !v);
  }

  function toggleSpeaker() {
    if (callType !== "voice") return;
    setSpeakerOn((v) => !v);
  }

  function sendReaction(emoji: string) {
    const targetUserId = peerIdRef.current;
    if (!targetUserId) return;
    socket.send("call_reaction", { conversationId, targetUserId, emoji });
    const id = Date.now() + Math.random();
    setFloatingReactions((prev) => [...prev, { id, emoji, fromSelf: true }]);
    setTimeout(
      () => setFloatingReactions((prev) => prev.filter((r) => r.id !== id)),
      2500,
    );
    setShowReactionPicker(false);
    setShowMore(false);
  }

  function sendChat() {
    const content = chatText.trim();
    if (!content) return;
    socket.send("chat_message", { conversationId, content });
    setChatText("");
  }

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
    remoteStream
      .getVideoTracks()
      .some((t) => (t as any).readyState !== "ended");
  const showRemoteVideo =
    showVideo && hasLiveRemoteVideo && !remoteVideoOff;

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
      .some((t) => (t as any).readyState !== "ended" && t.enabled !== false);
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
    () => (remoteStream ? (remoteStream as any).toURL() : null),
    [remoteStream],
  );
  const localURL = useMemo(
    () => (localStream ? (localStream as any).toURL() : null),
    [localStream],
  );

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

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Main stage:
          1. Connected with peer video               → remote video full-screen.
          2. Pre-connect video call (outgoing ringing,
             incoming ringing, or connecting w/o peer
             video yet)                               → WhatsApp-style FULL-SCREEN
             local self-view (we see ourselves before the peer's video arrives).
          3. Otherwise                               → peer avatar. */}
      {showRemoteVideo && remoteURL ? (
        // Memoized leaf: only re-renders when the URL changes, so the per-second
        // duration tick / 3s stats tick never churn this native surface.
        <RemoteVideo url={remoteURL} style={styles.remoteVideo} />
      ) : showFullScreenSelfPreview && localURL ? (
        <FullScreenSelfView
          url={localURL}
          mirror={usingFrontCamera}
          style={styles.remoteVideo}
        />
      ) : (
        <View style={styles.avatarWrap}>
          <View style={styles.avatar}>
            {peerAvatarUrl ? (
              <Image source={{ uri: peerAvatarUrl }} style={styles.avatarImg} />
            ) : (
              <Text style={styles.avatarText}>
                {(peerName || "?")[0]?.toUpperCase()}
              </Text>
            )}
          </View>
        </View>
      )}

      {/* PiP self-view — shown for the connecting/connected phases. While the
          incoming video call is still ringing the self-view is rendered
          FULL-SCREEN above instead, then seamlessly remaps into this PiP the
          moment the call is answered (same stream object, no re-acquire). */}
      {showPipSelfPreview && localURL ? (
        <DraggablePipSelfView
          url={localURL}
          mirror={usingFrontCamera}
          topInset={insets.top}
          bottomInset={insets.bottom}
        />
      ) : null}

      {/* Top status bar — connection quality + peer-mute, once connected
          (mirrors the web CallOverlay top bar). */}
      {status === "connected" ? (
        <View style={[styles.topBar, { top: insets.top + 8 }]}>
          <View style={styles.qualityBadge}>
            <Signal size={13} color={qualityColor} />
            <Text style={[styles.qualityLabel, { color: qualityColor }]}>
              {qualityLabel}
            </Text>
          </View>
          <View style={styles.statusBadgeRow}>
            {onHold ? (
              <View style={[styles.pill, styles.holdPill]}>
                <Text style={styles.pillText}>On hold</Text>
              </View>
            ) : null}
            {noiseSuppressionEnabled ? (
              <View style={[styles.pill, styles.nsPill]}>
                <Text style={styles.pillText}>NS</Text>
              </View>
            ) : null}
            {recording ? (
              <View style={[styles.pill, styles.recPill]}>
                <Text style={styles.pillText}>REC</Text>
              </View>
            ) : null}
          </View>
          {peerMuted ? (
            <View style={styles.muteBadge}>
              <MicOff size={13} color="#fff" />
              <Text style={styles.muteBadgeText}>Muted</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* Header info */}
      <View style={[styles.info, { top: insets.top + 60 }]}>
        <Text style={styles.peerName}>{peerName}</Text>
        {status === "connected" ? (
          <CallDuration active={status === "connected"} style={styles.status} />
        ) : (
          <Text style={styles.status}>{statusLabel}</Text>
        )}
      </View>

      {/* Peer poor-connection banner (Teams/Meet style). Surfaced when the
          PEER reports their own link is poor, so a freeze/stutter is attributed
          to the right side rather than looking like our fault. */}
      {status === "connected" && peerQuality === "poor" ? (
        <View style={[styles.peerQualityBanner, { top: insets.top + 110 }]}>
          <Signal size={13} color="#fff" />
          <Text style={styles.peerQualityText} numberOfLines={1}>
            {peerName}&apos;s connection is unstable
          </Text>
        </View>
      ) : null}

      {/* Controls */}
      {mode === "incoming" && status === "ringing" ? (
        <View style={[styles.incomingControls, { paddingBottom: Math.max(insets.bottom, 24) }]}>
          <View style={styles.incomingBtnWrap}>
            <Pressable style={styles.reject} onPress={rejectIncoming}>
              <PhoneOff size={28} color="#fff" />
            </Pressable>
            <Text style={styles.ctrlLabel}>Decline</Text>
          </View>
          <View style={styles.incomingBtnWrap}>
            <Pressable style={styles.accept} onPress={acceptIncoming}>
              <Phone size={28} color="#fff" />
            </Pressable>
            <Text style={styles.ctrlLabel}>Accept</Text>
          </View>
        </View>
      ) : (
        <View style={[styles.controlsBar, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.controlsPill}
            contentContainerStyle={styles.controlsScroll}
          >
            <Pressable
              style={[styles.ctrl, muted && styles.ctrlActive]}
              onPress={toggleMute}
            >
              {muted ? (
                <MicOff size={20} color="#fff" />
              ) : (
                <Mic size={20} color="#fff" />
              )}
            </Pressable>
            {showVideo ? (
              <Pressable
                style={[styles.ctrl, videoOff && styles.ctrlActive]}
                onPress={toggleVideo}
              >
                {videoOff ? (
                  <VideoOff size={20} color="#fff" />
                ) : (
                  <VideoIcon size={20} color="#fff" />
                )}
              </Pressable>
            ) : null}
            {showVideo ? (
              <Pressable style={styles.ctrl} onPress={switchCamera}>
                <SwitchCamera size={20} color="#fff" />
              </Pressable>
            ) : null}
            {callType === "voice" ? (
              <Pressable
                style={[styles.ctrl, speakerOn && styles.ctrlActive]}
                onPress={toggleSpeaker}
              >
                <Volume2 size={20} color="#fff" />
              </Pressable>
            ) : null}
            {status === "connected" ? (
              <>
                <Pressable
                  style={[styles.ctrl, onHold && styles.ctrlHold]}
                  onPress={toggleHold}
                >
                  {onHold ? (
                    <Play size={20} color="#fff" />
                  ) : (
                    <Pause size={20} color="#fff" />
                  )}
                </Pressable>
                <Pressable
                  style={[styles.ctrl, showChat && styles.ctrlActive]}
                  onPress={() => {
                    setShowChat((v) => !v);
                    setChatUnread(0);
                  }}
                >
                  <MessageSquare size={20} color="#fff" />
                  {chatUnread > 0 && !showChat ? (
                    <View style={styles.unreadDot}>
                      <Text style={styles.unreadText}>
                        {chatUnread > 9 ? "9+" : chatUnread}
                      </Text>
                    </View>
                  ) : null}
                </Pressable>
                <Pressable
                  style={[styles.ctrl, showMore && styles.ctrlActive]}
                  onPress={() => setShowMore(true)}
                >
                  <MoreVertical size={20} color="#fff" />
                </Pressable>
              </>
            ) : null}
            <Pressable style={styles.ctrlEnd} onPress={() => endAndLeave(true)}>
              <PhoneOff size={22} color="#fff" />
            </Pressable>
          </ScrollView>
        </View>
      )}

      {floatingReactions.map((r) => (
        <View
          key={r.id}
          style={[
            styles.floatingReaction,
            r.fromSelf ? styles.floatingReactionSelf : styles.floatingReactionPeer,
          ]}
        >
          <Text style={styles.floatingReactionText}>{r.emoji}</Text>
        </View>
      ))}

      <Modal
        visible={showMore}
        transparent
        animationType="fade"
        onRequestClose={() => setShowMore(false)}
      >
        <Pressable style={styles.sheetBackdrop} onPress={() => setShowMore(false)}>
          <Pressable style={styles.sheet}>
            <Pressable style={styles.sheetItem} onPress={toggleHold}>
              <Text style={styles.sheetItemText}>{onHold ? "Resume call" : "Hold call"}</Text>
            </Pressable>
            <Pressable style={styles.sheetItem} onPress={toggleNoiseSuppression}>
              <Text style={styles.sheetItemText}>
                {noiseSuppressionEnabled
                  ? "Disable noise suppression"
                  : "Enable noise suppression"}
              </Text>
            </Pressable>
            <Pressable style={styles.sheetItem} onPress={toggleRecording}>
              <Text style={styles.sheetItemText}>
                {recording ? "Stop call recording" : "Record call"}
              </Text>
            </Pressable>
            <Pressable
              style={styles.sheetItem}
              onPress={() => {
                setShowMore(false);
                setShowReactionPicker(true);
              }}
            >
              <Text style={styles.sheetItemText}>Send reaction</Text>
            </Pressable>
            <Pressable
              style={styles.sheetItem}
              onPress={() => {
                setShowMore(false);
                setShowChat(true);
                setChatUnread(0);
              }}
            >
              <Text style={styles.sheetItemText}>Open chat</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={showReactionPicker}
        transparent
        animationType="fade"
        onRequestClose={() => setShowReactionPicker(false)}
      >
        <Pressable
          style={styles.sheetBackdrop}
          onPress={() => setShowReactionPicker(false)}
        >
          <Pressable style={styles.reactionSheet}>
            {["👍", "👏", "❤️", "😂", "🎉", "🤔"].map((emoji) => (
              <Pressable
                key={emoji}
                style={styles.reactionBtn}
                onPress={() => sendReaction(emoji)}
              >
                <Text style={styles.reactionBtnText}>{emoji}</Text>
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={showChat}
        transparent
        animationType="slide"
        onRequestClose={() => setShowChat(false)}
      >
        <View style={styles.chatPanel}>
          <View style={styles.chatHeader}>
            <Text style={styles.chatTitle}>Call chat</Text>
            <Pressable onPress={() => setShowChat(false)}>
              <Text style={styles.chatClose}>Close</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.chatBody}>
            {callMessages.map((m) => {
              const mine = Number(m.senderId) !== Number(peerIdRef.current);
              return (
                <View
                  key={String(m.id)}
                  style={[styles.chatMsg, mine ? styles.chatMsgMine : styles.chatMsgPeer]}
                >
                  <Text style={styles.chatMsgSender}>
                    {mine ? "You" : m.senderName || peerName}
                  </Text>
                  <Text style={styles.chatMsgText}>{m.content || ""}</Text>
                </View>
              );
            })}
          </ScrollView>
          <View style={styles.chatComposer}>
            <TextInput
              style={styles.chatInput}
              value={chatText}
              onChangeText={setChatText}
              placeholder="Type a message"
              placeholderTextColor="rgba(255,255,255,0.45)"
            />
            <Pressable style={styles.chatSendBtn} onPress={sendChat}>
              <Text style={styles.chatSendText}>Send</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0a0a0a" },
  remoteVideo: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#000",
  },
  localVideo: {
    position: "absolute",
    top: 50,
    right: 16,
    width: 110,
    height: 160,
    borderRadius: 12,
    backgroundColor: "#000",
    overflow: "hidden",
    // zIndex alone does NOT lift a view above a sibling on Android — elevation
    // is required, otherwise the full-screen remote video paints over the
    // self-preview once the call connects and the local tile "disappears".
    zIndex: 5,
    elevation: 8,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.25)",
  },
  avatarWrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  avatar: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarImg: { width: "100%", height: "100%" },
  avatarText: { color: "#fff", fontSize: 44, fontWeight: "700" },
  info: {
    position: "absolute",
    top: 80,
    left: 0,
    right: 0,
    alignItems: "center",
    gap: 6,
  },
  peerName: { color: "#fff", fontSize: 24, fontWeight: "700" },
  status: { color: "rgba(255,255,255,0.7)", fontSize: 15 },
  topBar: {
    position: "absolute",
    top: 44, // overridden inline with insets.top + 8
    left: 16,
    right: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    zIndex: 6,
    elevation: 9,
    gap: 8,
  },
  statusBadgeRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  pill: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  holdPill: { backgroundColor: "rgba(245,158,11,0.7)" },
  nsPill: { backgroundColor: "rgba(59,130,246,0.7)" },
  recPill: { backgroundColor: "rgba(239,68,68,0.75)" },
  pillText: { color: "#fff", fontSize: 11, fontWeight: "700" },
  qualityBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "rgba(0,0,0,0.45)",
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  qualityLabel: { fontSize: 12, fontWeight: "700" },
  muteBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "rgba(239,68,68,0.85)",
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  muteBadgeText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  peerQualityBanner: {
    position: "absolute",
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: "85%",
    backgroundColor: "rgba(239,68,68,0.9)",
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    zIndex: 7,
    elevation: 9,
  },
  peerQualityText: { color: "#fff", fontSize: 12, fontWeight: "600", flexShrink: 1 },
  /* ─── Controls bar (horizontal scrollable frosted pill, mirrors web mobile) ─── */
  controlsBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 10,
    elevation: 10,
  },
  controlsPill: {
    backgroundColor: "rgba(17,24,39,0.88)",
    borderRadius: 32,
    borderWidth: 1,
    borderColor: "rgba(55,65,81,0.4)",
    maxWidth: "100%" as any,
  },
  controlsScroll: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  /* ─── Incoming call layout ─── */
  incomingControls: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row" as const,
    justifyContent: "center" as const,
    alignItems: "flex-end" as const,
    gap: 80,
  },
  incomingBtnWrap: {
    alignItems: "center" as const,
    gap: 10,
    paddingBottom: 8,
  },
  ctrlLabel: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 12,
    fontWeight: "600" as const,
  },
  ctrl: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  ctrlActive: { backgroundColor: "rgba(59,130,246,0.75)" },
  ctrlHold: { backgroundColor: "rgba(245,158,11,0.75)" },
  ctrlEnd: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#ef4444",
    alignItems: "center",
    justifyContent: "center",
  },
  reject: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: theme.danger,
    alignItems: "center",
    justifyContent: "center",
  },
  accept: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: theme.success,
    alignItems: "center",
    justifyContent: "center",
  },
  unreadDot: {
    position: "absolute",
    top: -2,
    right: -2,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 3,
    borderRadius: 8,
    backgroundColor: "#ef4444",
    alignItems: "center",
    justifyContent: "center",
  },
  unreadText: { color: "#fff", fontSize: 10, fontWeight: "700" },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: theme.bgSecondary,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 18,
    gap: 4,
  },
  sheetItem: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  sheetItemText: { color: theme.text, fontSize: 15, fontWeight: "600" },
  reactionSheet: {
    marginTop: "auto",
    backgroundColor: theme.bgSecondary,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    justifyContent: "center",
  },
  reactionBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  reactionBtnText: { fontSize: 26 },
  floatingReaction: {
    position: "absolute",
    bottom: 110,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  floatingReactionSelf: { right: 24 },
  floatingReactionPeer: { left: 24 },
  floatingReactionText: { fontSize: 28 },
  chatPanel: {
    flex: 1,
    marginTop: 80,
    backgroundColor: theme.bgSecondary,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  chatHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.glassBorder,
  },
  chatTitle: { color: theme.text, fontSize: 16, fontWeight: "700" },
  chatClose: { color: theme.primary, fontSize: 14, fontWeight: "600" },
  chatBody: { flex: 1, paddingHorizontal: 12, paddingVertical: 10 },
  chatMsg: {
    maxWidth: "82%",
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 8,
  },
  chatMsgMine: {
    alignSelf: "flex-end",
    backgroundColor: "rgba(59,130,246,0.22)",
  },
  chatMsgPeer: {
    alignSelf: "flex-start",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  chatMsgSender: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 11,
    marginBottom: 2,
  },
  chatMsgText: { color: "#fff", fontSize: 14 },
  chatComposer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: theme.glassBorder,
  },
  chatInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 100,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.08)",
    color: "#fff",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chatSendBtn: {
    borderRadius: 18,
    backgroundColor: theme.primary,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chatSendText: { color: "#fff", fontSize: 13, fontWeight: "700" },
});