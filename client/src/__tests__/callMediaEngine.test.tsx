import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

/* ── jsdom has no MediaStream ── */
class FakeMediaStream {
  private tracks: any[] = [];
  addTrack(t: any) {
    if (this.tracks.includes(t)) throw new Error("dup");
    this.tracks.push(t);
  }
  removeTrack(t: any) {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
}
(globalThis as any).MediaStream = FakeMediaStream;

const mocks = vi.hoisted(() => ({
  webrtc: null as any,
  webrtcParams: null as any,
  controls: null as any,
  getCallMediaSession: vi.fn(),
  rejectCallHttp: vi.fn(),
  endCallHttp: vi.fn(),
}));

vi.mock("../api", () => ({
  getCallMediaSession: mocks.getCallMediaSession,
  rejectCallHttp: mocks.rejectCallHttp,
  endCallHttp: mocks.endCallHttp,
}));

vi.mock("../components/chat/call/useWebRTC", () => ({
  default: (params: any) => {
    mocks.webrtcParams = params;
    return mocks.webrtc;
  },
}));

vi.mock("../components/chat/call/useCallControls", () => ({
  default: () => mocks.controls,
}));

import useCallMediaEngine from "../components/chat/call/media/useCallMediaEngine";
import { setLiveKitModuleLoader } from "../components/chat/call/media/livekitEngine";
import { forgetCallMediaSession } from "../components/chat/call/media/mediaSessionClient";
import { resetDurableCallActions } from "../components/chat/call/media/durableCallActions";

/* ── Fake livekit-client ── */
const RoomEvent = {
  Connected: "connected",
  Reconnecting: "reconnecting",
  SignalReconnecting: "signalReconnecting",
  Reconnected: "reconnected",
  Disconnected: "disconnected",
  TrackSubscribed: "trackSubscribed",
  TrackUnsubscribed: "trackUnsubscribed",
  TrackMuted: "trackMuted",
  TrackUnmuted: "trackUnmuted",
  ParticipantConnected: "participantConnected",
  ParticipantDisconnected: "participantDisconnected",
  LocalTrackPublished: "localTrackPublished",
  LocalTrackUnpublished: "localTrackUnpublished",
  ConnectionQualityChanged: "connectionQualityChanged",
  MediaDevicesError: "mediaDevicesError",
};
const p = (w: number, h: number) => ({
  resolution: { width: w, height: h, frameRate: 30 },
  encoding: { maxBitrate: w * h, maxFramerate: 30 },
});

let lastRoom: FakeRoom | null = null;

class FakeRoom {
  handlers = new Map<string, ((...a: any[]) => void)[]>();
  remoteParticipants = new Map<string, any>();
  localParticipant = {
    isLocal: true,
    trackPublications: new Map(),
    setMicrophoneEnabled: vi.fn(async () => {}),
    setCameraEnabled: vi.fn(async () => {}),
    setScreenShareEnabled: vi.fn(async () => {}),
  };
  connect = vi.fn(async () => {});
  disconnect = vi.fn(async () => {});
  removeAllListeners = vi.fn(() => this.handlers.clear());
  switchActiveDevice = vi.fn(async () => true);
  getActiveDevice = vi.fn(() => "device-1");
  constructor(_options: any) {
    lastRoom = this;
  }
  on(event: string, handler: (...a: any[]) => void) {
    const list = this.handlers.get(event) || [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }
  emit(event: string, ...args: any[]) {
    for (const h of this.handlers.get(event) || []) h(...args);
  }
  addRemote(id: string) {
    this.remoteParticipants.set(id, {
      identity: id,
      isLocal: false,
      trackPublications: new Map([
        [
          "a",
          {
            kind: "audio",
            source: "microphone",
            isMuted: false,
            track: { mediaStreamTrack: { kind: "audio", id: "a1" } },
          },
        ],
      ]),
    });
  }
  removeRemote(id: string) {
    this.remoteParticipants.delete(id);
  }
}

const fakeLiveKit = {
  Room: FakeRoom,
  RoomEvent,
  Track: { Source: { ScreenShare: "screen_share", ScreenShareAudio: "screen_share_audio" } },
  VideoPresets: { h180: p(320, 180), h360: p(640, 360), h540: p(960, 540) },
  ScreenSharePresets: { h360fps15: p(640, 360), h1080fps15: p(1920, 1080) },
} as any;

const ref = <T,>(v: T | null = null) => ({ current: v }) as React.MutableRefObject<T | null>;

function webrtcStub() {
  return {
    pcRef: ref<any>(),
    qualityControllerRef: ref<any>(),
    localStreamRef: ref<any>(),
    screenStreamRef: ref<any>(),
    remoteStreamRef: ref<any>(),
    localVideoRef: ref<any>(),
    remoteVideoRef: ref<any>(),
    remoteAudioRef: ref<any>(),
    screenSenderRef: ref<any>(),
    connectionTimeoutRef: ref<any>(),
    ringtoneRef: ref<any>(),
    handleAccept: vi.fn(),
    handleReject: vi.fn(),
    handleEnd: vi.fn(),
    stopRingtone: vi.fn(),
    startMedia: vi.fn(),
    createPeerConnection: vi.fn(),
    isMobile: false,
    remoteVideoOff: false,
    remoteHasVideo: false,
    remoteMuted: false,
    remoteScreenSharing: false,
    sendLocalVideoState: vi.fn(),
    sendLocalMuteState: vi.fn(),
    sendLocalScreenShareState: vi.fn(),
    sendQualityState: vi.fn(),
    remotePeerQuality: "unknown",
    localVideoOff: false,
  };
}

function controlsStub() {
  return {
    muted: false,
    videoOff: false,
    screenSharing: false,
    onHold: false,
    isFullscreen: false,
    connectionQuality: "unknown",
    detailedStats: null,
    audioDevices: [],
    videoDevices: [],
    activeAudioDevice: "",
    activeVideoDevice: "",
    showAudioDevices: false,
    setShowAudioDevices: vi.fn(),
    showVideoDevices: false,
    setShowVideoDevices: vi.fn(),
    setStatsPanelOpen: vi.fn(),
    toggleMute: vi.fn(),
    toggleVideo: vi.fn(),
    toggleScreenShare: vi.fn(),
    toggleHold: vi.fn(),
    toggleFullscreen: vi.fn(),
    togglePiP: vi.fn(),
    switchAudioDevice: vi.fn(),
    switchVideoDevice: vi.fn(),
    startQualityMonitor: vi.fn(),
    recording: false,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    noiseSuppression: false,
    toggleNoiseSuppression: vi.fn(),
  };
}

const livekitBody = {
  backend: "livekit",
  callId: 7,
  conversationId: 3,
  livekit: { serverUrl: "wss://sfu.example.com", token: "jwt", roomName: "call-7" },
};

function setup(overrides: Record<string, any> = {}) {
  const wsSend = vi.fn();
  const onEnd = vi.fn();
  const statuses: string[] = [];
  const callState = {
    callId: 7,
    conversationId: 3,
    isIncoming: true,
    callerId: 42,
    accepted: false,
    preAccepted: false,
    isReconnect: false,
    onSignal: { current: null, pendingSignalsRef: { current: [] } },
    onEndExternal: { current: null as null | (() => void) },
    localStream: null,
    ...overrides,
  };

  const view = renderHook(() =>
    useCallMediaEngine({
      callState,
      callType: "video",
      wsSend,
      onEnd,
      onStatusChange: (s: string) => statuses.push(s),
      overlayRef: ref<HTMLElement>(),
    }),
  );

  return { view, wsSend, onEnd, statuses, callState };
}

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
};

/** `settle()` for tests running on fake timers. */
const settleFake = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);
  });
};

/** Bring an incoming LiveKit call all the way to `connected`. */
async function connectWithPeer(view: any) {
  await act(async () => {
    await view.result.current.webrtc.handleAccept();
  });
  lastRoom!.addRemote("bob");
  await act(async () => {
    lastRoom!.emit(RoomEvent.Connected);
    lastRoom!.emit(RoomEvent.ParticipantConnected);
  });
  await settle();
}

describe("useCallMediaEngine", () => {
  beforeEach(() => {
    lastRoom = null;
    mocks.webrtc = webrtcStub();
    mocks.controls = controlsStub();
    mocks.webrtcParams = null;
    mocks.getCallMediaSession.mockReset();
    mocks.rejectCallHttp.mockReset().mockResolvedValue({ data: { ok: true } });
    mocks.endCallHttp.mockReset().mockResolvedValue({ data: { ok: true } });
    forgetCallMediaSession();
    resetDurableCallActions();
    setLiveKitModuleLoader(async () => fakeLiveKit);
  });

  it("keeps the legacy p2p engine when the server says p2p", async () => {
    mocks.getCallMediaSession.mockResolvedValue({ data: { backend: "p2p" } });
    const { view } = setup();
    await waitFor(() => expect(view.result.current.backend).toBe("p2p"));
    expect(mocks.webrtcParams.disabled).toBe(false);
    expect(lastRoom).toBeNull();
  });

  it("selects livekit and leaves the legacy p2p engine inert", async () => {
    mocks.getCallMediaSession.mockResolvedValue({ data: livekitBody });
    const { view } = setup();
    await waitFor(() => expect(view.result.current.backend).toBe("livekit"));
    expect(mocks.webrtcParams.disabled).toBe(true);
  });

  /*
   * No local transport choice, ever. Guessing p2p here would happily connect
   * the local peer to nothing while the server had already put the other peer
   * in an SFU room.
   */
  it("fails call setup instead of degrading to p2p when negotiation fails", async () => {
    mocks.getCallMediaSession.mockRejectedValue({ response: { status: 404 } });
    const { view, statuses, onEnd, wsSend } = setup();
    await waitFor(() => expect(onEnd).toHaveBeenCalled(), { timeout: 4000 });

    expect(view.result.current.backend).toBeNull();
    expect(mocks.webrtcParams.disabled).toBe(true);
    expect(lastRoom).toBeNull();
    expect(statuses.at(-1)).toBe("ended");
    // The peer must not be left ringing at a call that can never have media.
    expect(wsSend.mock.calls.filter(([t]) => t === "call_end")).toHaveLength(1);
    expect(mocks.endCallHttp).toHaveBeenCalledWith(7, 3);
  });

  it("does not answer on the legacy engine when negotiation failed", async () => {
    mocks.getCallMediaSession.mockRejectedValue(new Error("network down"));
    const { view, onEnd } = setup();
    await waitFor(() => expect(onEnd).toHaveBeenCalled(), { timeout: 4000 });
    await act(async () => {
      await view.result.current.webrtc.handleAccept();
    });
    expect(mocks.webrtc.handleAccept).not.toHaveBeenCalled();
    expect(lastRoom).toBeNull();
  });

  it("fails call setup on a malformed livekit verdict", async () => {
    mocks.getCallMediaSession.mockResolvedValue({
      data: { backend: "livekit", callId: 7, conversationId: 3 },
    });
    const { view, statuses, onEnd } = setup();
    await waitFor(() => expect(onEnd).toHaveBeenCalled(), { timeout: 4000 });
    expect(view.result.current.backend).toBeNull();
    expect(statuses.at(-1)).toBe("ended");
    expect(lastRoom).toBeNull();
  });

  it("releases the pre-acquired outgoing capture when the call dies before connect", async () => {
    mocks.getCallMediaSession.mockResolvedValue({ data: livekitBody });
    const camera = { kind: "video", id: "cam", stop: vi.fn() };
    const preAcquired = new FakeMediaStream();
    preAcquired.addTrack(camera);

    const { view, callState } = setup({
      isIncoming: false,
      localStream: preAcquired,
    });
    await waitFor(() => expect(view.result.current.backend).toBe("livekit"));
    // Callee declined while we were still ringing — `connect()` never ran.
    await act(async () => {
      callState.onEndExternal.current?.();
    });
    await settle();

    expect(lastRoom).toBeNull();
    expect(camera.stop).toHaveBeenCalled();
  });

  it("releases the pre-acquired capture even if the backend never resolved", async () => {
    mocks.getCallMediaSession.mockReturnValue(new Promise(() => {}));
    const camera = { kind: "video", id: "cam", stop: vi.fn() };
    const preAcquired = new FakeMediaStream();
    preAcquired.addTrack(camera);

    const { view } = setup({ isIncoming: false, localStream: preAcquired });
    await settle();
    expect(view.result.current.backend).toBeNull();

    await act(async () => {
      view.result.current.webrtc.handleEnd();
    });
    await settle();
    expect(camera.stop).toHaveBeenCalled();
  });

  it("never falls back mid-call when the SFU transport drops", async () => {
    mocks.getCallMediaSession.mockResolvedValue({ data: livekitBody });
    const { view, statuses, onEnd } = setup();
    await waitFor(() => expect(view.result.current.backend).toBe("livekit"));

    await act(async () => {
      await view.result.current.webrtc.handleAccept();
    });
    lastRoom!.addRemote("bob");
    await act(async () => {
      lastRoom!.emit(RoomEvent.Connected);
      lastRoom!.emit(RoomEvent.ParticipantConnected);
    });
    await settle();
    expect(statuses).toContain("connected");

    await act(async () => {
      lastRoom!.emit(RoomEvent.Disconnected, "SIGNAL_CLOSE");
    });
    await settle();

    // A dead SFU socket is a "reconnecting" call, never an ended one, and it
    // must not hand the call back to the p2p engine.
    expect(statuses.at(-1)).toBe("reconnecting");
    expect(view.result.current.backend).toBe("livekit");
    expect(mocks.webrtcParams.disabled).toBe(true);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("ends the call on a remote terminal event and tears the room down", async () => {
    mocks.getCallMediaSession.mockResolvedValue({ data: livekitBody });
    const { view, onEnd, statuses, callState } = setup();
    await waitFor(() => expect(view.result.current.backend).toBe("livekit"));

    await act(async () => {
      await view.result.current.webrtc.handleAccept();
    });
    lastRoom!.addRemote("bob");
    await act(async () => {
      lastRoom!.emit(RoomEvent.Connected);
      lastRoom!.emit(RoomEvent.ParticipantConnected);
    });
    await settle();
    const room = lastRoom!;

    await act(async () => {
      callState.onEndExternal.current?.();
    });
    await settle();

    expect(statuses.at(-1)).toBe("ended");
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(room.disconnect).toHaveBeenCalled();
    expect(mocks.webrtc.remoteStreamRef.current).toBeNull();
    expect(mocks.webrtc.stopRingtone).toHaveBeenCalled();
  });

  it("absorbs a late Room connected callback after the call already ended", async () => {
    mocks.getCallMediaSession.mockResolvedValue({ data: livekitBody });
    const { view, onEnd, statuses, callState } = setup();
    await waitFor(() => expect(view.result.current.backend).toBe("livekit"));

    await act(async () => {
      await view.result.current.webrtc.handleAccept();
    });
    const room = lastRoom!;
    await act(async () => {
      callState.onEndExternal.current?.();
    });
    await settle();
    expect(statuses.at(-1)).toBe("ended");

    await act(async () => {
      room.addRemote("bob");
      room.emit(RoomEvent.Connected);
      room.emit(RoomEvent.ParticipantConnected);
      room.emit(RoomEvent.Reconnected);
    });
    await settle();

    expect(statuses.at(-1)).toBe("ended");
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("makes a local hang-up on the livekit path durable", async () => {
    mocks.getCallMediaSession.mockResolvedValue({ data: livekitBody });
    const { view, wsSend, onEnd } = setup();
    await waitFor(() => expect(view.result.current.backend).toBe("livekit"));

    await act(async () => {
      view.result.current.webrtc.handleEnd();
    });
    await settle();

    const endFrame = wsSend.mock.calls.find(([type]) => type === "call_end");
    expect(endFrame).toBeTruthy();
    expect(endFrame![1].clientMsgId).toMatch(/^web:end:7:3:/);
    expect(mocks.endCallHttp).toHaveBeenCalledWith(7, 3);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("makes a local decline on the livekit path durable and idempotent", async () => {
    mocks.getCallMediaSession.mockResolvedValue({ data: livekitBody });
    const { view, wsSend, statuses } = setup();
    await waitFor(() => expect(view.result.current.backend).toBe("livekit"));

    await act(async () => {
      view.result.current.webrtc.handleReject();
      view.result.current.webrtc.handleReject();
    });
    await settle();

    expect(statuses.at(-1)).toBe("rejected");
    expect(wsSend.mock.calls.filter(([t]) => t === "call_reject")).toHaveLength(1);
    expect(mocks.rejectCallHttp).toHaveBeenCalledTimes(1);
  });

  it("adds the HTTP confirmation to the p2p path without double-emitting", async () => {
    mocks.getCallMediaSession.mockResolvedValue({ data: { backend: "p2p" } });
    const { view, wsSend } = setup();
    await waitFor(() => expect(view.result.current.backend).toBe("p2p"));

    await act(async () => {
      view.result.current.webrtc.handleEnd();
    });
    await settle();

    // `useWebRTC.handleEnd` owns the websocket emit on this path.
    expect(mocks.webrtc.handleEnd).toHaveBeenCalledTimes(1);
    expect(wsSend.mock.calls.filter(([t]) => t === "call_end")).toHaveLength(0);
    expect(mocks.endCallHttp).toHaveBeenCalledWith(7, 3);
  });

  it("waits for the callId before negotiating an outgoing call", async () => {
    mocks.getCallMediaSession.mockResolvedValue({ data: livekitBody });
    const { view } = setup({ callId: undefined, isIncoming: false });
    await settle();
    expect(mocks.getCallMediaSession).not.toHaveBeenCalled();
    expect(view.result.current.backend).toBeNull();
    expect(mocks.webrtcParams.disabled).toBe(true);
  });

  it("waits for the backend verdict before answering, so an early accept can't start the wrong engine", async () => {
    let release!: (v: any) => void;
    mocks.getCallMediaSession.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const { view, wsSend } = setup();
    await settle();
    expect(view.result.current.backend).toBeNull();

    let accepting!: Promise<unknown>;
    await act(async () => {
      accepting = view.result.current.webrtc.handleAccept() as Promise<unknown>;
    });
    // Nothing may happen while the verdict is outstanding.
    expect(mocks.webrtc.handleAccept).not.toHaveBeenCalled();
    expect(lastRoom).toBeNull();

    await act(async () => {
      release({ data: livekitBody });
      await accepting;
    });
    await settle();

    expect(mocks.webrtc.handleAccept).not.toHaveBeenCalled();
    expect(lastRoom).not.toBeNull();
    expect(wsSend.mock.calls.some(([t]) => t === "call_accept")).toBe(true);
  });

  it("owns the socket emit for a hang-up taken before the backend is known", async () => {
    mocks.getCallMediaSession.mockReturnValue(new Promise(() => {}));
    const { view, wsSend, onEnd } = setup();
    await settle();
    expect(view.result.current.backend).toBeNull();

    await act(async () => {
      view.result.current.webrtc.handleEnd();
    });
    await settle();

    // The legacy engine is disabled here, so nobody else would have told the
    // peer: the durable helper must emit AND confirm over HTTP.
    expect(mocks.webrtc.handleEnd).not.toHaveBeenCalled();
    expect(wsSend.mock.calls.filter(([t]) => t === "call_end")).toHaveLength(1);
    expect(mocks.endCallHttp).toHaveBeenCalledWith(7, 3);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  /*
   * Caller side, `call_accepted`. The p2p engine reacts to this by going to
   * `connecting` and stopping the ringback; without the same reaction on the
   * SFU path the overlay keeps ringing and keeps its 35s "No answer" timer
   * armed instead of the 30s connect timeout.
   */
  it("moves an accepted outgoing livekit call to connecting exactly once", async () => {
    mocks.getCallMediaSession.mockResolvedValue({ data: livekitBody });
    const { view, statuses, callState } = setup({
      isIncoming: false,
      accepted: false,
    });
    await waitFor(() => expect(view.result.current.backend).toBe("livekit"));
    expect(statuses).not.toContain("connecting");
    // Still ringing: nothing joins the room before the callee answers.
    expect(lastRoom).toBeNull();

    await act(async () => {
      callState.accepted = true;
      view.rerender();
    });
    await settle();

    expect(statuses.filter((s) => s === "connecting")).toHaveLength(1);
    expect(mocks.webrtc.stopRingtone).toHaveBeenCalled();
    expect(lastRoom).not.toBeNull();

    // Re-renders must not re-announce it (and must not re-join).
    await act(async () => {
      view.rerender();
      view.rerender();
    });
    await settle();
    expect(statuses.filter((s) => s === "connecting")).toHaveLength(1);
    expect(lastRoom!.connect).toHaveBeenCalledTimes(1);
  });

  it("keeps a connected call connected when the accept notification lands late", async () => {
    mocks.getCallMediaSession.mockResolvedValue({ data: livekitBody });
    const { view, statuses, callState } = setup({
      isIncoming: false,
      accepted: false,
      preAccepted: true,
    });
    await waitFor(() => expect(view.result.current.backend).toBe("livekit"));
    await waitFor(() => expect(lastRoom).not.toBeNull());
    lastRoom!.addRemote("bob");
    await act(async () => {
      lastRoom!.emit(RoomEvent.Connected);
      lastRoom!.emit(RoomEvent.ParticipantConnected);
    });
    await settle();
    expect(statuses.at(-1)).toBe("connected");

    await act(async () => {
      callState.accepted = true;
      view.rerender();
    });
    await settle();

    expect(statuses.at(-1)).toBe("connected");
  });

  it("does not revive an ended outgoing call when the accept arrives afterwards", async () => {
    mocks.getCallMediaSession.mockResolvedValue({ data: livekitBody });
    const { view, statuses, onEnd, callState } = setup({
      isIncoming: false,
      accepted: false,
    });
    await waitFor(() => expect(view.result.current.backend).toBe("livekit"));

    await act(async () => {
      view.result.current.webrtc.handleEnd();
    });
    await settle();
    expect(statuses.at(-1)).toBe("ended");

    await act(async () => {
      callState.accepted = true;
      view.rerender();
    });
    await settle();

    expect(statuses.at(-1)).toBe("ended");
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(lastRoom).toBeNull();
  });

  /*
   * The peer's process dies. OUR room stays healthy, so nothing in the SDK
   * times out — the participant just leaves. That is a reconnecting call with a
   * bounded budget, not an ended one.
   */
  it("shows reconnecting when the peer leaves and recovers when they return", async () => {
    mocks.getCallMediaSession.mockResolvedValue({ data: livekitBody });
    const { view, statuses, onEnd } = setup();
    await waitFor(() => expect(view.result.current.backend).toBe("livekit"));
    await connectWithPeer(view);
    expect(statuses.at(-1)).toBe("connected");

    vi.useFakeTimers();
    try {
      await act(async () => {
        lastRoom!.removeRemote("bob");
        lastRoom!.emit(RoomEvent.ParticipantDisconnected);
      });
      await settleFake();
      expect(statuses.at(-1)).toBe("reconnecting");
      expect(onEnd).not.toHaveBeenCalled();

      await act(async () => {
        lastRoom!.addRemote("bob");
        lastRoom!.emit(RoomEvent.ParticipantConnected);
      });
      await settleFake();
      expect(statuses.at(-1)).toBe("connected");

      // The watchdog must have been disarmed by the peer's return.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60000);
      });
      expect(statuses.at(-1)).toBe("connected");
      expect(onEnd).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the call durably when the peer never comes back", async () => {
    mocks.getCallMediaSession.mockResolvedValue({ data: livekitBody });
    const { view, statuses, onEnd, wsSend } = setup();
    await waitFor(() => expect(view.result.current.backend).toBe("livekit"));
    await connectWithPeer(view);
    const room = lastRoom!;

    vi.useFakeTimers();
    try {
      await act(async () => {
        room.removeRemote("bob");
        room.emit(RoomEvent.ParticipantDisconnected);
      });
      await settleFake();
      expect(statuses.at(-1)).toBe("reconnecting");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(29000);
      });
      expect(onEnd).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await settleFake();

      // Terminal through the SAME durable path the hang-up button uses:
      // WorkPulse still tells the server, the media engine did not "decide".
      expect(statuses.at(-1)).toBe("ended");
      expect(onEnd).toHaveBeenCalledTimes(1);
      expect(wsSend.mock.calls.filter(([t]) => t === "call_end")).toHaveLength(1);
      expect(mocks.endCallHttp).toHaveBeenCalledWith(7, 3);
      expect(room.disconnect).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not arm the no-peer watchdog before anyone ever joined", async () => {
    mocks.getCallMediaSession.mockResolvedValue({ data: livekitBody });
    const { view, statuses, onEnd } = setup();
    await waitFor(() => expect(view.result.current.backend).toBe("livekit"));
    await act(async () => {
      await view.result.current.webrtc.handleAccept();
    });
    // Room up, empty — this is still "ringing at the other end", which the
    // overlay's own ring timeout owns.
    vi.useFakeTimers();
    try {
      await act(async () => {
        lastRoom!.emit(RoomEvent.Connected);
      });
      await settleFake();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60000);
      });
      expect(statuses).not.toContain("reconnecting");
      expect(onEnd).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes the same webrtc + controls contract the overlay consumes", async () => {    mocks.getCallMediaSession.mockResolvedValue({ data: livekitBody });
    const { view } = setup();
    await waitFor(() => expect(view.result.current.backend).toBe("livekit"));

    for (const key of Object.keys(webrtcStub())) {
      expect(view.result.current.webrtc).toHaveProperty(key);
    }
    for (const key of Object.keys(controlsStub())) {
      expect(view.result.current.controls).toHaveProperty(key);
    }
  });
});
