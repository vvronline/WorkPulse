/**
 * LiveKit media engine — the SFU side of the media-engine adapter.
 *
 * This module is deliberately React-free so the whole Room lifecycle can be
 * unit tested against a fake Room. It owns exactly one thing: mapping LiveKit
 * `Room` events onto the small `MediaEngineHandlers` surface the existing call
 * overlay already understands (local stream, remote stream, remote mute /
 * camera / screen-share flags, connection quality).
 *
 * Two hard rules, both enforced here rather than at the call sites:
 *
 *  1. **Media never ends a call.** `RoomEvent.Disconnected` (including a
 *     server-initiated disconnect) reports `onDisconnected` and nothing else.
 *     Ending, rejecting and cancelling remain WorkPulse websocket events.
 *  2. **Terminal state is respected.** Every handler is dropped once
 *     `isTerminal()` is true, and every handler runs on a serial queue, so a
 *     `Connected` / `Reconnected` callback that lands after teardown cannot
 *     revive the UI.
 *
 * Browser and Electron use this same browser SDK — Electron's renderer is
 * Chromium, so there is no separate native path.
 */
import type { LiveKitCredentials, MediaEngineHandlers, UiConnectionQuality } from "./types";
import { createSerialQueue, type SerialQueue } from "./callStateMachine";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type LiveKitModule = typeof import("livekit-client");

let moduleLoader: () => Promise<LiveKitModule> = () => import("livekit-client");
let modulePromise: Promise<LiveKitModule> | null = null;

/** Lazily pulls in the SDK so p2p-only sessions never download it. */
export function loadLiveKit(): Promise<LiveKitModule> {
  if (!modulePromise) modulePromise = moduleLoader();
  return modulePromise;
}

/** Test seam: swap the SDK loader (and drop the memoised module). */
export function setLiveKitModuleLoader(
  loader: (() => Promise<LiveKitModule>) | null,
): void {
  moduleLoader = loader || (() => import("livekit-client"));
  modulePromise = null;
}

export function mapConnectionQuality(quality: unknown): UiConnectionQuality {
  switch (quality) {
    case "excellent":
      return "good";
    case "good":
      return "fair";
    case "poor":
    case "lost":
      return "poor";
    default:
      return "unknown";
  }
}

/**
 * Conservative capture + publish defaults.
 *
 * `dynacast` stops publishing layers nobody is consuming and simulcast gives
 * the SFU something to choose from. Adaptive stream stays disabled because this
 * adapter renders a stable MediaStream through `srcObject`; LiveKit requires
 * RemoteVideoTrack.attach() to provide visibility data when adaptive stream is
 * enabled.
 */
export function buildRoomOptions(
  mod: LiveKitModule,
  opts: { isVideo: boolean; isMobile?: boolean },
): any {
  const { VideoPresets, ScreenSharePresets } = mod as any;
  const capture = opts.isMobile ? VideoPresets.h360 : VideoPresets.h540;
  return {
    adaptiveStream: false,
    dynacast: true,
    stopLocalTrackOnUnpublish: true,
    disconnectOnPageLeave: true,
    audioCaptureDefaults: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    videoCaptureDefaults: opts.isVideo
      ? { resolution: capture.resolution }
      : undefined,
    publishDefaults: {
      simulcast: true,
      videoCodec: "vp8",
      videoEncoding: capture.encoding,
      videoSimulcastLayers: opts.isMobile
        ? [VideoPresets.h180]
        : [VideoPresets.h180, VideoPresets.h360],
      screenShareEncoding: ScreenSharePresets.h1080fps15.encoding,
      screenShareSimulcastLayers: [ScreenSharePresets.h360fps15],
      degradationPreference: "balanced",
      dtx: true,
      red: true,
    },
  };
}

export interface LiveKitEngineOptions {
  credentials: LiveKitCredentials;
  callType?: string;
  isMobile?: boolean;
  handlers: MediaEngineHandlers;
  /** When this returns true every room callback is dropped. */
  isTerminal?: () => boolean;
  /** Shared with the lifecycle machine so media and WS events cannot interleave. */
  queue?: SerialQueue;
  loadModule?: () => Promise<LiveKitModule>;
}

export interface LiveKitEngine {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  setMicrophoneEnabled(enabled: boolean): Promise<void>;
  setCameraEnabled(enabled: boolean): Promise<void>;
  setScreenShareEnabled(enabled: boolean): Promise<void>;
  switchDevice(kind: MediaDeviceKind, deviceId: string): Promise<boolean>;
  getRoom(): any | null;
  isConnected(): boolean;
}

function isScreenShareSource(mod: LiveKitModule, publication: any): boolean {
  const Source = (mod as any).Track?.Source;
  const source = publication?.source ?? publication?.track?.source;
  if (!Source) return source === "screen_share" || source === "screen_share_audio";
  return source === Source.ScreenShare || source === Source.ScreenShareAudio;
}

export function createLiveKitEngine(options: LiveKitEngineOptions): LiveKitEngine {
  const {
    credentials,
    callType = "voice",
    isMobile = false,
    handlers,
    isTerminal = () => false,
    queue = createSerialQueue((err) =>
      console.warn("[call-livekit] handler failed:", err),
    ),
    loadModule = loadLiveKit,
  } = options;

  let room: any = null;
  let mod: LiveKitModule | null = null;
  let disposed = false;
  let connected = false;
  let lastRemoteHasVideo = false;

  /**
   * ONE MediaStream instance per direction for the whole call.
   *
   * Rebuilding a stream on every event (mute, quality change, a participant
   * joining) would hand the overlay a brand-new object each time, and every
   * `srcObject = stream` assignment restarts the <video>/<audio> element: black
   * frame, audio gap, autoplay promise churn. Instead the instances below are
   * created once and their track membership is reconciled, so the elements are
   * only touched when the tracks genuinely change.
   */
  let remoteStream: MediaStream | null = null;
  let localStream: MediaStream | null = null;
  let remoteStreamEmitted = false;
  let localStreamEmitted = false;

  const ensureStream = (existing: MediaStream | null): MediaStream | null => {
    if (existing) return existing;
    if (typeof MediaStream !== "function") return null;
    return new MediaStream();
  };

  /** Reconcile membership. Returns true when the track set actually changed. */
  const syncTracks = (stream: MediaStream, desired: MediaStreamTrack[]): boolean => {
    const wanted = new Map<string, MediaStreamTrack>();
    for (const track of desired) wanted.set(track.id, track);
    let changed = false;
    for (const track of stream.getTracks()) {
      if (!wanted.has(track.id)) {
        try {
          stream.removeTrack(track);
          changed = true;
        } catch {
          /* ignore */
        }
      } else {
        wanted.delete(track.id);
      }
    }
    for (const track of wanted.values()) {
      try {
        stream.addTrack(track);
        changed = true;
      } catch {
        /* duplicate track — ignore */
      }
    }
    return changed;
  };

  /** Every room callback funnels through here: dropped when terminal, always serialized. */
  const guard = (fn: () => void) => {
    if (disposed || isTerminal()) return;
    void queue.enqueue(() => {
      if (disposed || isTerminal()) return;
      fn();
    });
  };

  const collectRemote = () => {
    if (!room || !mod) return;
    const tracks: MediaStreamTrack[] = [];
    let hasVideo = false;
    let micMuted = false;
    let cameraMuted = false;
    let hasCamera = false;
    let screenSharing = false;

    for (const participant of room.remoteParticipants?.values?.() ?? []) {
      const publications: any[] =
        participant.trackPublications?.values?.() != null
          ? Array.from(participant.trackPublications.values())
          : [];
      for (const publication of publications) {
        const track = publication.track;
        const isScreen = isScreenShareSource(mod, publication);
        if (isScreen && publication.kind === "video") screenSharing = true;
        if (!isScreen && publication.kind === "audio") {
          micMuted = micMuted || !!publication.isMuted;
        }
        if (!isScreen && publication.kind === "video") {
          hasCamera = true;
          cameraMuted = cameraMuted || !!publication.isMuted;
        }
        const mediaTrack: MediaStreamTrack | undefined = track?.mediaStreamTrack;
        if (mediaTrack) tracks.push(mediaTrack);
        if (publication.kind === "video" && !publication.isMuted) hasVideo = true;
      }
    }

    remoteStream = ensureStream(remoteStream);
    if (remoteStream) {
      const changed = syncTracks(remoteStream, tracks);
      const next = remoteStream.getTracks().length ? remoteStream : null;
      // Only re-publish the stream when membership moved. A mute, a quality
      // report or a participant's metadata update must not re-assign srcObject.
      if (changed || !remoteStreamEmitted) {
        remoteStreamEmitted = true;
        handlers.onRemoteStream?.(next);
      }
    }
    if (hasVideo !== lastRemoteHasVideo) {
      lastRemoteHasVideo = hasVideo;
      handlers.onRemoteHasVideo?.(hasVideo);
    }
    handlers.onRemoteMuted?.(micMuted);
    handlers.onRemoteVideoOff?.(!hasCamera || cameraMuted);
    handlers.onRemoteScreenSharing?.(screenSharing);
    handlers.onRemoteParticipantCount?.(room.remoteParticipants?.size ?? 0);
  };

  const collectLocal = () => {
    if (!room) return;
    const local = room.localParticipant;
    const tracks: MediaStreamTrack[] = [];
    const publications: any[] =
      local?.trackPublications?.values?.() != null
        ? Array.from(local.trackPublications.values())
        : [];
    for (const publication of publications) {
      const mediaTrack: MediaStreamTrack | undefined = publication.track?.mediaStreamTrack;
      if (mediaTrack) tracks.push(mediaTrack);
    }
    localStream = ensureStream(localStream);
    if (!localStream) return;
    const changed = syncTracks(localStream, tracks);
    if (!changed && localStreamEmitted) return;
    localStreamEmitted = true;
    handlers.onLocalStream?.(localStream.getTracks().length ? localStream : null);
  };

  const bind = (loaded: LiveKitModule) => {
    const { RoomEvent } = loaded as any;

    room
      .on(RoomEvent.Connected, () =>
        guard(() => {
          connected = true;
          collectLocal();
          collectRemote();
          handlers.onConnected?.();
        }),
      )
      .on(RoomEvent.Reconnecting, () => guard(() => handlers.onReconnecting?.()))
      .on(RoomEvent.SignalReconnecting, () =>
        guard(() => handlers.onReconnecting?.()),
      )
      .on(RoomEvent.Reconnected, () =>
        guard(() => {
          collectLocal();
          collectRemote();
          handlers.onReconnected?.();
        }),
      )
      // A transport disconnect is reported, never acted on: the call itself is
      // only ever ended by WorkPulse (`call_ended` / `call_rejected` / local
      // hang-up), so the SFU dropping out can never silently kill a call.
      .on(RoomEvent.Disconnected, (reason: unknown) =>
        guard(() => {
          connected = false;
          handlers.onDisconnected?.(reason);
        }),
      )
      .on(RoomEvent.TrackSubscribed, () => guard(collectRemote))
      .on(RoomEvent.TrackUnsubscribed, () => guard(collectRemote))
      .on(RoomEvent.TrackMuted, () => guard(collectRemote))
      .on(RoomEvent.TrackUnmuted, () => guard(collectRemote))
      .on(RoomEvent.ParticipantConnected, () => guard(collectRemote))
      .on(RoomEvent.ParticipantDisconnected, () => guard(collectRemote))
      .on(RoomEvent.LocalTrackPublished, () =>
        guard(() => {
          collectLocal();
        }),
      )
      .on(RoomEvent.LocalTrackUnpublished, () =>
        guard(() => {
          collectLocal();
        }),
      )
      .on(RoomEvent.ConnectionQualityChanged, (quality: unknown, participant: any) =>
        guard(() => {
          const mapped = mapConnectionQuality(quality);
          const isLocal = participant?.isLocal ?? participant === room?.localParticipant;
          if (isLocal) handlers.onLocalQuality?.(mapped);
          else handlers.onRemoteQuality?.(mapped);
        }),
      )
      .on(RoomEvent.MediaDevicesError, (error: unknown) =>
        guard(() => handlers.onMediaError?.(error)),
      );
  };

  return {
    async connect() {
      if (disposed || room) return;
      const loaded = await loadModule();
      if (disposed || isTerminal()) return;
      mod = loaded;
      const RoomCtor = (loaded as any).Room;
      room = new RoomCtor(buildRoomOptions(loaded, { isVideo: callType === "video", isMobile }));
      bind(loaded);
      await room.connect(credentials.serverUrl, credentials.token);
      if (disposed || isTerminal()) {
        // Teardown won the race — drop the room we just built rather than
        // letting its `Connected` callback resurrect a dead call.
        try {
          await room.disconnect();
        } catch {
          /* ignore */
        }
        return;
      }
      try {
        await room.localParticipant?.setMicrophoneEnabled?.(true);
        if (callType === "video") {
          await room.localParticipant?.setCameraEnabled?.(true);
        }
      } catch (err) {
        handlers.onMediaError?.(err);
      }
      collectLocal();
      collectRemote();
    },

    async disconnect() {
      disposed = true;
      connected = false;
      remoteStream = null;
      localStream = null;
      remoteStreamEmitted = false;
      localStreamEmitted = false;
      const current = room;
      room = null;
      if (!current) return;
      try {
        current.removeAllListeners?.();
      } catch {
        /* ignore */
      }
      try {
        await current.disconnect();
      } catch {
        /* ignore */
      }
    },

    async setMicrophoneEnabled(enabled: boolean) {
      await room?.localParticipant?.setMicrophoneEnabled?.(enabled);
      collectLocal();
    },

    async setCameraEnabled(enabled: boolean) {
      await room?.localParticipant?.setCameraEnabled?.(enabled);
      collectLocal();
    },

    async setScreenShareEnabled(enabled: boolean) {
      await room?.localParticipant?.setScreenShareEnabled?.(enabled, {
        audio: false,
        contentHint: "motion",
      });
      collectLocal();
    },

    async switchDevice(kind: MediaDeviceKind, deviceId: string) {
      if (!room?.switchActiveDevice) return false;
      const ok = await room.switchActiveDevice(kind, deviceId);
      collectLocal();
      return !!ok;
    },

    getRoom: () => room,
    isConnected: () => connected,
  };
}
