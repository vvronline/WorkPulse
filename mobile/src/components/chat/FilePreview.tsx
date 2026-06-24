import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { FileText, Timer, Eye, EyeOff, X } from "lucide-react-native";
import { useAuth } from "../../auth/AuthContext";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import { uploadUrl } from "../../config";
import { markMessageViewed } from "../../features";
import VoicePlayer from "../VoicePlayer";
import type { ChatMessage } from "../../features";
import { fmtSize, isAudioFile, isImageFile } from "./chatUtils";

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
  const [viewer, setViewer] = useState<string | null>(null);
  const [consumed, setConsumed] = useState(false);
  const [loadingView, setLoadingView] = useState(false);
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
            failureReason={message._failureReason}
            onCancel={() => onCancelUpload?.(message)}
            onRetry={() => onRetryUpload?.(message)}
          />
        ) : null}
      </View>
    );
  }

  if (isImageFile(message)) {
    return (
      <View>
        <Pressable onPress={() => setViewer(uploadUrl(message.file_url) || null)}>
          <Image
            source={{ uri: uploadUrl(message.file_url) || undefined }}
            style={styles.fileImage}
            resizeMode="cover"
          />
        </Pressable>
        <ImageViewerModal uri={viewer} onClose={() => setViewer(null)} />
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
        onPress={() => {
          const u = uploadUrl(message.file_url);
          if (u) Linking.openURL(u);
        }}
      >
        <FileText size={20} color={theme.primary} />
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
  failureReason,
  onCancel,
  onRetry,
}: {
  mediaState: string;
  mediaProgress: number;
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
                {queued ? "Queued" : `Uploading ${mediaProgress}%`}
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
      width: 200,
      height: 150,
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