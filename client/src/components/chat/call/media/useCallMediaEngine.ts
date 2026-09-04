/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Media-engine boundary for the call overlay.
 *
 * The overlay used to call `useWebRTC` + `useCallControls` directly. It now
 * calls this one hook instead, which:
 *
 *   1. asks the server ONCE per call which media backend to use
 *      (`GET /chat/calls/:callId/media-session`),
 *   2. drives either the legacy p2p engine or the LiveKit engine, and
 *   3. returns the SAME `{ webrtc, controls }` shape the overlay already
 *      consumes, so none of its ~1500 lines of markup change.
 *
 * Invariants:
 *   • The backend is decided BEFORE any media starts and never changes for the
 *     life of the call — there is no mid-call fallback in either direction.
 *   • WorkPulse remains the only authority on call lifecycle. Media events can
 *     say "reconnecting"; only `call_ended` / `call_rejected` / a local hang-up
 *     can end a call, and once ended nothing revives it.
 *   • Both hooks are mounted unconditionally (rules of hooks); the inactive one
 *     is inert and never touches the camera.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useWebRTC from "../useWebRTC";
import useCallControls from "../useCallControls";
import useLiveKitCall from "./useLiveKitCall";
import {
  fetchCallMediaSession,
  forgetCallMediaSession,
} from "./mediaSessionClient";
import {
  createCallStateMachine,
  createSerialQueue,
  initialWebCallPhase,
  isTerminalPhase,
  type WebCallEvent,
  type WebCallPhase,
} from "./callStateMachine";
import { sendDurableCallAction } from "./durableCallActions";
import type { CallMediaBackend, CallMediaFailure, CallMediaSession } from "./types";

export interface UseCallMediaEngineParams {
  callState: any;
  callType: string;
  wsSend: (type: string, payload: any) => void;
  onEnd: () => void;
  onStatusChange: (status: string) => void;
  overlayRef: React.MutableRefObject<HTMLElement | null>;
}

const STATUS_EVENT: Record<string, WebCallEvent["type"]> = {
  connecting: "PEER_ACCEPTED",
  connected: "MEDIA_CONNECTED",
  reconnecting: "MEDIA_RECONNECTING",
};

export default function useCallMediaEngine({
  callState,
  callType,
  wsSend,
  onEnd,
  onStatusChange,
  overlayRef,
}: UseCallMediaEngineParams) {
  const {
    callId,
    conversationId,
    isIncoming,
    accepted,
    preAccepted,
    isReconnect,
    onEndExternal,
    localStream,
  } = callState;

  const isVideoCall = callType === "video";
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  const [session, setSession] = useState<CallMediaSession | null>(null);
  const backend: CallMediaBackend | null = session?.backend ?? null;
  const isLiveKit = backend === "livekit";
  /**
   * True only for an explicit server `p2p` verdict. While the verdict is
   * pending (and after a failed negotiation) the legacy engine is NOT the
   * owner of the call's media, which matters for who releases the
   * pre-acquired outgoing capture.
   */
  const usesLegacyEngine = backend === "p2p";

  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  const machine = useMemo(
    () =>
      createCallStateMachine(
        initialWebCallPhase({
          isReconnect: !!isReconnect,
          isPreAccepted: !!preAccepted,
          isIncoming: !!isIncoming,
        }),
      ),
    // Created once per overlay mount — a call's identity never changes here.
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const queue = useMemo(
    () => createSerialQueue((err) => console.warn("[call-media] task failed:", err)),
    [],
  );

  const finishedRef = useRef(false);
  const teardownRef = useRef<(() => void) | null>(null);

  /**
   * Single funnel for every lifecycle/media event. Terminal phases absorb
   * everything after them, so a `RoomEvent.Connected` that lands after the peer
   * hung up changes nothing and, critically, never re-emits a live status.
   */
  const dispatch = useCallback(
    (event: WebCallEvent): WebCallPhase => {
      const before = machine.getPhase();
      const after = machine.dispatch(event);
      if (after === before) return after;
      onStatusChangeRef.current(after);
      if (isTerminalPhase(after) && !finishedRef.current) {
        finishedRef.current = true;
        try {
          teardownRef.current?.();
        } catch (err) {
          console.warn("[call-media] teardown failed:", err);
        }
        onEndRef.current();
      }
      return after;
    },
    [machine],
  );

  // ─── Durable terminal actions ───
  // Declared up here because both the media engine (peer-lost watchdog, failed
  // negotiation) and the overlay's buttons end calls through them.
  //
  // The legacy engine emits `call_end` / `call_reject` itself, so it only needs
  // the idempotent HTTP confirmation added. Every other case — LiveKit, or a
  // hang-up while the backend is still being negotiated — has nobody else
  // emitting, so the durable helper owns the whole thing.
  const runDurable = useCallback(
    (action: "reject" | "end", emitSocket: boolean) => {
      // Fire-and-forget on purpose: the local teardown already happened, this
      // only makes sure the OTHER side learns about it.
      void sendDurableCallAction({
        action,
        callId,
        conversationId,
        wsSend,
        emitSocket,
      });
    },
    [callId, conversationId, wsSend],
  );

  /**
   * The one way this hook ends a call: terminal first (so both engines and any
   * in-flight media callback are absorbed), then the durable notify. Safe to
   * call twice — the terminal phase and `sendDurableCallAction`'s dedupe both
   * swallow the second one.
   */
  const endDurably = useCallback(() => {
    if (isTerminalPhase(machine.getPhase())) return;
    dispatch({ type: "LOCAL_END" });
    runDurable("end", true);
  }, [machine, dispatch, runDurable]);

  // ─── Backend selection (once, before media starts) ───
  // An OUTGOING call has no callId until `call_started` comes back, so we wait
  // for it rather than negotiating against `undefined`. Both engines stay inert
  // until the verdict lands, which is what makes "decided once, never
  // mid-call" true rather than aspirational.
  //
  // There is NO local fallback. If the server cannot tell us which transport to
  // use, we cannot guess: the peer may already be in an SFU room, and a guessed
  // transport produces a call that looks connected and carries nothing. Setup
  // fails instead, and the peer is released with the same durable hang-up a
  // manual one uses.
  const sessionRef = useRef<CallMediaSession | null>(null);
  sessionRef.current = session;
  const setupFailedRef = useRef(false);
  const failSetupRef = useRef<(failure: CallMediaFailure) => void>(() => {});

  /**
   * Bounded retries could not get a transport out of the server. The call is
   * unrunnable: end it locally (terminal, so both engines stay inert) and
   * release the peer over the same durable channel a manual hang-up uses, so
   * nobody is left ringing at a call that will never have media.
   */
  const failSetup = useCallback(
    (failure: CallMediaFailure) => {
      if (setupFailedRef.current) return;
      setupFailedRef.current = true;
      console.error(
        `[call-media] media negotiation failed (${failure.reason}` +
          `${failure.status ? ` ${failure.status}` : ""}, ${failure.attempts} attempts): ` +
          failure.message,
      );
      if (isTerminalPhase(machine.getPhase())) return;
      dispatch({ type: "SETUP_FAILED" });
      if (callId != null && conversationId != null) runDurable("end", true);
    },
    [machine, dispatch, runDurable, callId, conversationId],
  );
  failSetupRef.current = failSetup;

  /**
   * The verdict, awaited. `fetchCallMediaSession` memoises per call, so a user
   * who hits Accept before the effect below has resolved joins the SAME
   * negotiation rather than racing ahead on the wrong engine.
   */
  const ensureSession = useCallback(async (): Promise<CallMediaSession | null> => {
    if (sessionRef.current) return sessionRef.current;
    if (callId == null || conversationId == null) return null;
    const result = await fetchCallMediaSession(callId, conversationId);
    if (!result.ok) {
      failSetupRef.current(result.failure);
      return null;
    }
    sessionRef.current = sessionRef.current ?? result.session;
    setSession((prev) => prev ?? result.session);
    return sessionRef.current;
  }, [callId, conversationId]);

  useEffect(() => {
    if (callId == null || conversationId == null) return;
    let cancelled = false;
    (async () => {
      const result = await fetchCallMediaSession(callId, conversationId);
      if (cancelled) return;
      if (!result.ok) {
        failSetupRef.current(result.failure);
        return;
      }
      setSession((prev) => prev ?? result.session);
    })();
    return () => {
      cancelled = true;
    };
  }, [callId, conversationId]);

  useEffect(() => {
    return () => {
      forgetCallMediaSession(callId, conversationId);
    };
  }, [callId, conversationId]);

  // ─── Legacy p2p engine (inert unless the server picked p2p) ───
  const webrtc = useWebRTC({
    callState,
    callType,
    wsSend,
    onEnd: useCallback(() => dispatch({ type: "LOCAL_END" }), [dispatch]),
    onStatusChange: useCallback(
      (status: string) => {
        const type = STATUS_EVENT[status];
        if (type) dispatch({ type } as WebCallEvent);
        else onStatusChangeRef.current(status);
      },
      [dispatch],
    ),
    disabled: backend !== "p2p",
  });

  const controls = useCallControls({
    localStreamRef: webrtc.localStreamRef,
    pcRef: webrtc.pcRef,
    screenStreamRef: webrtc.screenStreamRef,
    screenSenderRef: webrtc.screenSenderRef,
    localVideoRef: webrtc.localVideoRef,
    remoteVideoRef: webrtc.remoteVideoRef,
    overlayRef,
    qualityControllerRef: webrtc.qualityControllerRef,
  });

  // ─── LiveKit engine (inert unless the server picked livekit) ───
  // The ref objects themselves are stable for the life of the overlay; the
  // wrapper must be too, or every re-render would look like a new media
  // surface.
  const mediaRefs = useMemo(
    () => ({
      localStreamRef: webrtc.localStreamRef,
      remoteStreamRef: webrtc.remoteStreamRef,
      screenStreamRef: webrtc.screenStreamRef,
      localVideoRef: webrtc.localVideoRef,
      remoteVideoRef: webrtc.remoteVideoRef,
      remoteAudioRef: webrtc.remoteAudioRef,
    }),
    [
      webrtc.localStreamRef,
      webrtc.remoteStreamRef,
      webrtc.screenStreamRef,
      webrtc.localVideoRef,
      webrtc.remoteVideoRef,
      webrtc.remoteAudioRef,
    ],
  );

  const livekit = useLiveKitCall({
    enabled: isLiveKit,
    session,
    callType,
    isVideoCall,
    isMobile,
    // Passed whenever the legacy engine is NOT the owner — including while the
    // verdict is still pending and after a failed negotiation — so the
    // pre-acquired outgoing capture always has exactly one owner that stops it.
    preAcquiredStream: usesLegacyEngine ? null : localStream,
    machine,
    queue,
    refs: mediaRefs,
    onMediaConnected: useCallback(
      () => void queue.enqueue(() => void dispatch({ type: "MEDIA_CONNECTED" })),
      [dispatch, queue],
    ),
    onMediaReconnecting: useCallback(
      () => void queue.enqueue(() => void dispatch({ type: "MEDIA_RECONNECTING" })),
      [dispatch, queue],
    ),
    onMediaDisconnected: useCallback(
      () => void queue.enqueue(() => void dispatch({ type: "MEDIA_DISCONNECTED" })),
      [dispatch, queue],
    ),
    // The SFU noticed the other side is gone and never came back. Media does not
    // get to end a call on its own, so this runs the SAME durable hang-up the
    // red button does — WorkPulse still tells the (absent) peer and the server.
    onPeerLost: useCallback(
      () =>
        void queue.enqueue(() => {
          console.warn(
            "[call-media] remote participant never returned — ending the call",
          );
          endDurably();
        }),
      [queue, endDurably],
    ),
  });

  teardownRef.current = () => {
    try {
      webrtc.stopRingtone();
    } catch {
      /* ignore */
    }
    // Not just `isLiveKit`: a call that ends while the verdict is still pending
    // (decline, cancel, ring timeout, failed negotiation) must still release the
    // pre-acquired camera/mic, which only this hook owns in that window.
    if (!usesLegacyEngine) livekit.cleanup();
  };

  // ─── Remote terminal events (LiveKit path) ───
  // On the p2p path `useWebRTC` owns this ref. When it is disabled we take it
  // over so `call_ended` / `call_rejected` / `call_busy` still tear the Room
  // down and close the overlay — the SFU never gets a vote.
  useEffect(() => {
    if (!isLiveKit || !onEndExternal) return;
    onEndExternal.current = () => {
      void queue.enqueue(() => void dispatch({ type: "REMOTE_ENDED" }));
    };
  }, [isLiveKit, onEndExternal, dispatch, queue]);

  // ─── LiveKit join timing ───
  // `locallyAccepted` covers the answer that happened BEFORE the verdict landed:
  // `livekit.connect()` was still inert at that point, so the join has to be
  // retried on the render where the engine became enabled.
  const [locallyAccepted, setLocallyAccepted] = useState(false);
  // Caller side: `call_accepted` arrived. The p2p engine reacts to this by
  // moving to `connecting` and killing the ringback (see its
  // `accepted && !isIncoming` effect); the SFU path has to do the same or the
  // overlay keeps playing the outgoing tone and keeps the 35s "No answer" ring
  // timer armed instead of swapping it for the 30s connect timeout.
  const peerAcceptedRef = useRef(false);
  const stopRingtoneRef = useRef(webrtc.stopRingtone);
  stopRingtoneRef.current = webrtc.stopRingtone;
  useEffect(() => {
    if (!isLiveKit || !session?.livekit) return;
    const peerAccepted = !isIncoming && !!accepted;
    if (peerAccepted && !peerAcceptedRef.current) {
      peerAcceptedRef.current = true;
      // Only out of `ringing`: a terminal phase absorbs it, and a call that is
      // already connected (peer joined the room before the websocket frame
      // arrived) must not be dragged back to `connecting`.
      if (machine.getPhase() === "ringing") dispatch({ type: "PEER_ACCEPTED" });
      try {
        stopRingtoneRef.current();
      } catch {
        /* ignore */
      }
    }
    if (isReconnect || preAccepted || locallyAccepted || peerAccepted) {
      void livekit.connect();
    }
  }, [
    isLiveKit,
    session,
    isReconnect,
    preAccepted,
    locallyAccepted,
    isIncoming,
    accepted,
    livekit,
    machine,
    dispatch,
  ]);

  useEffect(() => {
    if (!isLiveKit) return;
    if (preAccepted && !finishedRef.current) {
      dispatch({ type: "LOCAL_ACCEPT" });
    }
  }, [isLiveKit, preAccepted, dispatch]);

  // ─── Local terminal actions ───
  const handleEnd = useCallback(() => {
    if (isTerminalPhase(machine.getPhase())) return;
    if (usesLegacyEngine) {
      webrtc.handleEnd();
      runDurable("end", false);
      return;
    }
    endDurably();
  }, [usesLegacyEngine, machine, runDurable, webrtc, endDurably]);

  const handleReject = useCallback(() => {
    if (isTerminalPhase(machine.getPhase())) return;
    if (usesLegacyEngine) {
      webrtc.handleReject();
      runDurable("reject", false);
      return;
    }
    dispatch({ type: "LOCAL_REJECT" });
    runDurable("reject", true);
  }, [usesLegacyEngine, machine, dispatch, runDurable, webrtc]);

  const handleAccept = useCallback(async () => {
    if (isTerminalPhase(machine.getPhase())) return;
    // Answering before the verdict lands must not start the wrong engine, and a
    // failed negotiation must not silently answer on the legacy one.
    const resolved = await ensureSession();
    if (!resolved || isTerminalPhase(machine.getPhase())) return;
    if (resolved.backend === "p2p") return webrtc.handleAccept();
    dispatch({ type: "LOCAL_ACCEPT" });
    try {
      webrtc.stopRingtone();
    } catch {
      /* ignore */
    }
    wsSend("call_accept", { callId, conversationId });
    setLocallyAccepted(true);
    await livekit.connect();
  }, [
    ensureSession,
    machine,
    dispatch,
    webrtc,
    wsSend,
    callId,
    conversationId,
    livekit,
  ]);

  const noop = useCallback(() => {}, []);

  const mergedWebrtc = useMemo(() => {
    if (!isLiveKit) {
      return { ...webrtc, handleEnd, handleReject, handleAccept };
    }
    return {
      ...webrtc,
      handleEnd,
      handleReject,
      handleAccept,
      remoteVideoOff: livekit.remoteVideoOff,
      remoteHasVideo: livekit.remoteHasVideo,
      remoteMuted: livekit.remoteMuted,
      remoteScreenSharing: livekit.remoteScreenSharing,
      remotePeerQuality: livekit.remotePeerQuality,
      // On the SFU path the peer learns about mute/camera/screen-share from
      // track events, and quality from LiveKit's own reports — the p2p
      // `call_signal` side-channel would just be ignored noise.
      sendLocalVideoState: noop,
      sendLocalMuteState: noop,
      sendLocalScreenShareState: noop,
      sendQualityState: noop,
    };
  }, [isLiveKit, webrtc, livekit, handleEnd, handleReject, handleAccept, noop]);

  const mergedControls = useMemo(() => {
    if (!isLiveKit) return controls;
    return {
      ...controls,
      muted: livekit.muted,
      videoOff: livekit.videoOff,
      screenSharing: livekit.screenSharing,
      onHold: livekit.onHold,
      connectionQuality: livekit.connectionQuality,
      activeAudioDevice: livekit.activeAudioDevice || controls.activeAudioDevice,
      activeVideoDevice: livekit.activeVideoDevice || controls.activeVideoDevice,
      toggleMute: livekit.toggleMute,
      toggleVideo: livekit.toggleVideo,
      toggleScreenShare: livekit.toggleScreenShare,
      toggleHold: livekit.toggleHold,
      switchAudioDevice: livekit.switchAudioDevice,
      switchVideoDevice: livekit.switchVideoDevice,
    };
  }, [isLiveKit, controls, livekit]);

  return { webrtc: mergedWebrtc, controls: mergedControls, backend };
}
