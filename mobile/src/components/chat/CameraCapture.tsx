import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RotateCcw, X, Zap, ZapOff } from "../../icons";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import RecentMediaStrip, { type RecentMediaItem } from "./RecentMediaStrip";

/**
 * Signal-style in-app camera (mirrors Signal-Android's CameraXFragment):
 *   • Live full-screen preview.
 *   • TAP the shutter → take a photo.
 *   • LONG-PRESS (hold) the shutter → record video; release to stop.
 *   • Front/back flip + flash toggle.
 *   • Bottom horizontal RECENT-GALLERY strip to pick an existing photo/video
 *     without leaving the camera, plus a "Gallery" tile that opens the full
 *     system picker.
 *
 * The native @expo/camera module is resolved defensively via `require` so the
 * JS bundle never crashes where it's unavailable (Expo Go / web). When it can't
 * be resolved we render a graceful fallback that still exposes the gallery
 * picker so the user can attach media.
 *
 * Results are returned through callbacks:
 *   • onCapturedPhoto — a still image (routes to the MediaEditor by the caller).
 *   • onCapturedVideo — a recorded video (uploads directly).
 *   • onPickRecent    — a tapped recent-gallery item.
 *   • onOpenGallery   — the "Gallery" tile (full system picker).
 */
export default function CameraCapture({
  onClose,
  onCapturedPhoto,
  onCapturedVideo,
  onPickRecent,
  onOpenGallery,
  active = true,
}: {
  onClose: () => void;
  onCapturedPhoto: (item: {
    uri: string;
    width?: number;
    height?: number;
  }) => void;
  onCapturedVideo: (item: {
    uri: string;
    fileName: string;
    mimeType: string;
  }) => void;
  onPickRecent: (item: RecentMediaItem) => void;
  onOpenGallery: () => void;
  // True while the camera modal is actually open — forwarded to the recent-
  // media strip so it re-queries each time the camera is opened.
  active?: boolean;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const insets = useSafeAreaInsets();

  // Resolve expo-camera defensively (see file header).
  const cameraMod = useMemo<any>(() => {
    try {
      return require("expo-camera");
    } catch {
      return null;
    }
  }, []);
  const CameraView = cameraMod?.CameraView;
  const useCameraPermissions = cameraMod?.useCameraPermissions;
  const useMicrophonePermissions = cameraMod?.useMicrophonePermissions;

  // Permission hooks are only called when the module resolved. The rules-of-
  // hooks exception is safe here because `cameraMod` is stable for the
  // component's lifetime (a require result never changes between renders).
  const [camPerm, requestCamPerm] = useCameraPermissions
    ? useCameraPermissions()
    : [null, async () => null];
  const [micPerm, requestMicPerm] = useMicrophonePermissions
    ? useMicrophonePermissions()
    : [null, async () => null];

  const cameraRef = useRef<any>(null);
  const [facing, setFacing] = useState<"back" | "front">("back");
  const [flash, setFlash] = useState<"off" | "on">("off");
  // The CameraView's native capture mode. expo-camera REQUIRES the view to
  // already be in "video" mode before `recordAsync()` is called — flipping it
  // synchronously alongside `recordAsync` (the old `mode={isRecording ? ...}`
  // approach) left the native view still in "picture" mode when recordAsync
  // fired, so the recording silently failed and was discarded on release. We
  // now drive the mode through its OWN state, switch to "video" FIRST, wait a
  // tick for the native view to apply it, THEN start recording.
  const [cameraMode, setCameraMode] = useState<"picture" | "video">("picture");
  const [isRecording, setIsRecording] = useState(false);
  const [recordSecs, setRecordSecs] = useState(0);
  const [busy, setBusy] = useState(false);
  const recordTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Guards a long-press that actually started a recording so the press-out
  // handler only stops a real recording (a quick tap must NOT call stop).
  const recordingRef = useRef(false);

  // Request camera (and, for video, microphone) permission on mount.
  useEffect(() => {
    if (useCameraPermissions && camPerm && !camPerm.granted) {
      requestCamPerm();
    }
    if (useMicrophonePermissions && micPerm && !micPerm.granted) {
      requestMicPerm();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (recordTimer.current) clearInterval(recordTimer.current);
    };
  }, []);

  const flipFacing = useCallback(() => {
    setFacing((f) => (f === "back" ? "front" : "back"));
  }, []);

  const toggleFlash = useCallback(() => {
    setFlash((f) => (f === "off" ? "on" : "off"));
  }, []);

  // TAP shutter → still photo.
  const takePhoto = useCallback(async () => {
    if (busy || isRecording || !cameraRef.current) return;
    setBusy(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 1,
        skipProcessing: false,
      });
      if (photo?.uri) {
        onCapturedPhoto({
          uri: photo.uri,
          width: photo.width,
          height: photo.height,
        });
      }
    } catch {
      /* swallow — leave the camera open so the user can retry */
    } finally {
      setBusy(false);
    }
  }, [busy, isRecording, onCapturedPhoto]);

  // LONG-PRESS shutter → start recording video.
  const startRecording = useCallback(async () => {
    if (busy || isRecording || !cameraRef.current) return;
    // Video needs the microphone permission for an audio track.
    if (useMicrophonePermissions && micPerm && !micPerm.granted) {
      const res = await requestMicPerm();
      if (res && !res.granted) {
        // Continue without audio rather than blocking — Signal records muted
        // video if mic is denied.
      }
    }
    // expo-camera requires the CameraView to ALREADY be in "video" mode before
    // recordAsync() is invoked. Flip the mode first, then yield to let React
    // commit + the native view reconfigure before starting the recording —
    // otherwise recordAsync fires while the view is still in "picture" mode and
    // the clip is silently discarded on release (the bug being fixed).
    setCameraMode("video");
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (!cameraRef.current) {
      setCameraMode("picture");
      return;
    }
    recordingRef.current = true;
    setIsRecording(true);
    setRecordSecs(0);
    recordTimer.current = setInterval(() => {
      setRecordSecs((s) => s + 1);
    }, 1000);
    try {
      // recordAsync resolves when stopRecording() is called (or maxDuration is
      // hit). We cap at 60s like Signal's default video limit.
      const video = await cameraRef.current.recordAsync({ maxDuration: 60 });
      if (video?.uri) {
        onCapturedVideo({
          uri: video.uri,
          fileName: `video-${Date.now()}.mp4`,
          mimeType: "video/mp4",
        });
      }
    } catch {
      /* swallow — recording was cancelled or failed */
    } finally {
      recordingRef.current = false;
      setIsRecording(false);
      // Return the view to picture mode so the next tap takes a photo.
      setCameraMode("picture");
      if (recordTimer.current) {
        clearInterval(recordTimer.current);
        recordTimer.current = null;
      }
    }
  }, [
    busy,
    isRecording,
    micPerm,
    onCapturedVideo,
    requestMicPerm,
    useMicrophonePermissions,
  ]);

  // Release the shutter → stop a running recording.
  const stopRecording = useCallback(() => {
    if (!recordingRef.current || !cameraRef.current) return;
    try {
      cameraRef.current.stopRecording();
    } catch {
      /* ignore */
    }
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  // Native module unavailable → graceful fallback (gallery picker only).
  if (!CameraView) {
    return (
      <View style={[styles.root, styles.center]}>
        <Text style={styles.fallbackText}>
          Camera is unavailable on this build.
        </Text>
        <Pressable style={styles.fallbackBtn} onPress={onOpenGallery}>
          <Text style={styles.fallbackBtnText}>Choose from gallery</Text>
        </Pressable>
        <Pressable style={styles.fallbackClose} onPress={onClose}>
          <Text style={styles.fallbackBtnText}>Close</Text>
        </Pressable>
      </View>
    );
  }

  // Permission not yet granted.
  if (camPerm && !camPerm.granted) {
    return (
      <View style={[styles.root, styles.center]}>
        <Text style={styles.fallbackText}>
          Allow camera access to take photos and videos.
        </Text>
        <Pressable style={styles.fallbackBtn} onPress={() => requestCamPerm()}>
          <Text style={styles.fallbackBtnText}>Grant access</Text>
        </Pressable>
        <Pressable style={styles.fallbackClose} onPress={onClose}>
          <Text style={styles.fallbackBtnText}>Close</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing={facing}
        flash={flash}
        // Driven by its OWN state (NOT `isRecording`) so it can switch to
        // "video" BEFORE recordAsync() runs — see startRecording().
        mode={cameraMode}
        videoQuality="1080p"
      />

      {/* Top bar: close + flash + recording timer */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <Pressable style={styles.topBtn} onPress={onClose} hitSlop={8}>
          <X size={26} color="#fff" />
        </Pressable>
        {isRecording ? (
          <View style={styles.recPill}>
            <View style={styles.recDot} />
            <Text style={styles.recText}>{formatSecs(recordSecs)}</Text>
          </View>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        <Pressable style={styles.topBtn} onPress={toggleFlash} hitSlop={8}>
          {flash === "on" ? (
            <Zap size={24} color="#fff" />
          ) : (
            <ZapOff size={24} color="#fff" />
          )}
        </Pressable>
      </View>

      {/* Bottom controls overlaid on the preview */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}>
        {/* Recent-media strip (hidden while recording to keep the frame clean) */}
        {!isRecording ? (
          <View style={styles.stripWrap}>
            <RecentMediaStrip
              height={72}
              active={active && !isRecording}
              onPick={onPickRecent}
              onOpenGallery={onOpenGallery}
            />
          </View>
        ) : null}

        <Text style={styles.hint}>
          {isRecording ? "Release to stop" : "Tap for photo · Hold for video"}
        </Text>

        <View style={styles.controlsRow}>
          <View style={styles.sideSlot} />

          {/* Shutter: tap = photo, long-press = record video. */}
          <Pressable
            onPress={takePhoto}
            onLongPress={startRecording}
            onPressOut={stopRecording}
            delayLongPress={250}
            style={styles.shutterOuter}
          >
            <View
              style={[
                styles.shutterInner,
                isRecording && styles.shutterInnerRecording,
              ]}
            >
              {busy ? <ActivityIndicator color="#fff" /> : null}
            </View>
          </Pressable>

          <View style={styles.sideSlot}>
            <Pressable
              style={styles.flipBtn}
              onPress={flipFacing}
              hitSlop={8}
              disabled={isRecording}
            >
              <RotateCcw size={26} color="#fff" />
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

function formatSecs(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: "#000" },
    center: {
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
      gap: 16,
    },
    fallbackText: {
      color: "#fff",
      fontSize: 16,
      textAlign: "center",
      fontFamily: theme.fontMedium,
    },
    fallbackBtn: {
      paddingHorizontal: 20,
      paddingVertical: 12,
      borderRadius: theme.radiusFull,
      backgroundColor: theme.primary,
    },
    fallbackBtnText: {
      color: "#fff",
      fontSize: 15,
      fontFamily: theme.fontSemiBold,
    },
    fallbackClose: {
      paddingHorizontal: 20,
      paddingVertical: 10,
    },
    topBar: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingBottom: 8,
    },
    topBtn: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    recPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 5,
      borderRadius: theme.radiusFull,
      backgroundColor: "rgba(0,0,0,0.5)",
    },
    recDot: {
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor: "#ff3b30",
    },
    recText: { color: "#fff", fontSize: 14, fontFamily: theme.fontSemiBold },
    bottom: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      gap: 12,
    },
    stripWrap: {
      backgroundColor: "rgba(0,0,0,0.25)",
      paddingVertical: 8,
    },
    hint: {
      color: "rgba(255,255,255,0.85)",
      fontSize: 13,
      textAlign: "center",
      fontFamily: theme.fontMedium,
    },
    controlsRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 32,
    },
    sideSlot: {
      width: 56,
      alignItems: "center",
      justifyContent: "center",
    },
    flipBtn: {
      width: 52,
      height: 52,
      borderRadius: 26,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(255,255,255,0.18)",
    },
    shutterOuter: {
      width: 78,
      height: 78,
      borderRadius: 39,
      borderWidth: 4,
      borderColor: "#fff",
      alignItems: "center",
      justifyContent: "center",
    },
    shutterInner: {
      width: 60,
      height: 60,
      borderRadius: 30,
      backgroundColor: "#fff",
      alignItems: "center",
      justifyContent: "center",
    },
    shutterInnerRecording: {
      width: 32,
      height: 32,
      borderRadius: 8,
      backgroundColor: "#ff3b30",
    },
  });
