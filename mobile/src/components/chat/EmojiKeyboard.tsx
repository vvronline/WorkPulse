// In-app emoji keyboard (mobile) — the docked panel shown in place of the
// system keyboard when the composer's emoji toggle is active (Signal-style).
// Categories, search, recents, skin-tone selection + a backspace key. Renders
// the bundled image emoji set with native-glyph fallback.
//
// See docs/CHAT_DESIGN_SPEC.md §2, §3.

import { useMemo, useState } from "react";
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Delete, Search as SearchIcon } from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import EmojiImage from "../../emoji/EmojiImage";
import { CATEGORY_ORDER, SKIN_TONES } from "../../emoji/types";
import type { Emoji, EmojiCategory } from "../../emoji/types";
import {
  emojiByCategory,
  getRecentEmoji,
  getSkinTone,
  nativeForTone,
  recordRecent,
  searchEmoji,
  setSkinTone,
  variantForTone,
} from "../../emoji/emojiStore";

const COLS = 8;

export default function EmojiKeyboard({
  height,
  onPick,
  onBackspace,
}: {
  height: number;
  onPick: (native: string) => void;
  onBackspace: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<EmojiCategory>("smileys");
  const [tone, setTone] = useState(getSkinTone);
  const [toneOpen, setToneOpen] = useState(false);
  const [recents, setRecents] = useState<Emoji[]>(getRecentEmoji);

  const sections = useMemo(
    () => CATEGORY_ORDER.filter((c) => (c.key === "recent" ? recents.length > 0 : true)),
    [recents]
  );

  const data: Emoji[] = useMemo(() => {
    if (query.trim()) return searchEmoji(query);
    if (cat === "recent") return recents;
    return emojiByCategory(cat);
  }, [query, cat, recents]);

  const handlePick = (e: Emoji) => {
    recordRecent(e.id);
    setRecents(getRecentEmoji());
    onPick(nativeForTone(e, tone));
  };

  const handleTone = (t: number) => {
    setTone(t);
    setSkinTone(t);
    setToneOpen(false);
  };

  return (
    <View style={[styles.wrap, { height }]}>
      {/* Search + skin-tone */}
      <View style={styles.topRow}>
        <View style={styles.searchBox}>
          <SearchIcon size={16} color={theme.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search emoji"
            placeholderTextColor={theme.textMuted}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
          />
        </View>
        <Pressable style={styles.toneBtn} onPress={() => setToneOpen((v) => !v)}>
          <Text style={styles.toneText}>{SKIN_TONES[tone].swatch}</Text>
        </Pressable>
      </View>

      {toneOpen && (
        <View style={styles.tonePopup}>
          {SKIN_TONES.map((t) => (
            <Pressable
              key={t.key}
              style={[styles.toneSwatch, t.key === tone && styles.toneSwatchActive]}
              onPress={() => handleTone(t.key)}
            >
              <Text style={styles.toneText}>{t.swatch}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {/* Category tabs (hidden while searching) */}
      {!query.trim() && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabs}
        >
          {sections.map((c) => (
            <Pressable
              key={c.key}
              style={[styles.tab, cat === c.key && styles.tabActive]}
              onPress={() => setCat(c.key)}
            >
              <Text style={styles.tabIcon}>{c.icon}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {/* Grid */}
      {data.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No emoji found</Text>
        </View>
      ) : (
        <FlatList
          data={data}
          key={query.trim() ? "search" : cat}
          keyExtractor={(e) => e.id}
          numColumns={COLS}
          keyboardShouldPersistTaps="always"
          style={styles.gridList}
          contentContainerStyle={styles.grid}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => (
            <Pressable style={styles.cell} onPress={() => handlePick(item)}>
              <EmojiImage variant={variantForTone(item, tone)} size={28} />
            </Pressable>
          )}
        />
      )}

      {/* Backspace key */}
      <View style={styles.bottomRow}>
        <Pressable style={styles.backspace} onPress={onBackspace} hitSlop={8}>
          <Delete size={20} color={theme.textSecondary} />
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    wrap: {
      backgroundColor: theme.bgSecondary,
      borderTopWidth: 1,
      borderTopColor: theme.border,
    },
    topRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 10,
      paddingTop: 8,
      paddingBottom: 4,
    },
    searchBox: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: theme.inputBg,
      borderWidth: 1,
      borderColor: theme.inputBorder,
      borderRadius: 18,
      paddingHorizontal: 12,
      height: 36,
    },
    searchInput: { flex: 1, color: theme.text, fontSize: 14, paddingVertical: 0 },
    toneBtn: {
      width: 36,
      height: 36,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.inputBorder,
      backgroundColor: theme.inputBg,
      alignItems: "center",
      justifyContent: "center",
    },
    toneText: { fontSize: 18 },
    tonePopup: {
      position: "absolute",
      top: 48,
      right: 10,
      zIndex: 10,
      flexDirection: "row",
      gap: 2,
      padding: 4,
      backgroundColor: theme.bgElevated,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: 10,
    },
    toneSwatch: {
      width: 34,
      height: 34,
      borderRadius: 6,
      alignItems: "center",
      justifyContent: "center",
    },
    toneSwatchActive: { backgroundColor: theme.primary },
    tabs: { gap: 2, paddingHorizontal: 8, paddingBottom: 4 },
    tab: {
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 6,
      opacity: 0.5,
    },
    tabActive: { opacity: 1, backgroundColor: theme.surface },
    tabIcon: { fontSize: 18 },
    // The grid must flex to fill the space between the tabs and the backspace
    // bar so its last row (e.g. Recents) isn't clipped under the backspace row.
    gridList: { flex: 1 },
    grid: { paddingHorizontal: 6, paddingTop: 4, paddingBottom: 12 },
    cell: {
      flex: 1,
      maxWidth: `${100 / COLS}%`,
      aspectRatio: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    empty: { flex: 1, alignItems: "center", justifyContent: "center" },
    emptyText: { color: theme.textMuted, fontSize: 13 },
    bottomRow: {
      flexDirection: "row",
      justifyContent: "flex-end",
      paddingHorizontal: 14,
      paddingVertical: 6,
      borderTopWidth: 1,
      borderTopColor: theme.border,
    },
    backspace: {
      width: 44,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 8,
      backgroundColor: theme.surface,
    },
  });