/**
 * Structural types shared by the call UI (the 1:1 call screen, its overlay
 * chrome and the media stage).
 *
 * These exist to replace the `any` that used to flow through every call
 * component prop. They are deliberately STRUCTURAL rather than re-exports of
 * `react-native`/`react-native-webrtc` types so that:
 *   - the modules importing them stay testable under plain jest (no native
 *     module resolution required), and
 *   - a `StyleSheet.create(...)` result assigns without a cast, since
 *     RN's registered-style values are opaque numbers on native and objects
 *     on web.
 */

import type { ImageStyle, TextStyle, ViewStyle } from "react-native";

/**
 * A single style entry as produced by `StyleSheet.create`.
 *
 * Deliberately an INTERSECTION, not a union: the call stylesheet is consumed
 * generically (`styles.avatarImg` may land on an `<Image>`, `styles.peerName`
 * on a `<Text>`), and only an intersection is assignable to each of
 * `ViewStyle`, `TextStyle` and `ImageStyle` individually. A union would fail
 * on the properties whose value sets differ between them (e.g. `overflow`,
 * which allows `"scroll"` on a View but not on an Image).
 */
export type CallStyle = ViewStyle & TextStyle & ImageStyle;

/**
 * The stylesheet object handed down from the call screen
 * (`makeStyles(theme)` in `app/call/[conversationId].styles.ts`). Keyed access
 * is intentional: the overlay and media-stage components pick out individual
 * named entries, and enumerating all ~80 keys here would only duplicate the
 * stylesheet definition.
 */
export type CallStyles = Record<string, CallStyle>;

/** Screen-edge insets supplied by `useSafeAreaInsets`. */
export type CallInsets = { top: number; bottom: number };

/** The lifecycle phase of a call, as rendered by the UI. */
export type CallStatus =
  | "ringing"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "ended"
  | "rejected";

/** Connection-quality bucket derived from `getStats()`. */
export type CallQuality = "good" | "fair" | "poor" | "unknown";

/** A message shown in the in-call chat panel. */
export type CallMessage = {
  id: string | number;
  senderId?: number;
  senderName?: string;
  content?: string;
  createdAt?: string;
};

/** An emoji reaction floating over the call surface. */
export type FloatingReaction = { id: number; emoji: string; fromSelf: boolean };

/* ── WebRTC-adjacent structural types ─────────────────────────────────────── */

/**
 * A media track, as far as the call UI needs to manipulate one.
 *
 * The function members use METHOD shorthand rather than property-with-
 * function-type on purpose: method signatures are compared bivariantly, so a
 * concrete `MediaStreamTrack` (whose `applyConstraints` takes a specific
 * `MediaTrackConstraints`) remains assignable to this structural type. Written
 * as properties, `strictFunctionTypes` would compare the parameters
 * contravariantly and reject it.
 */
export interface CallMediaTrack {
  enabled: boolean;
  readonly kind?: string;
  readonly readyState?: string;
  stop?(): void;
  applyConstraints?(constraints?: unknown): Promise<void>;
  /** react-native-webrtc extension used by the camera-flip control. */
  _switchCamera?(): void;
}

/** A local or remote media stream, as far as the call UI needs one. */
export interface CallMediaStreamLike {
  getAudioTracks(): CallMediaTrack[];
  getVideoTracks(): CallMediaTrack[];
  getTracks?(): CallMediaTrack[];
}

/** A session description (offer/answer) exchanged over the signaling channel. */
export interface SessionDescriptionLike {
  type: string;
  sdp?: string;
}

/** An ICE candidate exchanged over the signaling channel. */
export interface IceCandidateLike {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

/**
 * The `signal` envelope carried by a `call_signal` WS frame. A discriminated
 * union would be nicer, but the wire format is shared with the web client and
 * the server relays unknown types verbatim, so extra keys are tolerated.
 */
export interface CallSignal {
  type: string;
  sdp?: string;
  candidate?: IceCandidateLike | string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  videoOff?: boolean;
  muted?: boolean;
  quality?: CallQuality;
  signalId?: string;
  [key: string]: unknown;
}

/** Payload of an inbound `call_signal` frame. */
export interface CallSignalMessage {
  conversationId?: number | string;
  callId?: number | string | null;
  fromUserId?: number;
  targetUserId?: number;
  signal?: CallSignal;
  [key: string]: unknown;
}

/**
 * A generic realtime frame. The socket layer hands handlers a parsed JSON
 * object whose shape varies by `type`; handlers narrow the fields they use.
 */
export type RealtimeMessage = Record<string, unknown>;

/** Anything thrown from an await — narrowed by `errorMessage()`. */
export type UnknownError = unknown;

/** Extract a human-readable message from an unknown thrown value. */
export function errorMessage(err: UnknownError): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}
