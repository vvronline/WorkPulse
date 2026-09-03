import { useCallback, useRef, useState } from "react";
import * as FileSystem from "expo-file-system/legacy";
import { AudioModule } from "expo-audio";
import { useDialog } from "../../hooks/useDialog";
import type { PendingMediaSource } from "./useMobileConversationDraft";
import type { VoiceRecorderControllerHandle } from "./VoiceRecorderController";

type UseChatVoiceRecordingOptions = {
  alert: ReturnType<typeof useDialog>["alert"];
  enqueueMediaUpload: (source: PendingMediaSource) => void;
};

/**
 * Voice-message recording wiring.
 *
 * PERF (chat-open jank root cause): `useAudioRecorder` / `useAudioRecorderState`
 * construct a NATIVE shared object on mount, so creating them with the thread
 * meant every chat OPEN allocated a native recorder on the critical first-render
 * path. Signal only touches the audio session WHILE recording, so the recorder
 * lives in <VoiceRecorderController>, mounted ONLY while `isRecordingActive` —
 * this hook owns that flag, the imperative handle and the send/cancel flow.
 */
export default function useChatVoiceRecording({
  alert,
  enqueueMediaUpload,
}: UseChatVoiceRecordingOptions) {
  // Explicit recording flag: true WHILE the user is recording a voice message.
  // It also GATES the mount of <VoiceRecorderController> (which owns the native
  // recorder) — see the recording handlers below.
  const [isRecordingActive, setIsRecordingActive] = useState(false);
  // Live recording duration (ms), pushed up from VoiceRecorderController so the
  // composer's recording bar shows the counter.
  const [recordingMillis, setRecordingMillis] = useState(0);
  // Imperative handle into the mounted recorder controller (stop / cancel).
  const voiceHandleRef = useRef<VoiceRecorderControllerHandle | null>(null);
  // Ref mirror of isRecordingActive — guards against double-start re-entrancy
  // in the recording handlers without depending on the stale polled value.
  const recordingRef = useRef(false);

  async function startRecording() {
    // Guard against a double-tap while a recording is already underway.
    if (recordingRef.current) return;
    let granted = false;
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      granted = perm.granted;
    } catch {
      granted = false;
    }
    if (!granted) {
      alert(
        "Microphone needed",
        "Allow microphone access to record a voice message.",
      );
      return;
    }
    // Flip the recording UI ON synchronously and MOUNT the recorder controller
    // (gated by isRecordingActive). The controller owns the native recorder and
    // auto-prepares + starts recording on mount — keeping all audio init OFF the
    // chat-open path (see VoiceRecorderController).
    recordingRef.current = true;
    setRecordingMillis(0);
    setIsRecordingActive(true);
  }

  // Push the live recording duration up from the mounted controller.
  const onRecorderDuration = useCallback((millis: number) => {
    setRecordingMillis(millis);
  }, []);

  // Surface a recorder error via the shared dialog.
  const onRecorderError = useCallback(
    (title: string, message: string) => {
      alert(title, message);
    },
    [alert],
  );

  // The controller failed to START (permission/prepare) — collapse the UI and
  // unmount it so the mic can be tapped again cleanly.
  const onRecorderStartFailed = useCallback(() => {
    recordingRef.current = false;
    setIsRecordingActive(false);
    setRecordingMillis(0);
  }, []);

  async function stopRecordingAndSend() {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    const handle = voiceHandleRef.current;

    let result: { uri: string; durationMillis: number } | null = null;
    try {
      result = handle ? await handle.stopAndSend() : null;
    } finally {
      // Unmount the recorder controller (releases the native recorder) and
      // collapse the recording bar.
      setIsRecordingActive(false);
      setRecordingMillis(0);
    }

    if (!result) return; // controller already surfaced any error
    const { uri, durationMillis } = result;

    if (durationMillis < 350) {
      alert(
        "Recording too short",
        "Hold the mic a little longer before sending.",
      );
      return;
    }
    try {
      const info = await FileSystem.getInfoAsync(uri);
      if (!info.exists || (info.size ?? 0) <= 0) {
        alert("Recording failed", "The recorded file is empty.");
        return;
      }
    } catch {
      alert("Recording failed", "The recorded file could not be read.");
      return;
    }

    enqueueMediaUpload({
      uri,
      fileName: `voice-${Date.now()}.m4a`,
      mimeType: "audio/mp4",
    });
  }

  async function cancelRecording() {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    const handle = voiceHandleRef.current;
    try {
      await handle?.cancel();
    } finally {
      // Unmount the recorder controller + collapse the recording bar.
      setIsRecordingActive(false);
      setRecordingMillis(0);
    }
  }

  return {
    isRecordingActive,
    recordingMillis,
    voiceHandleRef,
    startRecording,
    stopRecordingAndSend,
    cancelRecording,
    onRecorderDuration,
    onRecorderError,
    onRecorderStartFailed,
  };
}
