import { useCallback, useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import {
  AndroidAudioTypePresets,
  AudioSession,
} from "@livekit/react-native";
import { Room } from "livekit-client";
import type { CallQuality } from "../shared/callUiTypes";
import type { LiveKitMediaSession } from "../media/mediaSession";
import {
  LiveKitCallLifecycle,
  type LiveKitAudioBridge,
  type LiveKitRoomLike,
} from "./liveKitLifecycle";

type Options = {
  session: LiveKitMediaSession | null;
  active: boolean;
  callType: "voice" | "video";
  muted: boolean;
  videoOff: boolean;
  speaker: boolean;
  requestPermissions(): Promise<boolean>;
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

function createAudioBridge(): LiveKitAudioBridge {
  return {
    configure: async (callType) => {
      const video = callType === "video";
      await AudioSession.configureAudio({
        android: {
          preferredOutputList: video
            ? ["bluetooth", "headset", "speaker", "earpiece"]
            : ["bluetooth", "headset", "earpiece", "speaker"],
          audioTypeOptions: AndroidAudioTypePresets.communication,
        },
        ios: { defaultOutput: video ? "speaker" : "earpiece" },
      });
    },
    start: () => AudioSession.startAudioSession(),
    stop: () => AudioSession.stopAudioSession(),
    selectOutput: async (speaker, _callType) => {
      if (Platform.OS === "ios") {
        await AudioSession.selectAudioOutput(
          speaker ? "force_speaker" : "default",
        );
        return;
      }
      const outputs = await AudioSession.getAudioOutputs();
      const preferred = speaker
        ? ["speaker"]
        : ["bluetooth", "headset", "earpiece"];
      const output = preferred.find((candidate) => outputs.includes(candidate));
      if (output) await AudioSession.selectAudioOutput(output);
    },
  };
}

export function useLiveKitCall(options: Options) {
  const lifecycleRef = useRef<LiveKitCallLifecycle | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const { active, callType, requestPermissions, session } = options;

  useEffect(() => {
    if (!active || session?.backend !== "livekit") return;
    const room = new Room({
      dynacast: true,
    });
    const lifecycle = new LiveKitCallLifecycle(
      room as unknown as LiveKitRoomLike,
      createAudioBridge(),
      {
        onConnected: () => optionsRef.current.onConnected(),
        onReconnecting: () => optionsRef.current.onReconnecting(),
        onLocalStream: (stream) =>
          optionsRef.current.onLocalStream(stream),
        onRemoteStream: (stream) =>
          optionsRef.current.onRemoteStream(stream),
        onRemoteMuted: (muted) =>
          optionsRef.current.onRemoteMuted(muted),
        onRemoteVideoOff: (off) =>
          optionsRef.current.onRemoteVideoOff(off),
        onConnectionQuality: (quality) =>
          optionsRef.current.onConnectionQuality(quality),
        onPeerQuality: (quality) =>
          optionsRef.current.onPeerQuality(quality),
        onPermissionDenied: (error) =>
          optionsRef.current.onPermissionDenied(error),
        onError: (error) => optionsRef.current.onError(error),
      },
    );
    lifecycleRef.current = lifecycle;
    void lifecycle.start({
      session,
      callType,
      muted: optionsRef.current.muted,
      videoOff: optionsRef.current.videoOff,
      speaker: optionsRef.current.speaker,
      requestPermissions,
    });
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") void lifecycle.onForeground();
    });
    return () => {
      appState.remove();
      if (lifecycleRef.current === lifecycle) lifecycleRef.current = null;
      void lifecycle.stop(true);
    };
  }, [active, callType, requestPermissions, session]);

  const stop = useCallback(
    (terminal = true) => lifecycleRef.current?.stop(terminal),
    [],
  );
  const setMuted = useCallback(
    (muted: boolean) => lifecycleRef.current?.setMuted(muted),
    [],
  );
  const setVideoOff = useCallback(
    (videoOff: boolean) => lifecycleRef.current?.setVideoOff(videoOff),
    [],
  );
  const setSpeaker = useCallback(
    (speaker: boolean) => lifecycleRef.current?.setSpeaker(speaker),
    [],
  );
  const switchCamera = useCallback(
    () => lifecycleRef.current?.switchCamera(),
    [],
  );

  return { stop, setMuted, setVideoOff, setSpeaker, switchCamera };
}
