import type { CallQuality } from "../shared/callUiTypes";
import type { LiveKitMediaSession } from "../media/mediaSession";
import { DisconnectReason, RoomEvent } from "livekit-client";

type TrackLike = {
  kind?: string;
  source?: string;
  mediaStream?: unknown;
  mediaStreamTrack?: { _switchCamera?: () => void };
};

type PublicationLike = {
  source?: string;
  isMuted?: boolean;
  track?: TrackLike;
};

type ParticipantLike = {
  trackPublications: Map<string, PublicationLike>;
};

type LocalParticipantLike = ParticipantLike & {
  setMicrophoneEnabled(enabled: boolean): Promise<unknown>;
  setCameraEnabled(enabled: boolean, options?: unknown): Promise<unknown>;
};

export type LiveKitRoomLike = {
  localParticipant: LocalParticipantLike;
  remoteParticipants: Map<string, ParticipantLike>;
  on(event: RoomEvent, listener: (...args: unknown[]) => void): unknown;
  off(event: RoomEvent, listener: (...args: unknown[]) => void): unknown;
  connect(serverUrl: string, token: string, options?: unknown): Promise<void>;
  disconnect(stopTracks?: boolean): Promise<void>;
};

export type LiveKitAudioBridge = {
  configure(callType: "voice" | "video"): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  selectOutput(speaker: boolean, callType: "voice" | "video"): Promise<void>;
};

type LifecycleCallbacks = {
  onConnected(): void;
  onReconnecting(): void;
  onLocalStream(stream: unknown | null): void;
  onRemoteStream(stream: unknown | null): void;
  onRemoteMuted(muted: boolean): void;
  onRemoteVideoOff(off: boolean): void;
  onConnectionQuality(quality: CallQuality): void;
  onPeerQuality(quality: CallQuality): void;
  onPermissionDenied(error: unknown): void;
  onError(error: unknown): void;
};

type StartOptions = {
  session: LiveKitMediaSession;
  callType: "voice" | "video";
  muted: boolean;
  videoOff: boolean;
  speaker: boolean;
  requestPermissions(): Promise<boolean>;
};

const events: RoomEvent[] = [
  RoomEvent.Connected,
  RoomEvent.Reconnecting,
  RoomEvent.SignalReconnecting,
  RoomEvent.SignalConnected,
  RoomEvent.Reconnected,
  RoomEvent.Disconnected,
  RoomEvent.ParticipantConnected,
  RoomEvent.ParticipantDisconnected,
  RoomEvent.TrackSubscribed,
  RoomEvent.TrackUnsubscribed,
  RoomEvent.TrackMuted,
  RoomEvent.TrackUnmuted,
  RoomEvent.LocalTrackPublished,
  RoomEvent.LocalTrackUnpublished,
  RoomEvent.ConnectionQualityChanged,
  RoomEvent.MediaDevicesError,
] as const;

const silentDisconnectReasons = new Set<DisconnectReason>([
  DisconnectReason.CLIENT_INITIATED,
  DisconnectReason.DUPLICATE_IDENTITY,
  DisconnectReason.PARTICIPANT_REMOVED,
  DisconnectReason.ROOM_DELETED,
  DisconnectReason.ROOM_CLOSED,
]);

const DEFAULT_PEER_WATCHDOG_MS = 30_000;

function firstPublication(
  participant: ParticipantLike | undefined,
  source: "camera" | "microphone",
): PublicationLike | undefined {
  if (!participant) return undefined;
  return Array.from(participant.trackPublications.values()).find(
    (publication) =>
      publication.source === source || publication.track?.source === source,
  );
}

function firstRemote(
  room: LiveKitRoomLike,
): ParticipantLike | undefined {
  return room.remoteParticipants.values().next().value;
}

export function liveKitQuality(value: unknown): CallQuality {
  switch (value) {
    case "excellent":
    case "good":
      return "good";
    case "poor":
    case "lost":
      return "poor";
    default:
      return "unknown";
  }
}

function isPermissionError(error: unknown): boolean {
  const text =
    error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /notallowed|permission|denied|camera.*access|microphone.*access/i.test(
    text,
  );
}

export class LiveKitCallLifecycle {
  private readonly listeners = new Map<
    RoomEvent,
    (...args: unknown[]) => void
  >();
  private startPromise: Promise<void> | null = null;
  private stopChain: Promise<void> = Promise.resolve();
  private audioStarted = false;
  private roomDisconnectStarted = false;
  private bound = false;
  private stopped = false;
  private terminal = false;
  private callType: "voice" | "video" = "voice";
  private muted = false;
  private videoOff = true;
  private speaker = false;
  private roomReady = false;
  private connectedWithPeer = false;
  private reconnecting = false;
  private peerWatchdog?: ReturnType<typeof setTimeout>;
  private pendingStartStep: Promise<unknown> | null = null;

  constructor(
    private readonly room: LiveKitRoomLike,
    private readonly audio: LiveKitAudioBridge,
    private readonly callbacks: LifecycleCallbacks,
    private readonly peerWatchdogMs = DEFAULT_PEER_WATCHDOG_MS,
  ) {}

  start(options: StartOptions): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.callType = options.callType;
    this.muted = options.muted;
    this.videoOff = options.videoOff;
    this.speaker = options.speaker;
    this.startPromise = this.startOnce(options);
    return this.startPromise;
  }

  private async startOnce(options: StartOptions): Promise<void> {
    try {
      if (!(await this.runStartStep(options.requestPermissions()))) {
        throw new Error("Permission denied");
      }
      if (this.stopped) return void (await this.stop(this.terminal));
      await this.runStartStep(this.audio.configure(this.callType));
      if (this.stopped) return void (await this.stop(this.terminal));
      await this.runStartStep(this.audio.start());
      this.audioStarted = true;
      if (this.stopped) return void (await this.stop(this.terminal));
      await this.runStartStep(
        this.audio.selectOutput(this.speaker, this.callType),
      );
      if (this.stopped) return void (await this.stop(this.terminal));
      this.bind();
      await this.runStartStep(
        this.room.connect(
          options.session.livekit.serverUrl,
          options.session.livekit.token,
          { autoSubscribe: true },
        ),
      );
      if (this.stopped) return void (await this.stop(this.terminal));
      await this.runStartStep(
        this.room.localParticipant.setMicrophoneEnabled(!this.muted),
      );
      if (this.stopped) return void (await this.stop(this.terminal));
      if (this.callType === "video") {
        await this.runStartStep(
          this.room.localParticipant.setCameraEnabled(!this.videoOff, {
            facingMode: "user",
          }),
        );
        if (this.stopped) return void (await this.stop(this.terminal));
      }
      this.roomReady = true;
      this.refreshTracks();
      this.markConnectedWithPeer();
    } catch (error) {
      if (!this.stopped) {
        if (isPermissionError(error)) {
          this.callbacks.onPermissionDenied(error);
        } else {
          this.callbacks.onError(error);
        }
      }
      await this.stop(true);
    }
  }

  private async runStartStep<T>(step: Promise<T>): Promise<T> {
    this.pendingStartStep = step;
    try {
      return await step;
    } finally {
      if (this.pendingStartStep === step) this.pendingStartStep = null;
    }
  }

  private bind(): void {
    if (this.bound) return;
    const guard = (run: (...args: unknown[]) => void) => (...args: unknown[]) => {
      if (!this.stopped && !this.terminal) run(...args);
    };
    this.listeners.set(
      RoomEvent.Connected,
      guard(() => {
        this.roomReady = true;
        this.refreshTracks();
        this.markConnectedWithPeer();
      }),
    );
    this.listeners.set(
      RoomEvent.Reconnecting,
      guard(() => {
        this.roomReady = false;
        this.connectedWithPeer = false;
        this.notifyReconnecting();
      }),
    );
    this.listeners.set(
      RoomEvent.SignalReconnecting,
      guard(() => this.notifyReconnecting()),
    );
    this.listeners.set(
      RoomEvent.SignalConnected,
      guard(() => this.markConnectedWithPeer()),
    );
    this.listeners.set(
      RoomEvent.Reconnected,
      guard(() => {
        this.roomReady = true;
        this.refreshTracks();
        this.markConnectedWithPeer();
      }),
    );
    this.listeners.set(
      RoomEvent.Disconnected,
      guard((rawReason) => {
        this.clearPeerWatchdog();
        const reason =
          typeof rawReason === "number"
            ? (rawReason as DisconnectReason)
            : undefined;
        if (!silentDisconnectReasons.has(reason as DisconnectReason)) {
          const reasonName =
            reason === undefined
              ? "unknown"
              : DisconnectReason[reason] ?? String(reason);
          this.callbacks.onError(
            new Error(`LiveKit room disconnected unexpectedly (${reasonName})`),
          );
        }
        void this.stop(true);
      }),
    );
    this.listeners.set(
      RoomEvent.ParticipantConnected,
      guard(() => {
        this.refreshTracks();
        this.markConnectedWithPeer();
      }),
    );
    this.listeners.set(
      RoomEvent.ParticipantDisconnected,
      guard(() => {
        this.refreshTracks();
        if (this.room.remoteParticipants.size > 0) return;
        this.connectedWithPeer = false;
        this.notifyReconnecting();
        this.armPeerWatchdog();
      }),
    );
    for (const event of [
      RoomEvent.TrackSubscribed,
      RoomEvent.TrackUnsubscribed,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished,
    ]) {
      this.listeners.set(event, guard(() => this.refreshTracks()));
    }
    this.listeners.set(
      RoomEvent.ConnectionQualityChanged,
      guard((quality, participant) => {
        if (participant === this.room.localParticipant) {
          this.callbacks.onConnectionQuality(liveKitQuality(quality));
        } else {
          this.callbacks.onPeerQuality(liveKitQuality(quality));
        }
      }),
    );
    this.listeners.set(
      RoomEvent.MediaDevicesError,
      guard((error) => {
        if (isPermissionError(error)) {
          this.callbacks.onPermissionDenied(error);
        } else {
          this.callbacks.onError(error);
        }
        void this.stop(true);
      }),
    );
    for (const [event, listener] of this.listeners) {
      this.room.on(event, listener);
    }
    this.bound = true;
  }

  private markConnectedWithPeer(): void {
    if (
      this.stopped ||
      this.terminal ||
      !this.roomReady ||
      this.room.remoteParticipants.size === 0
    ) {
      if (this.roomReady) this.armPeerWatchdog();
      return;
    }
    this.clearPeerWatchdog();
    this.reconnecting = false;
    if (this.connectedWithPeer) return;
    this.connectedWithPeer = true;
    this.callbacks.onConnected();
  }

  private notifyReconnecting(): void {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.callbacks.onReconnecting();
  }

  private armPeerWatchdog(): void {
    if (
      this.peerWatchdog ||
      this.stopped ||
      this.terminal ||
      this.room.remoteParticipants.size > 0
    ) {
      return;
    }
    this.peerWatchdog = setTimeout(() => {
      this.peerWatchdog = undefined;
      if (
        this.stopped ||
        this.terminal ||
        this.room.remoteParticipants.size > 0
      ) {
        return;
      }
      this.callbacks.onError(
        new Error("Timed out waiting for the other LiveKit participant"),
      );
      void this.stop(true);
    }, this.peerWatchdogMs);
  }

  private clearPeerWatchdog(): void {
    if (!this.peerWatchdog) return;
    clearTimeout(this.peerWatchdog);
    this.peerWatchdog = undefined;
  }

  private unbind(): void {
    if (!this.bound) return;
    for (const event of events) {
      const listener = this.listeners.get(event);
      if (listener) this.room.off(event, listener);
    }
    this.listeners.clear();
    this.bound = false;
  }

  private refreshTracks(): void {
    if (this.stopped || this.terminal) return;
    const localCamera = firstPublication(
      this.room.localParticipant,
      "camera",
    );
    const remote = firstRemote(this.room);
    const remoteCamera = firstPublication(remote, "camera");
    const remoteMicrophone = firstPublication(remote, "microphone");
    this.callbacks.onLocalStream(localCamera?.track?.mediaStream ?? null);
    this.callbacks.onRemoteStream(remoteCamera?.track?.mediaStream ?? null);
    this.callbacks.onRemoteVideoOff(
      !remoteCamera?.track || !!remoteCamera.isMuted,
    );
    this.callbacks.onRemoteMuted(!!remoteMicrophone?.isMuted);
  }

  async setMuted(muted: boolean): Promise<void> {
    this.muted = muted;
    if (this.stopped) return;
    try {
      await this.room.localParticipant.setMicrophoneEnabled(!muted);
      this.refreshTracks();
    } catch (error) {
      if (isPermissionError(error)) this.callbacks.onPermissionDenied(error);
      else this.callbacks.onError(error);
    }
  }

  async setVideoOff(videoOff: boolean): Promise<void> {
    this.videoOff = videoOff;
    if (this.stopped || this.callType !== "video") return;
    try {
      await this.room.localParticipant.setCameraEnabled(!videoOff, {
        facingMode: "user",
      });
      this.refreshTracks();
    } catch (error) {
      if (isPermissionError(error)) this.callbacks.onPermissionDenied(error);
      else this.callbacks.onError(error);
    }
  }

  switchCamera(): void {
    const camera = firstPublication(this.room.localParticipant, "camera");
    camera?.track?.mediaStreamTrack?._switchCamera?.();
  }

  async setHeld(held: boolean): Promise<void> {
    await Promise.all([
      this.setMuted(held ? true : this.muted),
      this.setVideoOff(held ? true : this.videoOff),
    ]);
  }

  async setSpeaker(speaker: boolean): Promise<void> {
    this.speaker = speaker;
    if (!this.audioStarted || this.stopped) return;
    await this.audio.selectOutput(speaker, this.callType);
  }

  async onForeground(): Promise<void> {
    if (this.stopped || this.terminal) return;
    await this.setSpeaker(this.speaker);
    await this.setMuted(this.muted);
    await this.setVideoOff(this.videoOff);
    this.refreshTracks();
  }

  stop(terminal = true): Promise<void> {
    this.terminal ||= terminal;
    this.stopped = true;
    this.roomReady = false;
    this.connectedWithPeer = false;
    this.clearPeerWatchdog();
    this.unbind();
    this.callbacks.onLocalStream(null);
    this.callbacks.onRemoteStream(null);
    const pendingStartStep = this.pendingStartStep;
    this.stopChain = this.stopChain.then(async () => {
      if (pendingStartStep) {
        try {
          await pendingStartStep;
        } catch {
          // Continue cleanup after a failed or cancelled start step.
        }
      }
      if (!this.roomDisconnectStarted) {
        this.roomDisconnectStarted = true;
        try {
          await this.room.disconnect(true);
        } catch {
          // Best-effort native cleanup continues below.
        }
      }
      if (this.audioStarted) {
        this.audioStarted = false;
        try {
          await this.audio.stop();
        } catch {
          // The lifecycle is still terminal even if native teardown rejects.
        }
      }
    });
    return this.stopChain;
  }
}
