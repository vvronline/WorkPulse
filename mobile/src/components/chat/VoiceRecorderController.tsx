import { useEffect, useRef } from "react";
import {
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";

/**
 * Imperative handle the chat thread uses to stop/cancel the active recording.
 * `stopAndSend` resolves with the recorded file (or null if nothing usable was
 * captured); the caller then validates + enqueues the upload.
 */
export type VoiceRecorderControllerHandle = {
  stopAndSend: () => Promise<{ uri: string; durationMillis: number } | null>;
  cancel: () => Promise<void>;
};

/**
 * Headless voice-recording controller (Signal-style — the audio session is only
 * touched WHILE recording).
 *
 * PERF (chat-open jank): `useAudioRecorder`/`useAudioRecorderState` construct a
 * NATIVE `AudioRecorder` shared object on mount. Keeping them in `useChatThread`
 * meant every chat OPEN allocated a native recorder (and its status poll) on the
 * critical first-render path, competing with the navigation slide-in. This
 * component is mounted by the thread ONLY while the user is actively recording
 * (see `useChatThread.startRecording`), so opening a conversation no longer
 * initializes any recording machinery. It auto-starts on mount and exposes
 * stop/cancel through `handleRef`.
 */
export default function VoiceRecorderController({
  handleRef,
  onDuration,
  onError,
  onStartFailed,
}: {
  handleRef: React.MutableRefObject<VoiceRecorderControllerHandle | null>;
  onDuration: (millis: number) => void;
  onError: (title: string, message: string) => void;
  onStartFailed: () => void;
}) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  // Poll at 100ms for a smooth live duration counter — this component only
  // exists while recording, so the poll never runs on an idle chat screen.
  const recorderState = useAudioRecorderState(recorder, 100);
  const startedRef = useRef(false);

  // Forward the live duration to the composer's recording bar.
  useEffect(() => {
    onDuration(recorderState.durationMillis || 0);
  }, [recorderState.durationMillis, onDuration]);

  // Auto prepare + start recording on mount. Expo Audio still requires an
  // explicit prepare step before record(); if it fails we surface the real
  // error and tell the parent to collapse the recording UI (otherwise the mic
  // tap appears to do nothing and the failure is hidden).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (startedRef.current) return;
      startedRef.current = true;
      try {
        await setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
        });
        await recorder.prepareToRecordAsync();
        const prepared = await recorder.getStatus();
        if (!prepared.canRecord) {
          throw new Error("Recorder could not be prepared.");
        }
        if (cancelled) return;
        recorder.record();
      } catch (e: any) {
        // Restore the playback session so a failed start doesn't leave the
        // audio route stuck in record mode.
        setAudioModeAsync({
          allowsRecording: false,
          playsInSilentMode: true,
        }).catch(() => {});
        onError(
          "Recording failed",
          e?.message || "Could not start the voice recording.",
        );
        onStartFailed();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Publish the imperative stop/cancel handle. `recorder` is stable for this
  // component's lifetime, so the handle is created once.
  useEffect(() => {
    const restorePlayback = () =>
      setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
      }).catch(() => {});

    handleRef.current = {
      async stopAndSend() {
        let uri: string | null = null;
        let durationMillis = 0;
        try {
          const before = recorder.getStatus();
          durationMillis = before?.durationMillis || 0;
          await recorder.stop();
          const status = recorder.getStatus();
          uri = status?.url || recorder.uri;
          durationMillis = Math.max(durationMillis, status?.durationMillis || 0);
        } catch (e: any) {
          onError(
            "Recording failed",
            e?.message || "Could not finish the voice recording.",
          );
          return null;
        } finally {
          // Restore the playback audio session — leaving allowsRecording=true
          // routes/silences subsequent voice-note playback on iOS.
          restorePlayback();
        }
        if (!uri) {
          onError("Recording failed", "No recording file was created.");
          return null;
        }
        return { uri, durationMillis };
      },
      async cancel() {
        try {
          await recorder.stop();
        } catch {
          /* ignore */
        } finally {
          restorePlayback();
        }
      },
    };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef, onError, recorder]);

  return null;
}
