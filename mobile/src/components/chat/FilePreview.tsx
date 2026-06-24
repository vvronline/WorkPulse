import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { FileText, Timer, Eye, EyeOff, X } from "lucide-react-native";
import { useAuth } from "../../auth/AuthContext";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import { uploadUrl } from "../../config";
import { markMessageViewed } from "../../features";
import VoicePlayer from "../VoicePlayer";
import { AuthedImage } from "../AuthedImage";
import type { ChatMessage } from "../../features";
import { fmtSize, isAudioFile, isImageFile } from "./chatUtils";
import { openAuthedFile } from "./openAuthedFile";

/** Human-readable upload throughput, e.g. "1.2 MB/s" / "340 KB/s". */
function fmtSpeed(bytesPerSec?: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) return "";
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 * 1024)
    return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}

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
}: {
  message: ChatMessage;
  onCancelUpload?: (message: ChatMessage) => void;
  onRetryUpload?: (message: ChatMessage) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { user } = useAuth();
  const { width: winWidth } = useWindowDimensions();
  const [viewer, setViewer] = useState<string | null>(null);
  const [consumed, setConsumed] = useState(false);
  const [loadingView, setLoadingView] = useState(false);
  const [openingFile, setOpeningFile] = useState(false);
  if (!message.file_url) return null;
  const mediaStateRaw = message._mediaState || message.media_state || "";
  const mediaState = mediaStateRaw === "processing" ? "uploading" : mediaStateRaw;
  const mediaPending =
    Number(message.id) < 0 ||
    mediaState === "queued" ||
    mediaState === "uploading";
  const mediaProgress = Math.max(
    0,
    Math.min(100, Number(message._mediaProgress ?? message.media_progress ?? 0)),
  );

  const isMine = Number(message.sender_id) === Number(user?.id);
  const viewOnce = !!message.metadata?.viewOnce;
  const alreadyViewed =
    consumed ||
    (Array.isArray(message.metadata?.viewedBy) &&
      message.metadata!.viewedBy!.includes(Number(user?.id)));

  const openViewOnce = async () => {
    if (loadingView) return;
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
      /* ignore */
    } finally {
      setLoadingView(false);
    }
  };

  // ─── View-once image: "tap to view" pill ───
  if (viewOnce && isImageFile(message)) {
    const viewedState = alreadyViewed && !isMine;
    return (
      <View>
        <Pressable
          style={[styles.viewOnceCard, viewedState && styles.viewOnceDone]}
          onPress={viewedState ? undefined : openViewOnce}
          disabled={viewedState || loadingView}
        >
          <View style={styles.viewOnceIcon}>
            {viewedState ? (
              <EyeOff size={15} color={theme.textMuted} />
            ) : (
              <Timer size={15} color={theme.text} />
            )}
          </View>
          <Text style={[styles.viewOnceLabel, viewedState && styles.viewOnceLabelDone]}>
            {viewedState ? "Viewed" : loadingView ? "Opening…" : "Photo"}
          </Text>
          {!viewedState ? <Eye size={14} color={theme.textMuted} /> : null}
        </Pressable>
        <ImageViewerModal uri={viewer} viewOnce onClose={() => setViewer(null)} />
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
    // Signal-style aspect-ratio sizing from the image's intrinsic dimensions
    // (carried on the optimistic message metadata, falls back to a sane box).
    const intrinsicW = Number(message.metadata?.width) || null;
    const intrinsicH = Number(message.metadata?.height) || null;
    const box = computeImageSize(winWidth, intrinsicW, intrinsicH);
    const resolved = uploadUrl(message.file_url) || undefined;
    // Optimistic local images (file:/content:) render with a plain <Image>;
    // remote uploads go through AuthedImage so the Bearer token is attached
    // (the server's /uploads route is behind auth — a tokenless GET 401s and
    // RN caches the blank).
    const isLocal = !!resolved && /^(file|content|data):/i.test(resolved);
    return (
      <View>
        <Pressable onPress={() => setViewer(resolved || null)}>
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
        </Pressable>
        <ImageViewerModal uri={viewer} onClose={() => setViewer(null)} />
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
  if (!uri) return null;
  return (
    <Modal visible animationType="fade" transparent onRequestClose={onClose}>
      <Pressable style={viewerStyles.backdrop} onPress={onClose}>
        <Pressable style={viewerStyles.closeBtn} onPress={onClose} hitSlop={10}>
          <X size={22} color="#fff" />
        </Pressable>
        <Image source={{ uri }} style={viewerStyles.image} resizeMode="contain" />
        {viewOnce ? (
          <Text style={viewerStyles.note}>This photo can only be viewed once</Text>
        ) : null}
      </Pressable>
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
    top: 48,
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
  uploadSpeed,
  failureReason,
  onCancel,
  onRetry,
}: {
  mediaState: string;
  mediaProgress: number;
  uploadSpeed?: number;
  failureReason?: string | null;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const uploading = mediaState === "uploading";
  const queued = mediaState === "queued";
  const failed = mediaState === "failed";
  if (!uploading && !queued && !failed) return null;
  const speedLabel = uploading ? fmtSpeed(uploadSpeed) : "";
  return (
    <View style={styles.uploadWrap}>
      {(uploading || queued) && (
        <>
          <View style={styles.uploadRow}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              {uploading ? (
                <ActivityIndicator size="small" color={theme.primary} />
              ) : null}
              <Text style={styles.uploadLabel}>
                {queued
                  ? "Queued"
                  : `Uploading ${mediaProgress}%${
                      speedLabel ? ` · ${speedLabel}` : ""
                    }`}
              </Text>
            </View>
            <Pressable onPress={onCancel} hitSlop={6}>
              <Text style={styles.uploadAction}>Cancel</Text>
            </Pressable>
          </View>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${mediaProgress}%` }]} />
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
    uploadLabel: { fontSize: 12, color: theme.textMuted },
    uploadAction: { fontSize: 12, color: theme.primary, fontFamily: theme.fontSemiBold },
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