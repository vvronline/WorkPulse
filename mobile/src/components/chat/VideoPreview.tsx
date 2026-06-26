import { useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Send, Timer, X } from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";

/**
 * Resolve expo-video defensively (same pattern as InlineVideo). A missing
 * native module degrades to a neutral preview frame so the bundle never crashes.
 */
let ExpoVideo: any = null;
try {
  ExpoVideo = require("expo-video");
} catch {
  ExpoVideo = null;
}

const VIDEO_AVAILABLE = !!ExpoVideo?.VideoView;

/**
 * VideoPreview — the "review before send" screen for a recorded/picked video,
 * mirroring WhatsApp/Telegram/Signal. Previously a recorded video was uploaded
 * the instant the shutter was released (no chance to review, caption, or
 * discard). Now the captured video opens here first:
 *   • Loops the clip with native transport controls (scrub to review/trim
 *     visually).
 *   • Caption input + view-once toggle (parity with the photo MediaEditor).
 *   • Send (paper-plane) or discard (X back to the camera).
 */
function VideoStage({ uri }: { uri: string }) {
  const player = ExpoVideo.useVideoPlayer({ uri }, (p: any) => {
    p.loop = true;
    p.muted = false;
    try {
      p.play();
    } catch {
      /* ignore */
    }
  });
  return (
    <ExpoVideo.VideoView
      player={player}
      style={StyleSheet.absoluteFill}
      contentFit="contain"
      nativeControls
      allowsFullscreen={false}
    />
  );
}

export default function VideoPreview({
  uri,
  onSend,
  onClose,
}: {
  uri: string;
  onSend: (opts: { caption?: string; viewOnce: boolean }) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const insets = useSafeAreaInsets();
  const [caption, setCaption] = useState("");
  const [viewOnce, setViewOnce] = useState(false);

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        {/* Top bar: close + view-once toggle */}
        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
          <Pressable style={styles.iconBtn} onPress={onClose} hitSlop={8}>
            <X size={22} color="#fff" />
          </Pressable>
          <Pressable
            style={[styles.viewOnceBtn, viewOnce && styles.viewOnceOn]}
            onPress={() => setViewOnce((v) => !v)}
            hitSlop={8}
          >
            <Timer size={18} color={viewOnce ? "#0b0b0d" : "#fff"} />
            <Text
              style={[
                styles.viewOnceText,
                viewOnce && styles.viewOnceTextOn,
              ]}
            >
              View once
            </Text>
          </Pressable>
        </View>

        {/* Video stage */}
        <View style={styles.stage}>
          {VIDEO_AVAILABLE ? (
            <VideoStage uri={uri} />
          ) : (
            <Text style={styles.fallback}>
              Preview unavailable on this build.
            </Text>
          )}
        </View>

        {/* Bottom: caption + send */}
        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 12 }]}>
          <TextInput
            style={styles.caption}
            placeholder="Add a caption…"
            placeholderTextColor={theme.textMuted}
            value={caption}
            onChangeText={setCaption}
            multiline
          />
          <Pressable
            style={styles.sendBtn}
            onPress={() =>
              onSend({ caption: caption.trim() || undefined, viewOnce })
            }
          >
            <Send size={20} color="#fff" />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: "#000" },
    topBar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingBottom: 8,
    },
    iconBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(255,255,255,0.12)",
    },
    viewOnceBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 12,
      height: 40,
      borderRadius: 20,
      backgroundColor: "rgba(255,255,255,0.12)",
    },
    viewOnceOn: { backgroundColor: "#fff" },
    viewOnceText: { color: "#fff", fontSize: 13, fontFamily: theme.fontSemiBold },
    viewOnceTextOn: { color: "#0b0b0d" },
    stage: { flex: 1, alignItems: "center", justifyContent: "center" },
    fallback: { color: "#fff", fontSize: 15, fontFamily: theme.fontMedium },
    bottomBar: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 10,
      paddingHorizontal: 12,
      paddingTop: 10,
    },
    caption: {
      flex: 1,
      minHeight: 44,
      maxHeight: 120,
      borderRadius: 22,
      backgroundColor: "rgba(255,255,255,0.12)",
      color: "#fff",
      paddingHorizontal: 16,
      paddingVertical: 10,
      fontSize: 15,
    },
    sendBtn: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: theme.primary,
      alignItems: "center",
      justifyContent: "center",
    },
  });
