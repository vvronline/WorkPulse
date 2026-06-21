// Full emoji picker sheet (mobile) — opened from the reaction bar ("react"
// mode) or the composer "+" menu ("compose" mode). Upgraded to Signal-style
// parity: category tabs, search, recents, skin-tone selection, bundled image
// emoji (native fallback). Mirrors the web EmojiGifPicker.
//
// See docs/CHAT_DESIGN_SPEC.md §3.

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
import { Search as SearchIcon, X as XIcon } from "lucide-react-native";
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

export default function EmojiPicker({
  visible,
  mode,
  onPick,
  onClose,
}: {
  visible: boolean;
  mode: "react" | "compose";
  onPick: (emoji: string) => void;
  onClose: () => void;
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

  if (!visible) return null;

  const handlePick = (e: Emoji) => {
    recordRecent(e.id);
    setRecents(getRecentEmoji());
    onPick(nativeForTone(e, tone));
    onClose();
  };

  const handleTone = (t: number) => {
    setTone(t);
    setSkinTone(t);
    setToneOpen(false);
  };

  return (
    <View style={styles.overlay}>
      <Pressable style={styles.scrim} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.header}>
          <Text style={styles.title}>
            {mode === "compose" ? "Insert emoji" : "Pick a reaction"}
          </Text>
          <Pressable onPress={onClose} hitSlop={8}>
            <XIcon size={22} color={theme.textSecondary} />
          </Pressable>
        </View>

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
            contentContainerStyle={styles.grid}
            renderItem={({ item }) => (
              <Pressable style={styles.cell} onPress={() => handlePick(item)}>
                <EmojiImage variant={variantForTone(item, tone)} size={28} />
              </Pressable>
            )}
          />
        )}
      </View>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    overlay: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      justifyContent: "flex-end",
    },
    scrim: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: "rgba(0,0,0,0.6)",
    },
    sheet: {
      backgroundColor: theme.bgElevated,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingBottom: 24,
      maxHeight: "65%",
    },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingTop: 14,
      paddingBottom: 6,
    },
    title: { fontSize: 16, fontWeight: "700", color: theme.text },
    topRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
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
      top: 96,
      right: 12,
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
    tabs: { gap: 2, paddingHorizontal: 10, paddingBottom: 4 },
    tab: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, opacity: 0.5 },
    tabActive: { opacity: 1, backgroundColor: theme.surface },
    tabIcon: { fontSize: 18 },
    grid: { paddingHorizontal: 8, paddingBottom: 12 },
    cell: {
      flex: 1,
      maxWidth: `${100 / COLS}%`,
      aspectRatio: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    empty: { paddingVertical: 40, alignItems: "center" },
    emptyText: { color: theme.textMuted, fontSize: 13 },
  });