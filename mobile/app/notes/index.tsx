import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import {
  Archive,
  ArrowUpRight,
  CheckSquare,
  Clock,
  FileText,
  FolderPlus,
  Heart,
  Pin,
  Plus,
  Search,
  StickyNote,
  Tag,
  X,
} from "../../src/icons";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { useAuth } from "../../src/auth/AuthContext";
import { useNotes } from "../../src/notes/NotesContext";
import { TEMPLATES } from "../../src/notes/templates";
import {
  buildFolderTree,
  relativeFromNow,
  snippetOf,
  tagColor,
} from "../../src/notes/notesUtils";

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  if (h < 22) return "Good evening";
  return "Good night";
}

function todayLong(): string {
  return new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export default function NotesHomeScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const { user } = useAuth();
  const store = useNotes();

  const {
    loading,
    pages,
    folders,
    handleNewPage,
    handleNewFromTemplate,
    handleOpenTodayJournal,
    handleNewFolder,
    setSearchQuery,
    setFolderFilter,
    setShowArchived,
  } = store;

  const [search, setSearch] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [folderInput, setFolderInput] = useState(false);

  const activePages = useMemo(() => pages.filter((p) => !p.archived), [pages]);

  const pinned = useMemo(
    () => activePages.filter((p) => p.pinned).slice(0, 6),
    [activePages],
  );

  const liked = useMemo(() => {
    const uid = user?.id;
    if (!uid) return [];
    return activePages
      .filter((p) => {
        const reactions = p.reactions || {};
        return Object.values(reactions).some(
          (list) => Array.isArray(list) && (list as unknown[]).includes(uid),
        );
      })
      .sort(
        (a, b) =>
          new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime(),
      )
      .slice(0, 8);
  }, [activePages, user]);

  const recent = useMemo(
    () =>
      [...activePages]
        .sort(
          (a, b) =>
            new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime(),
        )
        .slice(0, 9),
    [activePages],
  );

  const lastEdited = recent[0] || null;
  const otherRecent = recent.slice(1, 7);

  const folderNameById = useMemo(() => {
    const map: Record<string, string> = {};
    folders.forEach((f) => {
      map[f.id] = f.name;
    });
    return map;
  }, [folders]);

  const folderTree = useMemo(() => buildFolderTree(folders), [folders]);

  const pagesByFolder = useMemo(() => {
    const map: Record<string, number> = {};
    activePages.forEach((p) => {
      if (p.folderId) map[p.folderId] = (map[p.folderId] || 0) + 1;
    });
    return map;
  }, [activePages]);

  const tagCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    activePages.forEach((p) =>
      (p.tags || []).forEach((t) => {
        counts[t] = (counts[t] || 0) + 1;
      }),
    );
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 14);
  }, [activePages]);

  const liveMatches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return activePages
      .filter((p) => (p.title || "").toLowerCase().includes(q))
      .slice(0, 5);
  }, [search, activePages]);

  const isEmpty = activePages.length === 0;
  const fullName = user?.full_name || user?.username || "there";
  const firstName = fullName.split(" ")[0];

  const openEditor = (id: string) => {
    store.setActivePageId(id);
    router.push(`/notes/${id}`);
  };

  const createAndOpen = (id: string) => {
    router.push(`/notes/${id}`);
  };

  const onSearchSubmit = () => {
    const q = search.trim();
    if (!q) return;
    setSearchQuery(q);
    setSearch("");
  };

  const onTagClick = (tag: string) => {
    setSearchQuery(`#${tag}`);
    setFolderFilter("all");
  };

  const submitFolder = () => {
    const name = newFolderName.trim();
    if (name) handleNewFolder(null, name);
    setNewFolderName("");
    setFolderInput(false);
  };

  const goArchive = () => {
    setShowArchived(true);
    setFolderFilter("all");
    // Archive list is shown via the dedicated list below; keep simple.
    Alert.alert("Archive", "Showing archived notes is filtered in the list below.");
  };

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Notes" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: "Notes" }} />

      {/* ── Header ── */}
      <View style={styles.headerBlock}>
        <Text style={styles.date}>{todayLong()}</Text>
        <Text style={styles.greeting}>
          {getGreeting()}, <Text style={styles.name}>{firstName}</Text>
        </Text>
        <Text style={styles.meta}>
          {activePages.length} {activePages.length === 1 ? "note" : "notes"}
          {folders.length > 0
            ? `  •  ${folders.length} ${folders.length === 1 ? "folder" : "folders"}`
            : ""}
        </Text>
      </View>

      {/* ── Search ── */}
      <View style={styles.searchBar}>
        <Search size={18} color={theme.textMuted} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search notes, folders, tags…"
          placeholderTextColor={theme.textMuted}
          value={search}
          onChangeText={setSearch}
          onSubmitEditing={onSearchSubmit}
          returnKeyType="search"
        />
        {search.length > 0 && (
          <Pressable onPress={() => setSearch("")} hitSlop={8}>
            <X size={16} color={theme.textMuted} />
          </Pressable>
        )}
      </View>

      {/* live search results */}
      {search.trim().length > 0 && (
        <View style={styles.searchResults}>
          {liveMatches.length === 0 ? (
            <Pressable
              style={styles.searchRow}
              onPress={() => {
                const id = handleNewPage(null, search.trim());
                setSearch("");
                createAndOpen(id);
              }}
            >
              <Plus size={15} color={theme.primary} />
              <Text style={styles.searchRowText}>
                Create note "{search.trim()}"
              </Text>
            </Pressable>
          ) : (
            liveMatches.map((p) => (
              <Pressable
                key={p.id}
                style={styles.searchRow}
                onPress={() => {
                  setSearch("");
                  openEditor(p.id);
                }}
              >
                {p.pinned ? (
                  <Pin size={15} color={theme.textSecondary} />
                ) : (
                  <FileText size={15} color={theme.textSecondary} />
                )}
                <Text style={styles.searchRowText} numberOfLines={1}>
                  {p.title || "Untitled"}
                </Text>
                <Text style={styles.searchRowMeta}>{relativeFromNow(p.updatedAt)}</Text>
              </Pressable>
            ))
          )}
        </View>
      )}

      {/* ── Quick actions ── */}
      <View style={styles.quickRow}>
        <Pressable
          style={styles.primaryBtn}
          onPress={() => {
            const id = handleNewPage();
            createAndOpen(id);
          }}
        >
          <Plus size={16} color={theme.onAccent} />
          <Text style={styles.primaryBtnText}>New note</Text>
        </Pressable>
        <Pressable style={styles.secondaryBtn} onPress={() => router.push("/notes/todo")}>
          <CheckSquare size={16} color={theme.textSecondary} />
          <Text style={styles.secondaryBtnText}>To-do</Text>
        </Pressable>
        <Pressable style={styles.secondaryBtn} onPress={goArchive}>
          <Archive size={16} color={theme.textSecondary} />
          <Text style={styles.secondaryBtnText}>Archive</Text>
        </Pressable>
      </View>

      {/* ── Empty state ── */}
      {isEmpty ? (
        <View style={styles.empty}>
          <StickyNote size={44} color={theme.textMuted} strokeWidth={1.5} />
          <Text style={styles.emptyTitle}>No notes yet</Text>
          <Text style={styles.emptySub}>
            Create your first note, or start from a template below.
          </Text>
        </View>
      ) : (
        <>
          {/* ── Jump back in ── */}
          {lastEdited && (
            <View style={styles.section}>
              <View style={styles.sectionHead}>
                <Clock size={15} color={theme.textSecondary} />
                <Text style={styles.sectionTitle}>Jump back in</Text>
              </View>
              <Pressable style={styles.resumeCard} onPress={() => openEditor(lastEdited.id)}>
                <View style={styles.resumeIcon}>
                  <Text style={styles.resumeEmoji}>
                    {lastEdited.icon || "📄"}
                  </Text>
                </View>
                <View style={styles.resumeBody}>
                  <Text style={styles.resumeTitle} numberOfLines={1}>
                    {lastEdited.title || "Untitled"}
                  </Text>
                  <Text style={styles.resumeMeta} numberOfLines={1}>
                    Edited {relativeFromNow(lastEdited.updatedAt)}
                    {lastEdited.folderId && folderNameById[lastEdited.folderId]
                      ? ` • in ${folderNameById[lastEdited.folderId]}`
                      : ""}
                  </Text>
                </View>
                <ArrowUpRight size={20} color={theme.textMuted} />
              </Pressable>
            </View>
          )}

          {/* ── Recent ── */}
          {otherRecent.length > 0 && (
            <View style={styles.section}>
              <View style={styles.sectionHead}>
                <FileText size={15} color={theme.textSecondary} />
                <Text style={styles.sectionTitle}>Recent notes</Text>
              </View>
              <View style={styles.card}>
                {otherRecent.map((p, i) => (
                  <Pressable
                    key={p.id}
                    style={[styles.listRow, i < otherRecent.length - 1 && styles.rowBorder]}
                    onPress={() => openEditor(p.id)}
                  >
                    <Text style={styles.rowEmoji}>{p.icon || "📄"}</Text>
                    <View style={styles.rowMain}>
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {p.title || "Untitled"}
                      </Text>
                      {snippetOf(p.content, 60) ? (
                        <Text style={styles.rowSnippet} numberOfLines={1}>
                          {snippetOf(p.content, 60)}
                        </Text>
                      ) : null}
                    </View>
                    <Text style={styles.rowMeta}>{relativeFromNow(p.updatedAt)}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}

          {/* ── Pinned ── */}
          {pinned.length > 0 && (
            <View style={styles.section}>
              <View style={styles.sectionHead}>
                <Pin size={15} color={theme.textSecondary} />
                <Text style={styles.sectionTitle}>Pinned</Text>
              </View>
              <View style={styles.card}>
                {pinned.map((p, i) => (
                  <Pressable
                    key={p.id}
                    style={[styles.listRow, i < pinned.length - 1 && styles.rowBorder]}
                    onPress={() => openEditor(p.id)}
                  >
                    <View
                      style={[
                        styles.pinAccent,
                        {
                          backgroundColor: p.tags?.[0]
                            ? tagColor(p.tags[0])
                            : theme.primary,
                        },
                      ]}
                    />
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {p.title || "Untitled"}
                    </Text>
                    <Text style={styles.rowMeta}>{relativeFromNow(p.updatedAt)}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}

          {/* ── Liked ── */}
          {liked.length > 0 && (
            <View style={styles.section}>
              <View style={styles.sectionHead}>
                <Heart size={15} color={theme.textSecondary} />
                <Text style={styles.sectionTitle}>Liked</Text>
              </View>
              <View style={styles.card}>
                {liked.map((p, i) => (
                  <Pressable
                    key={p.id}
                    style={[styles.listRow, i < liked.length - 1 && styles.rowBorder]}
                    onPress={() => openEditor(p.id)}
                  >
                    <Text style={styles.rowEmoji}>{p.icon || "📄"}</Text>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {p.title || "Untitled"}
                    </Text>
                    <Heart size={13} color={theme.danger} />
                  </Pressable>
                ))}
              </View>
            </View>
          )}
        </>
      )}

      {/* ── Folders ── */}
      <View style={styles.section}>
        <View style={styles.sectionHead}>
          <FolderPlus size={15} color={theme.textSecondary} />
          <Text style={styles.sectionTitle}>Folders &amp; notebooks</Text>
          <View style={{ flex: 1 }} />
          {!folderInput && (
            <Pressable onPress={() => setFolderInput(true)} hitSlop={8}>
              <Plus size={16} color={theme.primary} />
            </Pressable>
          )}
        </View>
        {folderInput && (
          <View style={styles.folderInputRow}>
            <TextInput
              style={styles.folderInput}
              placeholder="Notebook name…"
              placeholderTextColor={theme.textMuted}
              value={newFolderName}
              onChangeText={setNewFolderName}
              onSubmitEditing={submitFolder}
              autoFocus
              returnKeyType="done"
            />
            <Pressable onPress={submitFolder} hitSlop={8}>
              <Plus size={18} color={theme.primary} />
            </Pressable>
            <Pressable
              onPress={() => {
                setNewFolderName("");
                setFolderInput(false);
              }}
              hitSlop={8}
            >
              <X size={18} color={theme.textMuted} />
            </Pressable>
          </View>
        )}
        {folderTree.length === 0 && !folderInput ? (
          <Text style={styles.dim}>No folders yet. Tap + to create a notebook.</Text>
        ) : (
          <View style={styles.card}>
            {folderTree.map((f, i) => (
              <Pressable
                key={f.id}
                style={[styles.listRow, i < folderTree.length - 1 && styles.rowBorder]}
                onPress={() => {
                  setFolderFilter(f.id);
                  setSearchQuery("");
                }}
              >
                <Text style={[styles.rowEmoji, { marginLeft: f.depth * 14 }]}>📁</Text>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {f.name}
                </Text>
                <Text style={styles.rowMeta}>{pagesByFolder[f.id] || 0}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>

      {/* ── Templates ── */}
      <View style={styles.section}>
        <View style={styles.sectionHead}>
          <Plus size={15} color={theme.textSecondary} />
          <Text style={styles.sectionTitle}>Start from a template</Text>
        </View>
        <View style={styles.templateGrid}>
          {TEMPLATES.map((tpl) => {
            const Icon = tpl.icon;
            return (
              <Pressable
                key={tpl.id}
                style={styles.templateTile}
                onPress={() => {
                  if (tpl.id === "journal") {
                    void handleOpenTodayJournal().then((id) => createAndOpen(id));
                  } else if (tpl.id === "blank") {
                    const id = handleNewPage();
                    createAndOpen(id);
                  } else {
                    const id = handleNewFromTemplate(tpl.id);
                    createAndOpen(id);
                  }
                }}
              >
                <Icon size={18} color={theme.primary} />
                <Text style={styles.templateName}>{tpl.name}</Text>
                <Text style={styles.templateDesc} numberOfLines={2}>
                  {tpl.description}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* ── Tags ── */}
      {tagCounts.length > 0 && (
        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Tag size={15} color={theme.textSecondary} />
            <Text style={styles.sectionTitle}>Tags</Text>
          </View>
          <View style={styles.tagCloud}>
            {tagCounts.map(([tag, count]) => (
              <Pressable
                key={tag}
                style={styles.tagChip}
                onPress={() => onTagClick(tag)}
              >
                <View style={[styles.tagDot, { backgroundColor: tagColor(tag) }]} />
                <Text style={styles.tagName}>#{tag}</Text>
                <Text style={styles.tagCount}>{count}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.bg },
    container: { padding: 16, gap: 16 },
    center: { alignItems: "center", justifyContent: "center" },

    headerBlock: { gap: 2 },
    date: { color: theme.textMuted, fontSize: 12, fontWeight: "600" },
    greeting: { color: theme.text, fontSize: 24, fontWeight: "800", letterSpacing: -0.5 },
    name: { color: theme.primary },
    meta: { color: theme.textSecondary, fontSize: 13, marginTop: 2 },

    searchBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: theme.inputBg,
      borderWidth: 1,
      borderColor: theme.inputBorder,
      borderRadius: theme.radius,
      paddingHorizontal: 12,
      height: 44,
    },
    searchInput: { flex: 1, color: theme.text, fontSize: 15 },
    searchResults: {
      backgroundColor: theme.bgElevated,
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: theme.radius,
      overflow: "hidden",
      marginTop: -8,
    },
    searchRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 12,
      paddingVertical: 12,
    },
    searchRowText: { flex: 1, color: theme.text, fontSize: 14 },
    searchRowMeta: { color: theme.textMuted, fontSize: 11 },

    quickRow: { flexDirection: "row", gap: 10 },
    primaryBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: theme.primary,
      paddingHorizontal: 16,
      height: 42,
      borderRadius: theme.radius,
    },
    primaryBtnText: { color: theme.onAccent, fontWeight: "700", fontSize: 14 },
    secondaryBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      paddingHorizontal: 14,
      height: 42,
      borderRadius: theme.radius,
    },
    secondaryBtnText: { color: theme.textSecondary, fontWeight: "600", fontSize: 14 },

    empty: { alignItems: "center", gap: 8, paddingVertical: 40 },
    emptyTitle: { color: theme.text, fontSize: 18, fontWeight: "700" },
    emptySub: { color: theme.textSecondary, fontSize: 13, textAlign: "center" },

    section: { gap: 10 },
    sectionHead: { flexDirection: "row", alignItems: "center", gap: 6 },
    sectionTitle: { color: theme.text, fontSize: 15, fontWeight: "700" },

    resumeCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radiusLg,
      padding: 14,
    },
    resumeIcon: {
      width: 40,
      height: 40,
      borderRadius: 10,
      backgroundColor: theme.surface,
      alignItems: "center",
      justifyContent: "center",
    },
    resumeEmoji: { fontSize: 20 },
    resumeBody: { flex: 1 },
    resumeTitle: { color: theme.text, fontSize: 15, fontWeight: "700" },
    resumeMeta: { color: theme.textMuted, fontSize: 12, marginTop: 2 },

    card: {
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radiusLg,
      overflow: "hidden",
    },
    listRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    rowBorder: { borderBottomWidth: 1, borderBottomColor: theme.border },
    rowEmoji: { fontSize: 16, width: 22, textAlign: "center" },
    rowMain: { flex: 1 },
    rowTitle: { flex: 1, color: theme.text, fontSize: 14, fontWeight: "500" },
    rowSnippet: { color: theme.textMuted, fontSize: 12, marginTop: 1 },
    rowMeta: { color: theme.textMuted, fontSize: 11 },
    pinAccent: { width: 3, height: 20, borderRadius: 2 },

    folderInputRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    folderInput: {
      flex: 1,
      backgroundColor: theme.inputBg,
      borderWidth: 1,
      borderColor: theme.inputBorder,
      borderRadius: theme.radius,
      paddingHorizontal: 12,
      height: 42,
      color: theme.text,
    },
    dim: { color: theme.textMuted, fontSize: 13 },

    templateGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    templateTile: {
      width: "47.5%",
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radiusLg,
      padding: 14,
      gap: 6,
    },
    templateName: { color: theme.text, fontSize: 14, fontWeight: "700" },
    templateDesc: { color: theme.textMuted, fontSize: 12 },

    tagCloud: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    tagChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radiusFull,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    tagDot: { width: 8, height: 8, borderRadius: 4 },
    tagName: { color: theme.text, fontSize: 12, fontWeight: "600" },
    tagCount: { color: theme.textMuted, fontSize: 11 },
  });