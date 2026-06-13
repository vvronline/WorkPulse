import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { Video } from "lucide-react-native";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { SERVER_ORIGIN } from "../../src/config";

/**
 * Lightweight meeting entry point. Full in-app WebRTC video requires a custom
 * dev build with react-native-webrtc (Phase 7). Until that ships, this screen
 * confirms the meeting and offers to open it in the device browser (which uses
 * the existing web meeting room over the same backend).
 */
export default function MeetingScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { code } = useLocalSearchParams<{ code: string }>();
  const [opening, setOpening] = useState(false);
  const url = `${SERVER_ORIGIN}/meeting/${code}`;

  useEffect(() => {
    // No auto-open; let the user tap so it isn't surprising.
  }, []);

  async function open() {
    setOpening(true);
    try {
      await Linking.openURL(url);
    } finally {
      setOpening(false);
    }
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Meeting" }} />
      <View style={styles.card}>
        <View style={styles.iconWrap}>
          <Video size={32} color={theme.primary} />
        </View>
        <Text style={styles.title}>Join Meeting</Text>
        <Text style={styles.code}>Code: {code}</Text>
        <Text style={styles.hint}>
          Video meetings open in your browser for now. In-app calling arrives in
          a future update.
        </Text>
        <Pressable style={styles.btn} onPress={open} disabled={opening}>
          {opening ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Video size={16} color="#fff" />
              <Text style={styles.btnText}>Open Meeting</Text>
            </>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg, padding: 16, justifyContent: "center" },
  card: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    padding: 24,
    alignItems: "center",
    gap: 10,
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: theme.primaryGlow,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  title: { fontSize: 18, fontWeight: "800", color: theme.text },
  code: { fontSize: 13, color: theme.textSecondary },
  hint: {
    fontSize: 13,
    color: theme.textMuted,
    textAlign: "center",
    lineHeight: 19,
    marginVertical: 4,
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 12,
    paddingHorizontal: 24,
    marginTop: 6,
  },
  btnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});