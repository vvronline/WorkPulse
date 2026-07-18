import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import {
  FileText,
  Timer,
  Eye,
  EyeOff,
  X,
  RefreshCw,
} from "../../icons";
import Svg, { Circle } from "react-native-svg";
import { useAuth } from "../../auth/AuthContext";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import { uploadUrl } from "../../config";
import { markMessageViewed } from "../../features";
import { getToken } from "../../auth/tokenStore";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import VoicePlayer from "../VoicePlayer";
import { AuthedImage } from "../AuthedImage";
import ZoomableImage from "./ZoomableImage";
import type { ChatMessage } from "../../features";
import { fmtSize, isAudioFile, isImageFile, isVideoFile } from "./chatUtils";
import { openAuthedFile } from "./openAuthedFile";
import InlineVideo, { VIDEO_AVAILABLE } from "./InlineVideo";
import {
  getCachedMediaDimensions,
  setCachedMediaDimensions,
} from "../../storage/mediaDimensionsCache";
import { getCachedMediaSync } from "./mediaCache";

// Signal-style sent-image envelope — matched 1:1 to the web client's
// FilePreview.module.css (.imgWrap / .image): max 280×330, min 120 wide, 80
// tall. The image is sized by its intrinsic aspect ratio within that envelope
// so portrait/landscape/square photos all read naturally (instead of a fixed,
// distorting box). On narrow phones the width is additionally clamped so the
// bubble never overflows the screen.
const IMG_MAX_W = 280;
const IMG_MAX_H = 330;
const IMG_MIN_W = 120;
const IMG_MIN_H = 80;

/** Compute the display box for a chat image from its intrinsic w/h. */
function computeImageSize(
  screenW: number,
  width?: number | null,
  height?: number | null,
): { width: number; height: number } {
  // Never let the image exceed the web envelope OR the screen (minus bubble
  // padding/margins ≈ 64px) on a narrow device.
  const maxW = Math.min(IMG_MAX_W, Math.round(screenW - 64));
  // No intrinsic size yet (e.g. remote message before metadata): use the web
  // default (full envelope width, 4:3-ish height).
  if (!width || !height || width <= 0 || height <= 0) {
    const w = maxW;
    return { width: w, height: Math.min(IMG_MAX_H, Math.round(w * 0.75)) };
  }
  const ar = width / height;
  let w = maxW;
  let h = Math.round(w / ar);
  if (h > IMG_MAX_H) {
    h = IMG_MAX_H;
    w = Math.round(h * ar);
  }
  w = Math.max(IMG_MIN_W, Math.min(w, maxW));
  h = Math.max(IMG_MIN_H, Math.min(h, IMG_MAX_H));
  return { width: w, height: h };
}

/**
 * Renders a message's attachment (mirrors the web FilePreview): inline image,
 * voice player, or a tappable file card. Returns null when there's no file.
 */
export default function FilePreview({
  message,
  onCancelUpload,
  onRetryUpload,
  onLongPress,
}: {
  message: ChatMessage;
  onCancelUpload?: (message: ChatMessage) => void;
  onRetryUpload?: (message: ChatMessage) => void;
  // Forwarded from the bubble so long-pressing an image/file opens the reaction
  // bar (Signal parity) instead of the inner Pressable swallowing the gesture.
  onLongPress?: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { user } = useAuth();
  const { width: winWidth } = useWindowDimensions();
  const [viewer, setViewer] = useState<string | null>(null);
  const [consumed, setConsumed] = useState(false);
  const [loadingView, setLoadingView] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  const [openingFile, setOpeningFile] = useState(false);
  // Measured intrinsic dimensions for images whose metadata lacks them (the
  // common case for received images and many sent ones). Without this the
  // bubble fell back to a fixed 4:3 landscape box (the "too wide" bug); now we
  // fetch the real width/height so the image is sized by its true aspect ratio
  // within the Signal/web envelope. Keyed by file_url so it re-measures when the
  // optimistic local uri is replaced by the server url.
  const [measured, setMeasured] = useState<{
    url: string;
    width: number;
    height: number;
  } | null>(null);
  // Intrinsic dimensions of a video's poster frame (reported by InlineVideo via
  // expo-video-thumbnails). Videos almost never carry metadata.width/height, so
  // without this the box fell back to a 4:3 LANDSCAPE default — which made
  // portrait videos render far too wide. Keyed by the resolved url so it
  // re-measures when the optimistic local uri is swapped for the server url.
  const [videoSize, setVideoSize] = useState<{
    url: string;
    width: number;
    height: number;
  } | null>(null);

  const metaW = Number(message.metadata?.width) || null;
  const metaH = Number(message.metadata?.height) || null;
  const resolvedForSize = uploadUrl(message.file_url || "") || undefined;
  const cachedDimensions = getCachedMediaDimensions(resolvedForSize);
  const needsMeasure =
    isImageFile(message) &&
    (!metaW || !metaH) &&
    !cachedDimensions &&
    !!resolvedForSize;

  useEffect(() => {
    if (!resolvedForSize || !metaW || !metaH) return;
    setCachedMediaDimensions(resolvedForSize, metaW, metaH);
  }, [resolvedForSize, metaW, metaH]);

  useEffect(() => {
    if (!needsMeasure || !resolvedForSize) return;
    // Already measured for this exact url — skip.
    if (measured && measured.url === resolvedForSize) return;
    let active = true;
    const isLocalUri = /^(file|content|data):/i.test(resolvedForSize);
    const apply = (w: number, h: number) => {
      if (!active || !w || !h) return;
      setCachedMediaDimensions(resolvedForSize, w, h);
      setMeasured({ url: resolvedForSize, width: w, height: h });
    };
    if (isLocalUri) {
      Image.getSize(resolvedForSize, apply, () => {});
    } else {
      // Remote uploads are behind Bearer auth — attach the token (same pattern
      // as AuthedImage) so getSize doesn't 401.
      getToken()
        .then((token) => {
          if (!active) return;
          Image.getSizeWithHeaders(
            resolvedForSize,
            token ? { Authorization: `Bearer ${token}` } : {},
            apply,
            () => {},
          );
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [needsMeasure, resolvedForSize, measured]);

  if (!message.file_url) return null;
  const isLocalMediaUpload =
    Number(message.id) < 0 ||
    /^(file|content|data):/i.test(String(message.file_url));
  const mediaStateRaw = isLocalMediaUpload
    ? message._mediaState || message.media_state || ""
    : "";
  const mediaState =
    mediaStateRaw === "processing" ? "uploading" : mediaStateRaw;
  const mediaPending =
    isLocalMediaUpload &&
    (Number(message.id) < 0 ||
      mediaState === "queued" ||
      mediaState === "uploading" ||
      mediaState === "failed" ||
      !!message._failed);
  const mediaProgress = Math.max(
    0,
    Math.min(
      100,
      Number(message._mediaProgress ?? message.media_progress ?? 0),
    ),
  );

  const isMine = Number(message.sender_id) === Number(user?.id);
  const viewOnce = !!message.metadata?.viewOnce;
  const alreadyViewed =
    consumed ||
    (Array.isArray(message.metadata?.viewedBy) &&
      message.metadata!.viewedBy!.includes(Number(user?.id)));

  const openViewOnce = async () => {
    if (loadingView) return;
    setViewError(null);
    if (isMine) {
      setViewer(uploadUrl(message.file_url) || null);
      return;
    }
    if (alreadyViewed) return;
    setLoadingView(true);
    try {
      const { data } = await markMessageViewed(Number(message.id));
      if (data?.fileUrl) {
        setViewer(uploadUrl(data.fileUrl) || null);
        setConsumed(true);
      } else {
        setConsumed(true);
      }
    } catch {
      setViewError("This media could not be opened. Tap to retry.");
    } finally {
      setLoadingView(false);
    }
  };

  // ─── View-once image/video: one protected entry point ───
  // Never mount the normal inline renderer before the consume endpoint grants
  // access. This keeps videos from bypassing view-once by appearing as regular
  // playable bubbles.
  if (viewOnce && (isImageFile(message) || isVideoFile(message))) {
    const isVideo = isVideoFile(message);
    const viewedState = alreadyViewed && !isMine;
    return (
      <View>
        <Pressable
          style={[styles.viewOnceCard, viewedState && styles.viewOnceDone]}
          onPress={viewedState ? undefined : openViewOnce}
          onLongPress={onLongPress}
          delayLongPress={250}
          disabled={viewedState || loadingView}
          accessibilityRole="button"
          accessibilityLabel={
            viewedState
              ? `${isVideo ? "Video" : "Photo"} already viewed`
              : `Open view-once ${isVideo ? "video" : "photo"}`
          }
          accessibilityHint={
            viewedState ? undefined : "This media can only be opened once"
          }
          accessibilityState={{ disabled: viewedState || loadingView }}
        >
          <View style={styles.viewOnceIcon}>
            {viewedState ? (
              <EyeOff size={15} color={theme.textMuted} />
            ) : (
              <Timer size={15} color={theme.text} />
            )}
          </View>
          <Text
            style={[
              styles.viewOnceLabel,
              viewedState && styles.viewOnceLabelDone,
            ]}
          >
            {viewedState
              ? "Viewed"
              : loadingView
                ? "Opening…"
                : isVideo
                  ? "View video"
                  : "View photo"}
          </Text>
          {!viewedState ? <Eye size={14} color={theme.textMuted} /> : null}
        </Pressable>
        {isVideo && viewer && VIDEO_AVAILABLE ? (
          <InlineVideo
            uri={viewer}
            isLocal={/^(file|content|data):/i.test(viewer)}
            style={styles.hiddenViewOnceVideo}
            openInitially
            viewOnce
            onViewerClose={() => setViewer(null)}
          />
        ) : (
          <ImageViewerModal
            uri={viewer}
            viewOnce
            onClose={() => setViewer(null)}
          />
        )}
        {viewError ? (
          <Text style={styles.viewOnceError} accessibilityRole="alert">
            {viewError}
          </Text>
        ) : null}
        {mediaPending ? (
          <UploadState
            mediaState={mediaState}
            mediaProgress={mediaProgress}
            uploadSpeed={message._uploadSpeed}
            failureReason={message._failureReason}
            onCancel={() => onCancelUpload?.(message)}
            onRetry={() => onRetryUpload?.(message)}
          />
        ) : null}
      </View>
    );
  }

  if (isImageFile(message)) {
    // Signal-style aspect-ratio sizing from the image's intrinsic dimensions.
    // Prefer the metadata dimensions (carried on the optimistic message); fall
    // back to the dimensions we measured via Image.getSize for images that
    // arrive without metadata (received images / older messages). Only the
    // last resort — no metadata AND no measurement yet — uses the neutral box.
    const measuredForThis =
      measured && measured.url === resolvedForSize ? measured : null;
    const intrinsicW =
      Number(message.metadata?.width) ||
      cachedDimensions?.width ||
      measuredForThis?.width ||
      null;
    const intrinsicH =
      Number(message.metadata?.height) ||
      cachedDimensions?.height ||
      measuredForThis?.height ||
      null;
    const box = computeImageSize(winWidth, intrinsicW, intrinsicH);
    const resolved = uploadUrl(message.file_url) || undefined;
    // Optimistic local images (file:/content:) render with a plain <Image>;
    // remote uploads go through AuthedImage so the Bearer token is attached
    // (the server's /uploads route is behind auth — a tokenless GET 401s and
    // RN caches the blank).
    const isLocal = !!resolved && /^(file|content|data):/i.test(resolved);
    return (
      <View>
        <Pressable
          onPress={() =>
            setViewer(getCachedMediaSync(resolved) || resolved || null)
          }
          onLongPress={onLongPress}
          delayLongPress={250}
        >
          {isLocal ? (
            <Image
              source={{ uri: resolved }}
              style={[styles.fileImage, box]}
              resizeMode="cover"
            />
          ) : (
            <AuthedImage
              uri={resolved}
              style={[styles.fileImage, box]}
              resizeMode="cover"
            />
          )}
          {/* Single upload indicator overlaid INSIDE the media card (a circular
              progress ring + cancel/retry) — no separate spinner/progress row. */}
          {mediaPending ? (
            <MediaUploadOverlay
              mediaState={mediaState}
              mediaProgress={mediaProgress}
              onCancel={() => onCancelUpload?.(message)}
              onRetry={() => onRetryUpload?.(message)}
            />
          ) : null}
        </Pressable>
        <ImageViewerModal uri={viewer} onClose={() => setViewer(null)} />
      </View>
    );
  }

  // ─── Video attachment: inline Signal-style media player ───
  // Sized by the video's intrinsic dimensions within the same envelope as
  // images. When the native expo-video module isn't available in this build we
  // fall through to the generic file card below so the video is still openable.
  if (isVideoFile(message) && VIDEO_AVAILABLE) {
    const resolved = uploadUrl(message.file_url) || undefined;
    const isLocal = !!resolved && /^(file|content|data):/i.test(resolved);
    // Prefer the metadata dimensions; fall back to the poster-frame dimensions
    // reported by InlineVideo (the common case — videos rarely carry metadata).
    const videoForThis =
      videoSize && videoSize.url === resolved ? videoSize : null;
    const intrinsicW =
      Number(message.metadata?.width) ||
      cachedDimensions?.width ||
      videoForThis?.width ||
      null;
    const intrinsicH =
      Number(message.metadata?.height) ||
      cachedDimensions?.height ||
      videoForThis?.height ||
      null;
    const box = computeImageSize(winWidth, intrinsicW, intrinsicH);
    const durationMs = Number(message.metadata?.durationMs) || null;
    return (
      <View>
        <InlineVideo
          uri={resolved || ""}
          isLocal={isLocal}
          style={[styles.fileImage, box]}
          durationMs={durationMs}
          onLongPress={onLongPress}
          onPosterSize={({ width, height }) => {
            if (!resolved || !width || !height) return;
            setCachedMediaDimensions(resolved, width, height);
            setVideoSize((prev) =>
              prev && prev.url === resolved && prev.width === width
                ? prev
                : { url: resolved, width, height },
            );
          }}
        />
        {/* Single upload indicator overlaid INSIDE the media card. */}
        {mediaPending ? (
          <MediaUploadOverlay
            mediaState={mediaState}
            mediaProgress={mediaProgress}
            onCancel={() => onCancelUpload?.(message)}
            onRetry={() => onRetryUpload?.(message)}
          />
        ) : null}
      </View>
    );
  }

  if (isAudioFile(message)) {
    return (
      <View>
        <VoicePlayer uri={uploadUrl(message.file_url) || ""} />
        {mediaPending ? (
          <UploadState
            mediaState={mediaState}
            mediaProgress={mediaProgress}
            failureReason={message._failureReason}
            onCancel={() => onCancelUpload?.(message)}
            onRetry={() => onRetryUpload?.(message)}
          />
        ) : null}
      </View>
    );
  }

  return (
    <View>
      <Pressable
        style={styles.fileCard}
        disabled={openingFile}
        onLongPress={onLongPress}
        delayLongPress={250}
        onPress={async () => {
          if (openingFile) return;
          setOpeningFile(true);
          const res = await openAuthedFile(
            message.file_url,
            message.file_name,
            message.file_type,
          );
          setOpeningFile(false);
          if (!res.ok) {
            Alert.alert("Could not open file", res.error || "Unknown error.");
          }
        }}
      >
        {openingFile ? (
          <ActivityIndicator size="small" color={theme.primary} />
        ) : (
          <FileText size={20} color={theme.primary} />
        )}
        <View style={{ flex: 1 }}>
          <Text style={styles.fileName} numberOfLines={1}>
            {message.file_name || "File"}
          </Text>
          {message.file_size ? (
            <Text style={styles.fileSize}>{fmtSize(message.file_size)}</Text>
          ) : null}
        </View>
      </Pressable>
      {mediaPending ? (
        <UploadState
          mediaState={mediaState}
          mediaProgress={mediaProgress}
          failureReason={message._failureReason}
          onCancel={() => onCancelUpload?.(message)}
          onRetry={() => onRetryUpload?.(message)}
        />
      ) : null}
    </View>
  );
}

/**
 * Full-screen image viewer (Signal-style). Tap anywhere or the X to close.
 * For view-once media the image is shown once and download is suppressed.
 */
function ImageViewerModal({
  uri,
  viewOnce,
  onClose,
}: {
  uri: string | null;
  viewOnce?: boolean;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!uri || !viewOnce) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") onClose();
    });
    return () => subscription.remove();
  }, [uri, viewOnce, onClose]);

  if (!uri) return null;
  // Pinch-to-zoom / pan / double-tap zoom (Signal MediaPreview parity). Tap at
  // 1× to dismiss; the close button is always available.
  const isLocal = /^(file|content|data):/i.test(uri);
  return (
    <Modal visible animationType="none" transparent onRequestClose={onClose}>
      {/* A Modal renders in a SEPARATE native view hierarchy that sits OUTSIDE
          the app's root GestureHandlerRootView — so gesture-handler receives no
          touches inside it (pinch/pan/double-tap silently do nothing). Wrapping
          the modal body in its own GestureHandlerRootView restores the zoom
          gestures. */}
      <GestureHandlerRootView style={viewerStyles.backdrop}>
        <Pressable
          style={[viewerStyles.closeBtn, { top: insets.top + 8 }]}
          onPress={onClose}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Close image"
        >
          <X size={22} color="#fff" />
        </Pressable>
        <ZoomableImage uri={uri} isLocal={isLocal} onTap={onClose} />
        {viewOnce ? (
          <Text style={viewerStyles.note}>
            This photo can only be viewed once
          </Text>
        ) : null}
      </GestureHandlerRootView>
    </Modal>
  );
}

const viewerStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.92)",
    alignItems: "center",
    justifyContent: "center",
  },
  image: { width: "100%", height: "85%" },
  closeBtn: {
    position: "absolute",
    right: 20,
    zIndex: 2,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  note: {
    position: "absolute",
    bottom: 40,
    color: "#fff",
    opacity: 0.8,
    fontSize: 13,
  },
});

function UploadState({
  mediaState,
  mediaProgress,
  failureReason,
  onRetry,
}: {
  mediaState: string;
  mediaProgress: number;
  uploadSpeed?: number;
  failureReason?: string | null;
  onCancel?: () => void;
  onRetry: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const uploading = mediaState === "uploading";
  const queued = mediaState === "queued";
  const failed = mediaState === "failed";
  if (!uploading && !queued && !failed) return null;
  return (
    <View style={styles.uploadWrap}>
      {(uploading || queued) && (
        <>
          <ActivityIndicator size="small" color={theme.primary} />
          <View style={styles.progressTrack}>
            <View
              style={[styles.progressFill, { width: `${mediaProgress}%` }]}
            />
          </View>
        </>
      )}
      {failed && (
        <View style={styles.uploadRow}>
          <Text style={styles.uploadFail} numberOfLines={2}>
            {failureReason || "Upload failed"}
          </Text>
          <Pressable onPress={onRetry} hitSlop={6}>
            <Text style={styles.uploadAction}>Retry</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

/**
 * MediaUploadOverlay — the SINGLE upload indicator for an image/video bubble,
 * overlaid in the CENTER of the media card (WhatsApp/Telegram/Signal model).
 * While uploading it shows a circular determinate progress ring around a cancel
 * (X) button; on failure it shows a tappable retry button. This replaces the
 * old stack of separate spinners + a progress bar that competed with the
 * delivery-status spinner and the video poster spinner.
 */
function MediaUploadOverlay({
  mediaState,
  mediaProgress,
  onCancel,
  onRetry,
}: {
  mediaState: string;
  mediaProgress: number;
  onCancel?: () => void;
  onRetry: () => void;
}) {
  const failed = mediaState === "failed";
  const size = 54;
  const stroke = 3;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, mediaProgress));
  return (
    <View style={overlayStyles.root} pointerEvents="box-none">
      <View style={overlayStyles.scrim} pointerEvents="none" />
      {failed ? (
        <Pressable style={overlayStyles.btn} onPress={onRetry} hitSlop={10}>
          <RefreshCw size={24} color="#fff" />
        </Pressable>
      ) : (
        <Pressable style={overlayStyles.btn} onPress={onCancel} hitSlop={10}>
          <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
            <Circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              stroke="rgba(255,255,255,0.35)"
              strokeWidth={stroke}
              fill="none"
            />
            <Circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              stroke="#fff"
              strokeWidth={stroke}
              fill="none"
              strokeDasharray={`${circ} ${circ}`}
              strokeDashoffset={circ * (1 - pct / 100)}
              strokeLinecap="round"
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          </Svg>
          <X size={20} color="#fff" />
        </Pressable>
      )}
    </View>
  );
}

const overlayStyles = StyleSheet.create({
  root: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  scrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.28)",
  },
  btn: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.45)",
  },
});

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    fileCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      backgroundColor: theme.bgElevated,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: 10,
      padding: 10,
      marginBottom: 4,
      minWidth: 180,
    },
    fileName: { fontSize: 14, color: theme.text, fontWeight: "500" },
    fileSize: { fontSize: 11, color: theme.textMuted },
    fileImage: {
      // Width/height are supplied dynamically by computeImageSize(); these are
      // fallbacks. Matches the web .image (radius 14, surface placeholder).
      width: 240,
      height: 180,
      borderRadius: 14,
      marginBottom: 4,
      backgroundColor: theme.surface,
    },
    viewOnceCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      backgroundColor: theme.surface,
      alignSelf: "flex-start",
      marginBottom: 4,
    },
    viewOnceDone: { opacity: 0.7 },
    hiddenViewOnceVideo: {
      position: "absolute",
      width: 1,
      height: 1,
      opacity: 0,
    },
    viewOnceError: {
      maxWidth: 260,
      paddingTop: 6,
      color: theme.danger,
      fontSize: 12,
    },
    viewOnceIcon: {
      width: 26,
      height: 26,
      borderRadius: 13,
      borderWidth: 1.5,
      borderColor: theme.text,
      alignItems: "center",
      justifyContent: "center",
    },
    viewOnceLabel: { fontSize: 14, color: theme.text, fontWeight: "500" },
    viewOnceLabelDone: { color: theme.textMuted, fontStyle: "italic" },
    uploadWrap: {
      marginBottom: 4,
      paddingHorizontal: 2,
      gap: 4,
    },
    uploadRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    uploadAction: {
      fontSize: 12,
      color: theme.primary,
      fontFamily: theme.fontSemiBold,
    },
    uploadFail: { flex: 1, fontSize: 12, color: theme.danger },
    progressTrack: {
      width: "100%",
      height: 4,
      borderRadius: 999,
      backgroundColor: theme.surface,
      overflow: "hidden",
    },
    progressFill: {
      height: "100%",
      backgroundColor: theme.primary,
    },
  });
