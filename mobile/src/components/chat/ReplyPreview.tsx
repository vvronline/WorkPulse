import { useMemo } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import {
  CornerUpLeft,
  X as XIcon,
  FileText,
  Mic,
  Image as ImageIcon,
  Film,
} from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import type { ChatMessage } from "../../features";
import { AuthedImage } from "../AuthedImage";
import { uploadUrl } from "../../config";

/**
 * Composer "replying to…" strip shown above the input bar (mirrors the web
 * ReplyPreview + Signal's compose-reply banner). Tapping the X cancels the
 * reply. When replying to a media message it shows a thumbnail + a media-type
 * label ("Photo"/"Video"/"GIF"/"Voice message"/file name) instead of a generic
 * "Attachment" string.
 */
export default function ReplyPreview({
  replyTo,
  onCancel,
}: {
  replyTo: ChatMessage;
  onCancel: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const fileType = (replyTo.file_type || "").toLowerCase();
  const fileName = replyTo.file_name || "";
  const fileUrl = replyTo.file_url || "";
  const hasFile = !!fileUrl;

  const isImage =
    fileType.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|heic|bmp)$/i.test(fileName);
  const isVideo =
    fileType.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(fileName);
  const isAudio =
    fileType.startsWith("audio/") || /\.(m4a|mp3|aac|ogg|wav)$/i.test(fileName);
  const isGif = fileType === "image/gif" || /\.gif$/i.test(fileName);

  const snippet = (replyTo.content || "").trim();
  const mediaLabel = isGif
    ? "GIF"
    : isImage
      ? "Photo"
      : isVideo
        ? "Video"
        : isAudio
          ? "Voice message"
          : hasFile
            ? fileName || "File"
            : "";
  const displayText = snippet || mediaLabel || "Message";

  const thumbUri = (isImage || isVideo) && fileUrl ? uploadUrl(fileUrl) : null;
  const isLocalThumb = !!thumbUri && /^(file|content|data):/i.test(thumbUri);

  return (
    <View style={styles.replyBar}>
      <CornerUpLeft size={16} color={theme.primary} />
      <View style={{ flex: 1 }}>
        <Text style={styles.replyBarName} numberOfLines={1}>
          Replying to {replyTo.sender_name || "message"}
        </Text>
        <View style={styles.snippetRow}>
          {!snippet && hasFile ? (
            isImage ? (
              <ImageIcon size={12} color={theme.textSecondary} />
            ) : isVideo ? (
              <Film size={12} color={theme.textSecondary} />
            ) : isAudio ? (
              <Mic size={12} color={theme.textSecondary} />
            ) : (
              <FileText size={12} color={theme.textSecondary} />
            )
          ) : null}
          <Text style={styles.replyBarText} numberOfLines={1}>
            {displayText}
          </Text>
        </View>
      </View>
      {thumbUri ? (
        isLocalThumb ? (
          <Image
            source={{ uri: thumbUri }}
            style={styles.thumb}
            resizeMode="cover"
          />
        ) : (
          <AuthedImage uri={thumbUri} style={styles.thumb} resizeMode="cover" />
        )
      ) : null}
      <Pressable onPress={onCancel} hitSlop={8}>
        <XIcon size={18} color={theme.textSecondary} />
      </Pressable>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    replyBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 8,
      backgroundColor: theme.bgSecondary,
      borderTopWidth: 1,
      borderTopColor: theme.border,
    },
    replyBarName: {
      fontSize: 12,
      fontWeight: "700",
      color: theme.primaryLight,
    },
    snippetRow: { flexDirection: "row", alignItems: "center", gap: 4 },
    replyBarText: { flex: 1, fontSize: 12, color: theme.textSecondary },
    thumb: {
      width: 36,
      height: 36,
      borderRadius: 6,
      backgroundColor: theme.surface,
    },
  });