import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  buildRoomOptions,
  createLiveKitEngine,
  mapConnectionQuality,
  setLiveKitModuleLoader,
  type LiveKitModule,
} from "../components/chat/call/media/livekitEngine";
import {
  createCallStateMachine,
  createSerialQueue,
  type SerialQueue,
} from "../components/chat/call/media/callStateMachine";

/* ── jsdom has no MediaStream; the engine keeps one per direction. ── */
class FakeMediaStream {
  private tracks: any[] = [];
  addTrack(track: any) {
    if (this.tracks.includes(track)) throw new Error("duplicate");
    this.tracks.push(track);
  }
  removeTrack(track: any) {
    this.tracks = this.tracks.filter((t) => t !== track);
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

/* ── Minimal fake of the parts of livekit-client the engine touches. ── */
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
} as const;

const Track = { Source: { ScreenShare: "screen_share", ScreenShareAudio: "screen_share_audio", Camera: "camera", Microphone: "microphone" } };
const preset = (w: number, h: number) => ({
  resolution: { width: w, height: h, frameRate: 30 },
  encoding: { maxBitrate: w * h, maxFramerate: 30 },
});
const VideoPresets = {
  h180: preset(320, 180),
  h360: preset(640, 360),
  h540: preset(960, 540),
};
const ScreenSharePresets = {
  h360fps15: preset(640, 360),
  h1080fps15: preset(1920, 1080),
};

function track(kind: "audio" | "video", id: string) {
  return { kind, id, stop: vi.fn() };
}

function publication(opts: {
  kind: "audio" | "video";
  source?: string;
  muted?: boolean;
  hasTrack?: boolean;
  id?: string;
}) {
  const mediaStreamTrack = opts.hasTrack === false ? undefined : track(opts.kind, opts.id || `${opts.kind}-${Math.random()}`);
  return {
    kind: opts.kind,
    source: opts.source || (opts.kind === "audio" ? "microphone" : "camera"),
    isMuted: !!opts.muted,
    track: mediaStreamTrack ? { mediaStreamTrack, source: opts.source } : undefined,
  };
}

class FakeRoom {
  handlers = new Map<string, ((...args: any[]) => void)[]>();
  remoteParticipants = new Map<string, any>();
  localParticipant: any = {
    isLocal: true,
    trackPublications: new Map<string, any>(),
    setMicrophoneEnabled: vi.fn(async () => {}),
    setCameraEnabled: vi.fn(async () => {}),
    setScreenShareEnabled: vi.fn(async () => {}),
  };
  connect = vi.fn(async () => {
    onRoomConnect?.();
  });
  disconnect = vi.fn(async () => {});
  removeAllListeners = vi.fn(() => this.handlers.clear());
  switchActiveDevice = vi.fn(async () => true);
  getActiveDevice = vi.fn(() => "device-1");
  options: any;

  constructor(options: any) {
    this.options = options;
    lastRoom = this;
  }
  on(event: string, handler: (...args: any[]) => void) {
    const list = this.handlers.get(event) || [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }
  emit(event: string, ...args: any[]) {
    for (const handler of this.handlers.get(event) || []) handler(...args);
  }
  addRemote(id: string, publications: any[]) {
    this.remoteParticipants.set(id, {
      identity: id,
      isLocal: false,
      trackPublications: new Map(publications.map((p, i) => [`${id}-${i}`, p])),
    });
  }
}

let lastRoom: FakeRoom | null = null;
/** Lets a test simulate `call_ended` landing during the SFU handshake. */
let onRoomConnect: (() => void) | null = null;

const fakeModule = {
  Room: FakeRoom,
  RoomEvent,
  Track,
  VideoPresets,
  ScreenSharePresets,
} as unknown as LiveKitModule;

function makeHandlers() {
  return {
    onConnected: vi.fn(),
    onReconnecting: vi.fn(),
    onReconnected: vi.fn(),
    onDisconnected: vi.fn(),
    onLocalStream: vi.fn(),
    onRemoteStream: vi.fn(),
    onRemoteHasVideo: vi.fn(),
    onRemoteVideoOff: vi.fn(),
    onRemoteMuted: vi.fn(),
    onRemoteScreenSharing: vi.fn(),
    onRemoteQuality: vi.fn(),
    onLocalQuality: vi.fn(),
    onRemoteParticipantCount: vi.fn(),
    onMediaError: vi.fn(),
  };
}

const credentials = {
  serverUrl: "wss://sfu.example.com",
  token: "jwt",
  roomName: "call-7",
};

async function flush(queue: SerialQueue) {
  await queue.enqueue(() => {});
  await queue.enqueue(() => {});
}

describe("mapConnectionQuality", () => {
  it("maps LiveKit quality onto the overlay's badge vocabulary", () => {
    expect(mapConnectionQuality("excellent")).toBe("good");
    expect(mapConnectionQuality("good")).toBe("fair");
    expect(mapConnectionQuality("poor")).toBe("poor");
    expect(mapConnectionQuality("lost")).toBe("poor");
    expect(mapConnectionQuality(undefined)).toBe("unknown");
  });
});

describe("buildRoomOptions", () => {
  it("uses dynacast and simulcast without adaptive stream for srcObject rendering", () => {
    const opts = buildRoomOptions(fakeModule, { isVideo: true, isMobile: false });
    expect(opts.adaptiveStream).toBe(false);
    expect(opts.dynacast).toBe(true);
    expect(opts.publishDefaults.simulcast).toBe(true);
    expect(opts.publishDefaults.videoSimulcastLayers.length).toBeGreaterThan(0);
    expect(opts.videoCaptureDefaults.resolution).toEqual(VideoPresets.h540.resolution);
    expect(opts.publishDefaults.screenShareEncoding).toBeDefined();
    expect(opts.audioCaptureDefaults.noiseSuppression).toBe(true);
  });

  it("captures smaller on mobile and skips video capture for voice calls", () => {
    const mobile = buildRoomOptions(fakeModule, { isVideo: true, isMobile: true });
    expect(mobile.videoCaptureDefaults.resolution).toEqual(VideoPresets.h360.resolution);
    const voice = buildRoomOptions(fakeModule, { isVideo: false, isMobile: false });
    expect(voice.videoCaptureDefaults).toBeUndefined();
  });
});

describe("createLiveKitEngine", () => {
  let queue: SerialQueue;
  let handlers: ReturnType<typeof makeHandlers>;

  beforeEach(() => {
    lastRoom = null;
    onRoomConnect = null;
    queue = createSerialQueue();
    handlers = makeHandlers();
    setLiveKitModuleLoader(async () => fakeModule);
  });

  const build = (isTerminal = () => false, callType = "video") =>
    createLiveKitEngine({
      credentials,
      callType,
      handlers,
      queue,
      isTerminal,
      loadModule: async () => fakeModule,
    });

  it("connects the room and publishes mic + camera for a video call", async () => {
    const engine = build();
    await engine.connect();
    expect(lastRoom!.connect).toHaveBeenCalledWith(credentials.serverUrl, credentials.token);
    expect(lastRoom!.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    expect(lastRoom!.localParticipant.setCameraEnabled).toHaveBeenCalledWith(true);
  });

  it("does not turn the camera on for a voice call", async () => {
    const engine = build(() => false, "voice");
    await engine.connect();
    expect(lastRoom!.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
  });

  it("maps remote tracks, mute, camera-off and screen share into the UI contract", async () => {
    const engine = build();
    await engine.connect();

    lastRoom!.addRemote("bob", [
      publication({ kind: "audio", muted: true }),
      publication({ kind: "video" }),
      publication({ kind: "video", source: "screen_share" }),
    ]);
    lastRoom!.emit(RoomEvent.TrackSubscribed);
    await flush(queue);

    expect(handlers.onRemoteMuted).toHaveBeenLastCalledWith(true);
    expect(handlers.onRemoteHasVideo).toHaveBeenLastCalledWith(true);
    expect(handlers.onRemoteVideoOff).toHaveBeenLastCalledWith(false);
    expect(handlers.onRemoteScreenSharing).toHaveBeenLastCalledWith(true);
    expect(handlers.onRemoteParticipantCount).toHaveBeenLastCalledWith(1);
    const stream = handlers.onRemoteStream.mock.lastCall?.[0];
    expect(stream.getTracks().length).toBe(3);
  });

  it("reports the peer's camera as off when their video track is muted", async () => {
    const engine = build();
    await engine.connect();
    lastRoom!.addRemote("bob", [
      publication({ kind: "audio" }),
      publication({ kind: "video", muted: true }),
    ]);
    lastRoom!.emit(RoomEvent.TrackMuted);
    await flush(queue);
    expect(handlers.onRemoteVideoOff).toHaveBeenLastCalledWith(true);
    // `remoteHasVideo` drives a layout swap, so it is only pushed on a real
    // change — a muted camera never claimed video in the first place.
    expect(handlers.onRemoteHasVideo).not.toHaveBeenCalledWith(true);
  });

  it("surfaces connect / reconnect / disconnect without ever ending the call", async () => {
    const machine = createCallStateMachine("connected");
    const engine = build(() => machine.isTerminal());
    await engine.connect();

    lastRoom!.emit(RoomEvent.Connected);
    lastRoom!.emit(RoomEvent.Reconnecting);
    lastRoom!.emit(RoomEvent.SignalReconnecting);
    lastRoom!.emit(RoomEvent.Reconnected);
    lastRoom!.emit(RoomEvent.Disconnected, "SIGNAL_CLOSE");
    await flush(queue);

    expect(handlers.onConnected).toHaveBeenCalledTimes(1);
    expect(handlers.onReconnecting).toHaveBeenCalledTimes(2);
    expect(handlers.onReconnected).toHaveBeenCalledTimes(1);
    expect(handlers.onDisconnected).toHaveBeenCalledWith("SIGNAL_CLOSE");

    // The media layer has no channel through which to end a call, and the
    // strongest thing a disconnect can do to the lifecycle is "reconnecting".
    expect(Object.keys(handlers)).not.toContain("onEnd");
    machine.dispatch({ type: "MEDIA_DISCONNECTED" });
    expect(machine.getPhase()).toBe("reconnecting");
    expect(machine.isTerminal()).toBe(false);
  });

  it("routes connection quality to the right side", async () => {
    const engine = build();
    await engine.connect();
    lastRoom!.emit(RoomEvent.ConnectionQualityChanged, "poor", lastRoom!.localParticipant);
    lastRoom!.emit(RoomEvent.ConnectionQualityChanged, "excellent", { isLocal: false });
    await flush(queue);
    expect(handlers.onLocalQuality).toHaveBeenLastCalledWith("poor");
    expect(handlers.onRemoteQuality).toHaveBeenLastCalledWith("good");
  });

  it("drops every room callback once the call is terminal", async () => {
    const machine = createCallStateMachine("connected");
    const engine = build(() => machine.isTerminal());
    await engine.connect();

    machine.dispatch({ type: "REMOTE_ENDED" });
    handlers.onConnected.mockClear();
    handlers.onRemoteStream.mockClear();

    lastRoom!.addRemote("bob", [publication({ kind: "video" })]);
    lastRoom!.emit(RoomEvent.Connected);
    lastRoom!.emit(RoomEvent.Reconnected);
    lastRoom!.emit(RoomEvent.TrackSubscribed);
    lastRoom!.emit(RoomEvent.ConnectionQualityChanged, "excellent", { isLocal: false });
    await flush(queue);

    expect(handlers.onConnected).not.toHaveBeenCalled();
    expect(handlers.onReconnected).not.toHaveBeenCalled();
    expect(handlers.onRemoteStream).not.toHaveBeenCalled();
    expect(handlers.onRemoteQuality).not.toHaveBeenCalled();
  });

  it("tears down a room that finished connecting after the call ended", async () => {
    let terminal = false;
    const engine = createLiveKitEngine({
      credentials,
      callType: "video",
      handlers,
      queue,
      isTerminal: () => terminal,
      loadModule: async () => fakeModule,
    });
    onRoomConnect = () => {
      terminal = true; // `call_ended` lands mid-handshake
    };

    await engine.connect();

    expect(lastRoom!.disconnect).toHaveBeenCalled();
    expect(lastRoom!.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(handlers.onConnected).not.toHaveBeenCalled();
  });

  it("cleans the room up on disconnect and ignores later events", async () => {
    const engine = build();
    await engine.connect();
    const room = lastRoom!;
    await engine.disconnect();

    expect(room.removeAllListeners).toHaveBeenCalled();
    expect(room.disconnect).toHaveBeenCalled();
    expect(engine.getRoom()).toBeNull();
    expect(engine.isConnected()).toBe(false);

    handlers.onConnected.mockClear();
    room.emit(RoomEvent.Connected);
    await flush(queue);
    expect(handlers.onConnected).not.toHaveBeenCalled();
  });

  it("drives mute, camera, screen share and device switching through the SDK", async () => {
    const engine = build();
    await engine.connect();
    const local = lastRoom!.localParticipant;

    await engine.setMicrophoneEnabled(false);
    expect(local.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);

    await engine.setCameraEnabled(false);
    expect(local.setCameraEnabled).toHaveBeenLastCalledWith(false);

    await engine.setScreenShareEnabled(true);
    expect(local.setScreenShareEnabled).toHaveBeenCalledWith(true, expect.any(Object));

    expect(await engine.switchDevice("audioinput", "mic-2")).toBe(true);
    expect(lastRoom!.switchActiveDevice).toHaveBeenCalledWith("audioinput", "mic-2");
  });

  it("publishes the local stream to the UI as tracks appear", async () => {
    const engine = build();
    await engine.connect();
    lastRoom!.localParticipant.trackPublications.set("a", publication({ kind: "audio" }));
    lastRoom!.localParticipant.trackPublications.set("v", publication({ kind: "video" }));
    lastRoom!.emit(RoomEvent.LocalTrackPublished);
    await flush(queue);
    const stream = handlers.onLocalStream.mock.lastCall?.[0];
    expect(stream.getTracks().length).toBe(2);
  });

  /*
   * Handing the overlay a NEW MediaStream on every event would re-assign
   * <video>/<audio>.srcObject each time, which restarts the element: black
   * frame, audio gap, autoplay churn. The instance must be stable and only its
   * membership reconciled.
   */
  it("keeps ONE remote stream instance and only re-publishes on membership change", async () => {
    const engine = build();
    await engine.connect();

    const audio = publication({ kind: "audio", id: "a1" });
    const video = publication({ kind: "video", id: "v1" });
    lastRoom!.addRemote("bob", [audio, video]);
    lastRoom!.emit(RoomEvent.TrackSubscribed);
    await flush(queue);

    const first = handlers.onRemoteStream.mock.lastCall?.[0];
    expect(first.getTracks().length).toBe(2);
    const publishes = handlers.onRemoteStream.mock.calls.length;

    // Mute / unmute / quality churn: same tracks, so nothing is re-published.
    audio.isMuted = true;
    lastRoom!.emit(RoomEvent.TrackMuted);
    audio.isMuted = false;
    lastRoom!.emit(RoomEvent.TrackUnmuted);
    lastRoom!.emit(RoomEvent.ConnectionQualityChanged, "poor", { isLocal: false });
    await flush(queue);

    expect(handlers.onRemoteStream.mock.calls.length).toBe(publishes);
    // The mute flags themselves still flow through.
    expect(handlers.onRemoteMuted).toHaveBeenLastCalledWith(false);

    // A real membership change reuses the SAME instance, mutated in place.
    lastRoom!.addRemote("bob", [audio]);
    lastRoom!.emit(RoomEvent.TrackUnsubscribed);
    await flush(queue);

    const second = handlers.onRemoteStream.mock.lastCall?.[0];
    expect(second).toBe(first);
    expect(second.getTracks().length).toBe(1);
    expect(handlers.onRemoteStream.mock.calls.length).toBe(publishes + 1);
  });

  it("keeps ONE local stream instance across mute and device churn", async () => {
    const engine = build();
    await engine.connect();
    const mic = publication({ kind: "audio", id: "mic" });
    lastRoom!.localParticipant.trackPublications.set("a", mic);
    lastRoom!.emit(RoomEvent.LocalTrackPublished);
    await flush(queue);

    const first = handlers.onLocalStream.mock.lastCall?.[0];
    const publishes = handlers.onLocalStream.mock.calls.length;

    await engine.setMicrophoneEnabled(false);
    await engine.setMicrophoneEnabled(true);
    await engine.switchDevice("audioinput", "mic-2");
    await flush(queue);
    expect(handlers.onLocalStream.mock.calls.length).toBe(publishes);

    lastRoom!.localParticipant.trackPublications.set(
      "v",
      publication({ kind: "video", id: "cam" }),
    );
    lastRoom!.emit(RoomEvent.LocalTrackPublished);
    await flush(queue);
    const second = handlers.onLocalStream.mock.lastCall?.[0];
    expect(second).toBe(first);
    expect(second.getTracks().length).toBe(2);
  });

  it("reports device errors instead of failing the connect", async () => {
    const engine = build();
    const boom = new Error("NotAllowedError");
    await engine.connect();
    lastRoom!.emit(RoomEvent.MediaDevicesError, boom);
    await flush(queue);
    expect(handlers.onMediaError).toHaveBeenCalledWith(boom);
  });
});
