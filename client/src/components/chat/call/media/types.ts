/**
 * Typed contract for the server-side media-backend negotiation.
 *
 * `GET /chat/calls/:callId/media-session?conversationId=N` answers with the
 * media plane the server wants THIS call to use. The decision is made once per
 * call, before any media is started, and is never revisited mid-call: a p2p
 * call stays p2p and a LiveKit call stays LiveKit (there is deliberately no
 * mid-call fallback, because a half-migrated call is worse than a failed one).
 *
 * The transport is chosen by the SERVER and only by the server. The client has
 * no local default and never "degrades": both peers must agree on the plane, so
 * a client that guessed p2p while the server put the other peer in an SFU room
 * would produce a connected-looking call with no media at all. An unresolvable
 * negotiation therefore fails call setup instead.
 */

export type CallMediaBackend = "p2p" | "livekit";

export interface LiveKitCredentials {
  serverUrl: string;
  token: string;
  roomName: string;
}

export interface CallMediaSession {
  backend: CallMediaBackend;
  callId: number | string | null;
  conversationId: number | string | null;
  livekit?: LiveKitCredentials;
}

/** Why a negotiation could not produce a server-chosen transport. */
export type CallMediaFailureReason =
  /** Request timed out (every attempt). */
  | "timeout"
  /** Transport error — no HTTP response at all. */
  | "network"
  /** The server answered, but with an error status. */
  | "http"
  /** 2xx whose body is not a usable verdict (unknown backend, missing creds). */
  | "malformed";

export interface CallMediaFailure {
  reason: CallMediaFailureReason;
  status?: number;
  message: string;
  attempts: number;
}

export type CallMediaSessionResult =
  | { ok: true; session: CallMediaSession }
  | { ok: false; failure: CallMediaFailure };

/** Quality vocabulary already understood by the existing overlay UI. */
export type UiConnectionQuality = "good" | "fair" | "poor" | "unknown";

/**
 * The lifecycle signals a media engine is allowed to raise. Note what is NOT
 * here: there is no "end the call" signal. Media transports observe media;
 * WorkPulse call lifecycle (accepted / rejected / ended / cancelled) stays
 * server-authoritative over the websocket.
 */
export interface MediaEngineHandlers {
  onConnected?: () => void;
  onReconnecting?: () => void;
  onReconnected?: () => void;
  /** Transport-level disconnect. Informational only — never ends the call. */
  onDisconnected?: (reason?: unknown) => void;
  onLocalStream?: (stream: MediaStream | null) => void;
  onRemoteStream?: (stream: MediaStream | null) => void;
  onRemoteHasVideo?: (hasVideo: boolean) => void;
  onRemoteVideoOff?: (videoOff: boolean) => void;
  onRemoteMuted?: (muted: boolean) => void;
  onRemoteScreenSharing?: (sharing: boolean) => void;
  onRemoteQuality?: (quality: UiConnectionQuality) => void;
  onLocalQuality?: (quality: UiConnectionQuality) => void;
  onRemoteParticipantCount?: (count: number) => void;
  onMediaError?: (error: unknown) => void;
}
