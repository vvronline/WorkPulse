/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * React binding for the LiveKit media engine.
 *
 * Everything here exists to present a LiveKit `Room` through the SAME surface
 * the 1500-line call overlay already consumes from `useWebRTC` + `useCallControls`:
 * the same media refs (`localStreamRef`, `remoteStreamRef`, the three media
 * elements), the same remote flags (`remoteHasVideo`, `remoteMuted`,
 * `remoteScreenSharing`), the same control callbacks. No overlay markup
 * changes; only the thing behind the refs changes.
 *
 * The hook is inert unless `enabled` is true, so it can be mounted
 * unconditionally alongside the (disabled) legacy p2p hook without violating
 * the rules of hooks or touching the camera.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createLiveKitEngine, type LiveKitEngine } from "./livekitEngine";
import type { CallStateMachine, SerialQueue } from "./callStateMachine";
import type { CallMediaSession, UiConnectionQuality } from "./types";

export interface LiveKitCallRefs {
  localStreamRef: React.MutableRefObject<MediaStream | null>;
  remoteStreamRef: React.MutableRefObject<MediaStream | null>;
  screenStreamRef: React.MutableRefObject<MediaStream | null>;
  localVideoRef: React.MutableRefObject<HTMLVideoElement | null>;
  remoteVideoRef: React.MutableRefObject<HTMLVideoElement | null>;
  remoteAudioRef: React.MutableRefObject<HTMLAudioElement | null>;
}

/**
 * How long a call whose remote participant vanished is allowed to sit in
 * "reconnecting" before we give up on them.
 *
 * On the p2p path the peer connection itself fails and the overlay's
 * CONNECT_TIMEOUT_MS covers this. On the SFU path our own Room stays perfectly
 * healthy when the other side's process is killed / loses power, so nothing
 * would ever time out: the call would hang in a connected-looking state until
 * the user noticed. This watchdog is the SFU equivalent, and it is deliberately
 * the same 30s budget the overlay uses for `connecting`/`reconnecting`.
 */
export const NO_PEER_TIMEOUT_MS = 30000;

export interface UseLiveKitCallParams {
  enabled: boolean;
  session: CallMediaSession | null;
  callType: string;
  isVideoCall: boolean;
  isMobile: boolean;
  /** Pre-acquired outgoing-call stream that LiveKit is about to replace. */
  preAcquiredStream?: MediaStream | null;
  machine: CallStateMachine;
  queue: SerialQueue;
  refs: LiveKitCallRefs;
  onMediaConnected: () => void;
  onMediaReconnecting: () => void;
  onMediaDisconnected: (reason?: unknown) => void;
  /**
   * The remote participant left and never came back within
   * `noPeerTimeoutMs`. This hook does NOT end the call itself — it reports the
   * fact and lets the WorkPulse-side owner run the same once-only durable
   * hang-up a button press would, so media never becomes a second authority on
   * call lifecycle.
   */
  onPeerLost?: () => void;
  noPeerTimeoutMs?: number;
}

export default function useLiveKitCall({
  enabled,
  session,
  callType,
  isVideoCall,
  isMobile,
  preAcquiredStream,
  machine,
  queue,
  refs,
  onMediaConnected,
  onMediaReconnecting,
  onMediaDisconnected,
  onPeerLost,
  noPeerTimeoutMs = NO_PEER_TIMEOUT_MS,
}: UseLiveKitCallParams) {
  const engineRef = useRef<LiveKitEngine | null>(null);
  const connectStartedRef = useRef(false);

  const [remoteHasVideo, setRemoteHasVideo] = useState(false);
  const [remoteVideoOff, setRemoteVideoOff] = useState(false);
  const [remoteMuted, setRemoteMuted] = useState(false);
  const [remoteScreenSharing, setRemoteScreenSharing] = useState(false);
  const [remotePeerQuality, setRemotePeerQuality] =
    useState<UiConnectionQuality>("unknown");
  const [connectionQuality, setConnectionQuality] =
    useState<UiConnectionQuality>("unknown");
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(!isVideoCall);
  const [screenSharing, setScreenSharing] = useState(false);
  const [onHold, setOnHold] = useState(false);
  const [activeAudioDevice, setActiveAudioDevice] = useState("");
  const [activeVideoDevice, setActiveVideoDevice] = useState("");

  const roomConnectedRef = useRef(false);
  const remoteCountRef = useRef(0);
  /**
   * The outgoing-call path pre-acquires a camera/mic stream for the p2p sender
   * before a transport is even chosen. On this path LiveKit publishes its own
   * tracks, so that capture has to be released — and it has to be released even
   * if `connect()` never ran (decline / cancel / busy / ring timeout / failed
   * negotiation), or the camera LED stays on after the overlay closes.
   */
  const preAcquiredRef = useRef<MediaStream | null>(null);
  preAcquiredRef.current = preAcquiredStream ?? null;

  const releasePreAcquired = useCallback(() => {
    const stream = preAcquiredRef.current;
    if (!stream) return;
    preAcquiredRef.current = null;
    stream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    });
  }, []);

  const attachRemote = useCallback(
    (stream: MediaStream | null) => {
      refs.remoteStreamRef.current = stream;
      const audio = refs.remoteAudioRef.current;
      if (audio && audio.srcObject !== stream) {
        audio.srcObject = stream;
        audio.volume = 1.0;
        audio.play().catch(() => {});
      }
      const video = refs.remoteVideoRef.current;
      if (video && video.srcObject !== stream) {
        video.srcObject = stream;
        if (isMobile) video.muted = true;
        video.play().catch(() => {});
      }
    },
    [refs, isMobile],
  );

  const attachLocal = useCallback(
    (stream: MediaStream | null) => {
      refs.localStreamRef.current = stream;
      const video = refs.localVideoRef.current;
      if (video && isVideoCall && video.srcObject !== stream) {
        video.srcObject = stream;
        video.play().catch(() => {});
      }
    },
    [refs, isVideoCall],
  );

  /**
   * Media is "connected" only once a remote participant is actually in the
   * room. Joining an empty room is the SFU equivalent of ICE gathering, not of
   * a live call — surfacing it as `connected` would show a talking UI while
   * the callee is still ringing.
   */
  const evaluateConnected = useCallback(() => {
    if (roomConnectedRef.current && remoteCountRef.current > 0) {
      onMediaConnected();
    }
  }, [onMediaConnected]);

  /**
   * "The other side vanished" watchdog.
   *
   * A peer that crashes, sleeps or loses its network leaves OUR room healthy —
   * LiveKit reports the participant leaving and nothing else. That is a
   * reconnecting call, not an ended one (WorkPulse alone ends calls), so we show
   * `reconnecting` and give them a bounded window to come back. If they do, the
   * timer is dropped and the call resumes; if they do not, we ask our owner to
   * run the normal durable hang-up.
   */
  const hadRemoteRef = useRef(false);
  const noPeerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onPeerLostRef = useRef(onPeerLost);
  onPeerLostRef.current = onPeerLost;

  const clearNoPeerWatchdog = useCallback(() => {
    if (!noPeerTimerRef.current) return;
    clearTimeout(noPeerTimerRef.current);
    noPeerTimerRef.current = null;
  }, []);

  const handleRemoteCount = useCallback(
    (count: number) => {
      remoteCountRef.current = count;
      if (count > 0) {
        hadRemoteRef.current = true;
        clearNoPeerWatchdog();
        evaluateConnected();
        return;
      }
      // An empty room BEFORE anyone ever joined is just an outgoing call that is
      // still ringing — the overlay's ring timeout owns that window.
      if (!hadRemoteRef.current || noPeerTimerRef.current) return;
      if (machine.isTerminal()) return;
      onMediaReconnecting();
      noPeerTimerRef.current = setTimeout(() => {
        noPeerTimerRef.current = null;
        if (machine.isTerminal()) return;
        onPeerLostRef.current?.();
      }, noPeerTimeoutMs);
    },
    [
      clearNoPeerWatchdog,
      evaluateConnected,
      onMediaReconnecting,
      machine,
      noPeerTimeoutMs,
    ],
  );

  const cleanup = useCallback(() => {
    const engine = engineRef.current;
    engineRef.current = null;
    connectStartedRef.current = false;
    roomConnectedRef.current = false;
    remoteCountRef.current = 0;
    hadRemoteRef.current = false;
    clearNoPeerWatchdog();
    if (engine) void engine.disconnect();
    // Unconditional: this is the one teardown that always runs, whether or not
    // a Room was ever created.
    releasePreAcquired();
    if (refs.screenStreamRef.current) {
      refs.screenStreamRef.current.getTracks().forEach((t) => t.stop());
      refs.screenStreamRef.current = null;
    }
    if (refs.localStreamRef.current) {
      refs.localStreamRef.current.getTracks().forEach((t) => t.stop());
      refs.localStreamRef.current = null;
    }
    refs.remoteStreamRef.current = null;
    if (refs.remoteAudioRef.current) refs.remoteAudioRef.current.srcObject = null;
    if (refs.remoteVideoRef.current) refs.remoteVideoRef.current.srcObject = null;
    if (refs.localVideoRef.current) refs.localVideoRef.current.srcObject = null;
  }, [refs, releasePreAcquired, clearNoPeerWatchdog]);

  const connect = useCallback(async () => {
    if (!enabled || connectStartedRef.current) return;
    const credentials = session?.livekit;
    if (!credentials) return;
    if (machine.isTerminal()) return;
    connectStartedRef.current = true;

    // LiveKit publishes its own tracks, so release the pre-acquired capture
    // rather than leaving a second camera/mic open for the whole call.
    releasePreAcquired();

    const engine = createLiveKitEngine({
      credentials,
      callType,
      isMobile,
      queue,
      isTerminal: () => machine.isTerminal(),
      handlers: {
        onConnected: () => {
          roomConnectedRef.current = true;
          evaluateConnected();
        },
        onReconnecting: () => onMediaReconnecting(),
        onReconnected: () => {
          roomConnectedRef.current = true;
          evaluateConnected();
        },
        onDisconnected: (reason) => {
          roomConnectedRef.current = false;
          onMediaDisconnected(reason);
        },
        onLocalStream: attachLocal,
        onRemoteStream: attachRemote,
        onRemoteHasVideo: setRemoteHasVideo,
        onRemoteVideoOff: setRemoteVideoOff,
        onRemoteMuted: setRemoteMuted,
        onRemoteScreenSharing: setRemoteScreenSharing,
        onRemoteQuality: setRemotePeerQuality,
        onLocalQuality: setConnectionQuality,
        onRemoteParticipantCount: handleRemoteCount,
        onMediaError: (err) =>
          console.warn("[call-livekit] media device error:", err),
      },
    });
    engineRef.current = engine;

    try {
      await engine.connect();
      setMuted(false);
      setVideoOff(!isVideoCall);
      const room = engine.getRoom();
      setActiveAudioDevice(room?.getActiveDevice?.("audioinput") || "");
      setActiveVideoDevice(room?.getActiveDevice?.("videoinput") || "");
    } catch (err) {
      console.error("[call-livekit] room connect failed:", err);
    }
  }, [
    enabled,
    session,
    machine,
    releasePreAcquired,
    callType,
    isMobile,
    queue,
    evaluateConnected,
    handleRemoteCount,
    onMediaReconnecting,
    onMediaDisconnected,
    attachLocal,
    attachRemote,
    isVideoCall,
  ]);

  // Re-attach the remote stream when the remote <video> element mounts (it is
  // rendered conditionally on `remoteHasVideo`, so it does not exist yet at
  // the moment the first track arrives).
  useEffect(() => {
    if (!enabled) return;
    if (remoteHasVideo) attachRemote(refs.remoteStreamRef.current);
  }, [enabled, remoteHasVideo, attachRemote, refs]);

  // Teardown must run ONLY on unmount. Keeping it in a ref (rather than in the
  // effect's dependency list) means a re-render can never disconnect a live
  // Room out from under the call.
  const cleanupRef = useRef(cleanup);
  cleanupRef.current = cleanup;
  useEffect(() => {
    return () => cleanupRef.current();
  }, []);

  const toggleMute = useCallback(async () => {
    const next = !muted;
    setMuted(next);
    try {
      await engineRef.current?.setMicrophoneEnabled(!next);
    } catch (err) {
      setMuted(!next);
      console.warn("[call-livekit] toggleMute failed:", err);
    }
  }, [muted]);

  const toggleVideo = useCallback(async () => {
    const next = !videoOff;
    setVideoOff(next);
    try {
      await engineRef.current?.setCameraEnabled(!next);
    } catch (err) {
      setVideoOff(!next);
      console.warn("[call-livekit] toggleVideo failed:", err);
    }
  }, [videoOff]);

  const toggleScreenShare = useCallback(async () => {
    const next = !screenSharing;
    try {
      await engineRef.current?.setScreenShareEnabled(next);
      setScreenSharing(next);
    } catch (err) {
      console.warn("[call-livekit] toggleScreenShare failed:", err);
    }
  }, [screenSharing]);

  const toggleHold = useCallback(async () => {
    const hold = !onHold;
    setOnHold(hold);
    try {
      await engineRef.current?.setMicrophoneEnabled(!hold);
      if (isVideoCall) await engineRef.current?.setCameraEnabled(!hold);
    } catch (err) {
      console.warn("[call-livekit] toggleHold failed:", err);
    }
    setMuted(hold);
    setVideoOff(hold ? true : !isVideoCall ? true : false);
  }, [onHold, isVideoCall]);

  const switchAudioDevice = useCallback(async (deviceId: string) => {
    const ok = await engineRef.current?.switchDevice("audioinput", deviceId);
    if (ok) setActiveAudioDevice(deviceId);
  }, []);

  const switchVideoDevice = useCallback(async (deviceId: string) => {
    const ok = await engineRef.current?.switchDevice("videoinput", deviceId);
    if (ok) setActiveVideoDevice(deviceId);
  }, []);

  return useMemo(
    () => ({
      connect,
      cleanup,
      engineRef,
      remoteHasVideo,
      remoteVideoOff,
      remoteMuted,
      remoteScreenSharing,
      remotePeerQuality,
      connectionQuality,
      muted,
      videoOff,
      screenSharing,
      onHold,
      activeAudioDevice,
      activeVideoDevice,
      toggleMute,
      toggleVideo,
      toggleScreenShare,
      toggleHold,
      switchAudioDevice,
      switchVideoDevice,
    }),
    [
      connect,
      cleanup,
      remoteHasVideo,
      remoteVideoOff,
      remoteMuted,
      remoteScreenSharing,
      remotePeerQuality,
      connectionQuality,
      muted,
      videoOff,
      screenSharing,
      onHold,
      activeAudioDevice,
      activeVideoDevice,
      toggleMute,
      toggleVideo,
      toggleScreenShare,
      toggleHold,
      switchAudioDevice,
      switchVideoDevice,
    ],
  );
}
