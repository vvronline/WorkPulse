import { useMemo } from "react";
import { Image, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { FileText } from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import { uploadUrl } from "../../config";
import VoicePlayer from "../VoicePlayer";
import type { ChatMessage } from "../../features";
import { fmtSize, isAudioFile, isImageFile } from "./chatUtils";

/**
 * Renders a message's attachment (mirrors the web FilePreview): inline image,
 * voice player, or a tappable file card. Returns null when there's no file.
 */
export default function FilePreview({ message }: { message: ChatMessage }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  if (!message.file_url) return null;

  if (isImageFile(message)) {
    return (
      <Image
        source={{ uri: uploadUrl(message.file_url) || undefined }}
        style={styles.fileImage}
        resizeMode="cover"
      />
    );
  }

  if (isAudioFile(message)) {
    return <VoicePlayer uri={uploadUrl(message.file_url) || ""} />;
  }

  return (
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
      borderRadius: 10,
      marginBottom: 4,
      backgroundColor: theme.surface,
    },
  });