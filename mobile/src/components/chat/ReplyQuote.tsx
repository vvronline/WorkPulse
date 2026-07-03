import { useMemo } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { FileText, Mic, Image as ImageIcon, Film } from "../../icons";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import type { ChatMessage } from "../../features";
import { AuthedImage } from "../AuthedImage";
import { uploadUrl } from "../../config";

/**
 * In-bubble quoted reply preview (mirrors the web ReplyPreview when rendered
 * inside a MessageBubble, Signal QuoteView parity). Shows the original sender +
 * a one-line snippet. When the quoted message carried media, a thumbnail
 * (image/video) or a media-type label ("Photo"/"Video"/"GIF"/"Voice message"/
 * file name) is shown instead of the generic "Attachment" text.
 *
 * Tapping the quote (Signal behaviour) scrolls the conversation to the original
 * message and flashes its highlight — wired via the `onPress` callback.
 */
export default function ReplyQuote({
  message,
  onPress,
}: {
  message: ChatMessage;
  onPress?: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const fileType = (message.reply_to_file_type || "").toLowerCase();
  const fileName = message.reply_to_file_name || "";
  const fileUrl = message.reply_to_file_url || "";
  const hasFile = !!fileUrl;

  const isImage =
    fileType.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|heic|bmp)$/i.test(fileName);
  const isVideo =
    fileType.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(fileName);
  const isAudio =
    fileType.startsWith("audio/") || /\.(m4a|mp3|aac|ogg|wav)$/i.test(fileName);
  const isGif = fileType === "image/gif" || /\.gif$/i.test(fileName);

  // The text snippet to show. Prefer the original message's own text content;
  // otherwise fall back to a media-type label.
  const snippet = (message.reply_to_content || "").trim();
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

  // A small thumbnail is shown for image/video replies (Signal QuoteView).
  const thumbUri = (isImage || isVideo) && fileUrl ? uploadUrl(fileUrl) : null;
  const isLocalThumb =
    !!thumbUri && /^(file|content|data):/i.test(thumbUri);

  const Inner = (
    <View style={styles.replyQuote}>
      <View style={styles.replyQuoteTextCol}>
        <Text style={styles.replyQuoteName} numberOfLines={1}>
          {message.reply_to_sender_name || "Reply"}
        </Text>
        <View style={styles.replyQuoteSnippetRow}>
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
          <Text style={styles.replyQuoteText} numberOfLines={1}>
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
          <AuthedImage
            uri={thumbUri}
            style={styles.thumb}
            resizeMode="cover"
          />
        )
      ) : null}
    </View>
  );

  if (!onPress) return Inner;
  return (
    <Pressable onPress={onPress} hitSlop={4}>
      {Inner}
    </Pressable>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    replyQuote: {
      flexDirection: "row",
      alignItems: "center",
      borderLeftWidth: 3,
      borderLeftColor: theme.primary,
      backgroundColor: "rgba(255,255,255,0.06)",
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 4,
      marginBottom: 4,
      gap: 8,
    },
    replyQuoteTextCol: { flex: 1, gap: 1 },
    replyQuoteName: {
      fontSize: 11,
      fontWeight: "700",
      color: theme.primaryLight,
    },
    replyQuoteSnippetRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    replyQuoteText: { flex: 1, fontSize: 12, color: theme.textSecondary },
    // Signal QuoteView thumbnail: a small rounded square preview on the right.
    thumb: {
      width: 38,
      height: 38,
      borderRadius: 6,
      backgroundColor: theme.surface,
    },
  });