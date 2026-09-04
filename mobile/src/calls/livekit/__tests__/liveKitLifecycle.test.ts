import { DisconnectReason, RoomEvent } from "livekit-client";
import {
  LiveKitCallLifecycle,
  type LiveKitAudioBridge,
  type LiveKitRoomLike,
} from "../liveKitLifecycle";

type Listener = (...args: unknown[]) => void;

class FakeRoom implements LiveKitRoomLike {
  localParticipant = {
    trackPublications: new Map(),
    setMicrophoneEnabled: jest.fn(async () => undefined),
    setCameraEnabled: jest.fn(async () => undefined),
  };
  remoteParticipants = new Map();
  private listeners = new Map<RoomEvent, Set<Listener>>();
  connect = jest.fn(async () => undefined);
  disconnect = jest.fn(async () => undefined);

  on(event: RoomEvent, listener: Listener) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: RoomEvent, listener: Listener) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: RoomEvent, ...args: unknown[]) {
    this.listeners.get(event)?.forEach((listener) => listener(...args));
  }
}

const session = {
  backend: "livekit" as const,
  callId: 8,
  conversationId: 3,
  livekit: {
    serverUrl: "wss://live.example.test",
    token: "token",
    roomName: "call-8",
  },
};

function setup(peerWatchdogMs = 30_000) {
  const room = new FakeRoom();
  const audio: jest.Mocked<LiveKitAudioBridge> = {
    configure: jest.fn(async (_callType: "voice" | "video") => undefined),
    start: jest.fn(async () => undefined),
    stop: jest.fn(async () => undefined),
    selectOutput: jest.fn(
      async (_speaker: boolean, _callType: "voice" | "video") => undefined,
    ),
  };
  const callbacks = {
    onConnected: jest.fn(),
    onReconnecting: jest.fn(),
    onLocalStream: jest.fn(),
    onRemoteStream: jest.fn(),
    onRemoteMuted: jest.fn(),
    onRemoteVideoOff: jest.fn(),
    onConnectionQuality: jest.fn(),
    onPeerQuality: jest.fn(),
    onPermissionDenied: jest.fn(),
    onError: jest.fn(),
  };
  const lifecycle = new LiveKitCallLifecycle(
    room,
    audio,
    callbacks,
    peerWatchdogMs,
  );
  return { room, audio, callbacks, lifecycle };
}

describe("LiveKit call lifecycle", () => {
  it("gates connected on a remote participant and tracks peer departure", async () => {
    const { room, callbacks, lifecycle } = setup();

    await lifecycle.start({
      session,
      callType: "voice",
      muted: false,
      videoOff: true,
      speaker: false,
      requestPermissions: async () => true,
    });
    room.emit(RoomEvent.Connected);
    expect(callbacks.onConnected).not.toHaveBeenCalled();

    room.remoteParticipants.set("peer", {
      trackPublications: new Map(),
    });
    room.emit(RoomEvent.ParticipantConnected);
    expect(callbacks.onConnected).toHaveBeenCalledTimes(1);

    room.remoteParticipants.delete("peer");
    room.emit(RoomEvent.ParticipantDisconnected);
    expect(callbacks.onReconnecting).toHaveBeenCalledTimes(1);

    await lifecycle.stop(true);
  });

  it("maps track and quality events into call UI state", async () => {
    const { room, callbacks, lifecycle } = setup();
    const localStream = { id: "local" };
    const remoteStream = { id: "remote" };
    room.localParticipant.trackPublications.set("camera", {
      source: "camera",
      track: { source: "camera", mediaStream: localStream },
    });
    const remote = {
      trackPublications: new Map([
        [
          "camera",
          {
            source: "camera",
            isMuted: false,
            track: { source: "camera", mediaStream: remoteStream },
          },
        ],
        ["microphone", { source: "microphone", isMuted: true }],
      ]),
    };
    room.remoteParticipants.set("peer", remote);

    await lifecycle.start({
      session,
      callType: "video",
      muted: false,
      videoOff: false,
      speaker: true,
      requestPermissions: async () => true,
    });
    room.emit(RoomEvent.Connected);
    room.emit(RoomEvent.Reconnecting);
    room.emit(RoomEvent.ConnectionQualityChanged, "poor", remote);

    expect(callbacks.onConnected).toHaveBeenCalledTimes(1);
    expect(callbacks.onReconnecting).toHaveBeenCalledTimes(1);
    expect(callbacks.onLocalStream).toHaveBeenCalledWith(localStream);
    expect(callbacks.onRemoteStream).toHaveBeenCalledWith(remoteStream);
    expect(callbacks.onRemoteMuted).toHaveBeenLastCalledWith(true);
    expect(callbacks.onPeerQuality).toHaveBeenCalledWith("poor");
    await lifecycle.stop(true);
  });

  it("fails a connected room that never receives a peer", async () => {
    jest.useFakeTimers();
    const { callbacks, lifecycle } = setup(1_000);

    await lifecycle.start({
      session,
      callType: "voice",
      muted: false,
      videoOff: true,
      speaker: false,
      requestPermissions: async () => true,
    });
    await jest.advanceTimersByTimeAsync(1_000);

    expect(callbacks.onConnected).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Timed out waiting for the other LiveKit participant",
      }),
    );
    await lifecycle.stop(true);
    jest.useRealTimers();
  });

  it.each([
    DisconnectReason.CLIENT_INITIATED,
    DisconnectReason.PARTICIPANT_REMOVED,
    DisconnectReason.ROOM_DELETED,
    DisconnectReason.ROOM_CLOSED,
  ])("silently cleans up terminal disconnect reason %s", async (reason) => {
    const { room, audio, callbacks, lifecycle } = setup();
    await lifecycle.start({
      session,
      callType: "voice",
      muted: false,
      videoOff: true,
      speaker: false,
      requestPermissions: async () => true,
    });

    room.emit(RoomEvent.Disconnected, reason);
    await lifecycle.stop(true);

    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onReconnecting).not.toHaveBeenCalled();
    expect(audio.stop).toHaveBeenCalledTimes(1);
  });

  it("reports a genuine transport disconnect", async () => {
    const { room, callbacks, lifecycle } = setup();
    await lifecycle.start({
      session,
      callType: "voice",
      muted: false,
      videoOff: true,
      speaker: false,
      requestPermissions: async () => true,
    });

    room.emit(RoomEvent.Disconnected, DisconnectReason.SIGNAL_CLOSE);

    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("SIGNAL_CLOSE"),
      }),
    );
    await lifecycle.stop(true);
  });

  it("does not connect when stop races audio output selection", async () => {
    const { room, audio, lifecycle } = setup();
    let releaseOutput!: () => void;
    let markOutputStarted!: () => void;
    const outputStarted = new Promise<void>((resolve) => {
      markOutputStarted = resolve;
    });
    audio.selectOutput.mockImplementationOnce(() => {
      markOutputStarted();
      return new Promise<void>((resolve) => {
        releaseOutput = resolve;
      });
    });

    const starting = lifecycle.start({
      session,
      callType: "voice",
      muted: false,
      videoOff: true,
      speaker: false,
      requestPermissions: async () => true,
    });
    await outputStarted;
    const stopping = lifecycle.stop(true);
    releaseOutput();
    await Promise.all([starting, stopping]);

    expect(room.connect).not.toHaveBeenCalled();
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    expect(audio.stop).toHaveBeenCalledTimes(1);
  });

  it("disconnects after an in-flight connect completes during stop", async () => {
    const { room, audio, lifecycle } = setup();
    let releaseConnect!: () => void;
    let markConnectStarted!: () => void;
    const connectStarted = new Promise<void>((resolve) => {
      markConnectStarted = resolve;
    });
    room.connect.mockImplementationOnce(() => {
      markConnectStarted();
      return new Promise<undefined>((resolve) => {
        releaseConnect = () => resolve(undefined);
      });
    });

    const starting = lifecycle.start({
      session,
      callType: "voice",
      muted: false,
      videoOff: true,
      speaker: false,
      requestPermissions: async () => true,
    });
    await connectStarted;
    const stopping = lifecycle.stop(true);
    expect(room.disconnect).not.toHaveBeenCalled();
    releaseConnect();
    await Promise.all([starting, stopping]);

    expect(room.connect).toHaveBeenCalledTimes(1);
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    expect(audio.stop).toHaveBeenCalledTimes(1);
  });

  it("cleans up a remote terminal once and absorbs late Room events", async () => {
    const { room, audio, callbacks, lifecycle } = setup();
    await lifecycle.start({
      session,
      callType: "voice",
      muted: false,
      videoOff: true,
      speaker: false,
      requestPermissions: async () => true,
    });

    await lifecycle.stop(true);
    await lifecycle.stop(true);
    room.emit(RoomEvent.Connected);
    room.emit(RoomEvent.Reconnected);

    expect(room.disconnect).toHaveBeenCalledTimes(1);
    expect(room.disconnect).toHaveBeenCalledWith(true);
    expect(audio.start).toHaveBeenCalledTimes(1);
    expect(audio.stop).toHaveBeenCalledTimes(1);
    expect(callbacks.onConnected).not.toHaveBeenCalled();
    expect(callbacks.onLocalStream).toHaveBeenLastCalledWith(null);
    expect(callbacks.onRemoteStream).toHaveBeenLastCalledWith(null);
  });

  it("reports permission denial without trying another backend", async () => {
    const { room, audio, callbacks, lifecycle } = setup();
    await lifecycle.start({
      session,
      callType: "video",
      muted: false,
      videoOff: false,
      speaker: true,
      requestPermissions: async () => false,
    });

    expect(callbacks.onPermissionDenied).toHaveBeenCalledTimes(1);
    expect(room.connect).not.toHaveBeenCalled();
    expect(audio.start).not.toHaveBeenCalled();
  });
});
