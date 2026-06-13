import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { Check } from "lucide-react-native";
import type { Theme } from "../src/theme";
import { useTheme } from "../src/theme/ThemeProvider";
import { getNotes, saveNotes, type Notebook } from "../src/features";

const PAGE_ID = "mobile-daily";

export default function NotesScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const original = useRef<Notebook | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await getNotes();
        original.current = data.data;
        const page = data.data?.pages?.find((p) => p.id === PAGE_ID);
        // Fall back to the first page if our mobile page doesn't exist yet.
        const first = data.data?.pages?.[0];
        setContent(page?.content ?? first?.content ?? "");
      } catch {
        /* ignore */
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const persist = useCallback(async (text: string) => {
    setSaving(true);
    try {
      const existing = original.current?.pages ?? [];
      const idx = existing.findIndex((p) => p.id === PAGE_ID);
      const pages =
        idx >= 0
          ? existing.map((p) =>
              p.id === PAGE_ID ? { ...p, content: text } : p,
            )
          : [...existing, { id: PAGE_ID, title: "Daily Notes", content: text }];
      const notebook: Notebook = { ...(original.current ?? {}), pages };
      await saveNotes(notebook);
      original.current = notebook;
      setSavedAt(new Date().toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      }));
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save notes");
    } finally {
      setSaving(false);
    }
  }, []);

  function onChange(text: string) {
    setContent(text);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => persist(text), 1200);
  }

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Notes" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Stack.Screen
        options={{
          title: "Notes",
          headerRight: () =>
            saving ? (
              <ActivityIndicator size="small" color={theme.primary} />
            ) : savedAt ? (
              <View style={styles.saved}>
                <Check size={14} color={theme.success} />
                <Text style={styles.savedText}>Saved {savedAt}</Text>
              </View>
            ) : null,
        }}
      />
      <TextInput
        style={styles.editor}
        value={content}
        onChangeText={onChange}
        placeholder="Write your notes…"
        placeholderTextColor={theme.textMuted}
        multiline
        textAlignVertical="top"
        autoFocus
      />
    </KeyboardAvoidingView>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: "center", justifyContent: "center" },
  editor: {
    flex: 1,
    padding: 18,
    color: theme.text,
    fontSize: 16,
    lineHeight: 24,
  },
  saved: { flexDirection: "row", alignItems: "center", gap: 5 },
  savedText: { color: theme.textMuted, fontSize: 12 },
});
