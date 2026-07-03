import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { WebView } from "react-native-webview";
import * as Clipboard from "expo-clipboard";
import {
  Archive,
  ArchiveRestore,
  Check,
  MoreVertical,
  Pin,
  Plus,
  Share2,
  Trash2,
  X,
} from "../../src/icons";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { useNotes } from "../../src/notes/NotesContext";
import { buildQuillHtml } from "../../src/notes/quillEditorHtml";
import { tagColor } from "../../src/notes/notesUtils";
import { createNoteShare } from "../../src/features";

export default function NoteEditorScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const store = useNotes();

  const page = useMemo(
    () => store.pages.find((p) => p.id === id) || null,
    [store.pages, id],
  );

  const webRef = useRef<WebView>(null);
  const [title, setTitle] = useState(page?.title || "");
  const [tagText, setTagText] = useState("");
  const [showTagInput, setShowTagInput] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  // Keep the active page in sync when entering this route.
  useEffect(() => {
    if (id && store.activePageId !== id) store.setActivePageId(id);
  }, [id]);

  // Refresh local title field when the page changes.
  useEffect(() => {
    setTitle(page?.title || "");
  }, [page?.id]);

  // Reflect store savedFlash → local indicator.
  useEffect(() => {
    if (store.savedFlash) {
      setSavedFlash(true);
      const t = setTimeout(() => setSavedFlash(false), 1500);
      return () => clearTimeout(t);
    }
  }, [store.savedFlash]);

  // The editor HTML is built once with the page's current content. We
  // intentionally key the WebView by page id so switching pages re-mounts it
  // with the right content (simpler + safe vs. imperative setContents).
  const html = useMemo(
    () => buildQuillHtml(theme, page?.content || "", !!page?.readOnly),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page?.id, theme],
  );

  if (!page) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Note" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  const onTitleChange = (t: string) => {
    setTitle(t);
    store.handleTitleChange(t);
  };

  const onMessage = (e: { nativeEvent: { data: string } }) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.type === "change" && typeof msg.html === "string") {
        store.handleContentChange(msg.html);
      } else if (msg.type === "pagelink" && msg.id) {
        const target = store.pages.find((p) => p.id === msg.id);
        if (target) {
          store.setActivePageId(target.id);
          router.push(`/notes/${target.id}`);
        }
      }
    } catch {
      /* ignore */
    }
  };

  const addTag = () => {
    const t = tagText.trim();
    if (t) store.handleAddTag(page.id, t);
    setTagText("");
    setShowTagInput(false);
  };

  const onTogglePin = () => {
    store.handleTogglePin(page.id);
    setMenuOpen(false);
  };

  const onToggleArchive = () => {
    store.handleToggleArchive(page.id);
    setMenuOpen(false);
    router.back();
  };

  const onDelete = () => {
    setMenuOpen(false);
    Alert.alert("Delete note", `Delete "${page.title || "Untitled"}"? This cannot be undone.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          store.handleDeletePage(page.id);
          router.back();
        },
      },
    ]);
  };

  const onShare = async () => {
    setMenuOpen(false);
    try {
      const { data } = await createNoteShare(page.id);
      if (data?.url) {
        await Clipboard.setStringAsync(data.url);
        Alert.alert("Share link copied", data.url);
      }
    } catch {
      Alert.alert("Error", "Could not create a share link.");
    }
  };

  const onNewSubPage = () => {
    setMenuOpen(false);
    const childId = store.handleNewSubPage(page.id, "Untitled");
    router.push(`/notes/${childId}`);
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Stack.Screen
        options={{
          title: page.title || "Untitled",
          headerRight: () => (
            <View style={styles.headerActions}>
              {savedFlash ? (
                <View style={styles.savedFlash}>
                  <Check size={13} color={theme.success} />
                  <Text style={styles.savedText}>Saved</Text>
                </View>
              ) : null}
              <Pressable onPress={onTogglePin} hitSlop={8}>
                <Pin
                  size={18}
                  color={page.pinned ? theme.primary : theme.textSecondary}
                  fill={page.pinned ? theme.primary : "transparent"}
                />
              </Pressable>
              <Pressable onPress={() => setMenuOpen((v) => !v)} hitSlop={8}>
                <MoreVertical size={20} color={theme.textSecondary} />
              </Pressable>
            </View>
          ),
        }}
      />

      {/* ── Dropdown menu ── */}
      {menuOpen && (
        <View style={styles.menu}>
          <Pressable style={styles.menuItem} onPress={onNewSubPage}>
            <Plus size={16} color={theme.textSecondary} />
            <Text style={styles.menuText}>New sub-page</Text>
          </Pressable>
          <Pressable style={styles.menuItem} onPress={onShare}>
            <Share2 size={16} color={theme.textSecondary} />
            <Text style={styles.menuText}>Share link</Text>
          </Pressable>
          <Pressable style={styles.menuItem} onPress={onToggleArchive}>
            {page.archived ? (
              <ArchiveRestore size={16} color={theme.textSecondary} />
            ) : (
              <Archive size={16} color={theme.textSecondary} />
            )}
            <Text style={styles.menuText}>{page.archived ? "Unarchive" : "Archive"}</Text>
          </Pressable>
          <Pressable style={styles.menuItem} onPress={onDelete}>
            <Trash2 size={16} color={theme.danger} />
            <Text style={[styles.menuText, { color: theme.danger }]}>Delete</Text>
          </Pressable>
        </View>
      )}

      {/* ── Title + tags ── */}
      <View style={styles.metaBlock}>
        <TextInput
          style={styles.titleInput}
          value={title}
          onChangeText={onTitleChange}
          placeholder="Untitled"
          placeholderTextColor={theme.textMuted}
          multiline
        />
        <View style={styles.tagsRow}>
          {(page.tags || []).map((t) => (
            <Pressable
              key={t}
              style={[styles.tagChip, { borderColor: tagColor(t) }]}
              onPress={() => store.handleRemoveTag(page.id, t)}
            >
              <View style={[styles.tagDot, { backgroundColor: tagColor(t) }]} />
              <Text style={styles.tagName}>#{t}</Text>
              <X size={11} color={theme.textMuted} />
            </Pressable>
          ))}
          {showTagInput ? (
            <View style={styles.tagInputWrap}>
              <TextInput
                style={styles.tagInput}
                value={tagText}
                onChangeText={setTagText}
                onSubmitEditing={addTag}
                placeholder="tag…"
                placeholderTextColor={theme.textMuted}
                autoFocus
                returnKeyType="done"
              />
            </View>
          ) : (
            <Pressable style={styles.addTagBtn} onPress={() => setShowTagInput(true)}>
              <Plus size={12} color={theme.textSecondary} />
              <Text style={styles.addTagText}>Tag</Text>
            </Pressable>
          )}
        </View>
      </View>

      {/* ── Rich editor (WebView Quill) ── */}
      <View style={styles.editorWrap}>
        <WebView
          ref={webRef}
          key={page.id}
          originWhitelist={["*"]}
          source={{ html }}
          onMessage={onMessage}
          style={styles.webview}
          keyboardDisplayRequiresUserAction={false}
          hideKeyboardAccessoryView
          androidLayerType="hardware"
          setSupportMultipleWindows={false}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.bg },
    center: { alignItems: "center", justifyContent: "center" },

    headerActions: { flexDirection: "row", alignItems: "center", gap: 16 },
    savedFlash: { flexDirection: "row", alignItems: "center", gap: 4 },
    savedText: { color: theme.textMuted, fontSize: 11 },

    menu: {
      position: "absolute",
      top: 4,
      right: 12,
      zIndex: 50,
      backgroundColor: theme.bgElevated,
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: theme.radius,
      paddingVertical: 4,
      minWidth: 180,
      shadowColor: "#000",
      shadowOpacity: 0.3,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 8,
    },
    menuItem: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 11,
    },
    menuText: { color: theme.text, fontSize: 14 },

    metaBlock: {
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 8,
      gap: 10,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    titleInput: {
      color: theme.text,
      fontSize: 22,
      fontWeight: "800",
      letterSpacing: -0.5,
      padding: 0,
    },
    tagsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
    tagChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderRadius: theme.radiusFull,
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    tagDot: { width: 7, height: 7, borderRadius: 4 },
    tagName: { color: theme.text, fontSize: 12, fontWeight: "600" },
    addTagBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderStyle: "dashed",
      borderRadius: theme.radiusFull,
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    addTagText: { color: theme.textSecondary, fontSize: 12 },
    tagInputWrap: {
      borderWidth: 1,
      borderColor: theme.inputBorder,
      borderRadius: theme.radiusFull,
      paddingHorizontal: 10,
      minWidth: 80,
    },
    tagInput: { color: theme.text, fontSize: 12, height: 28, padding: 0 },

    editorWrap: { flex: 1 },
    webview: { flex: 1, backgroundColor: theme.bg },
  });