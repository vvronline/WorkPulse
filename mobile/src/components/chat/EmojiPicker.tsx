// Full emoji picker sheet (mobile) — opened from the reaction overlay ("react"
// mode) or the composer "+" menu ("compose" mode). Signal-style: ONE
// continuously-scrolling grid with sticky section headers (Recents first), a
// BOTTOM category strip whose active icon tracks scroll position, an inline
// search and a skin-tone selector. Mirrors the docked EmojiKeyboard layout.
//
// See docs/CHAT_DESIGN_SPEC.md §3.

import { useCallback, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type ViewToken,
} from "react-native";
import { Search as SearchIcon, X as XIcon } from "../../icons";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import EmojiImage from "../../emoji/EmojiImage";
import { CATEGORY_ORDER, SKIN_TONES } from "../../emoji/types";
import type { Emoji, EmojiCategory } from "../../emoji/types";
import {
  getRecentEmoji,
  getSkinTone,
  nativeForTone,
  recordRecent,
  searchEmoji,
  setSkinTone,
  variantForTone,
} from "../../emoji/emojiStore";
import { buildEmojiSections, type EmojiRow } from "./emojiSections";
import { useKeyboardInset } from "../../hooks/useKeyboardInset";

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
  const [searching, setSearching] = useState(false);
  const [tone, setTone] = useState(getSkinTone);
  const [toneOpen, setToneOpen] = useState(false);
  const [recents, setRecents] = useState<Emoji[]>(getRecentEmoji);
  const [activeCat, setActiveCat] = useState<EmojiCategory>("smileys");

  const { height: winH } = useWindowDimensions();
  const kbInset = useKeyboardInset();
  // Shrink the bottom sheet when the search field triggers the system keyboard
  // so results remain visible above it.
  const sheetHeight =
    kbInset > 100 ? Math.max(300, winH - kbInset - 40) : winH * 0.65;

  const listRef = useRef<SectionList<EmojiRow>>(null);

  const sections = useMemo(() => buildEmojiSections(COLS, recents), [recents]);
  const stripCats = useMemo(
    () => CATEGORY_ORDER.filter((c) => sections.some((s) => s.key === c.key)),
    [sections],
  );

  const searchRows: EmojiRow[] = useMemo(() => {
    if (!query.trim()) return [];
    const hits = searchEmoji(query);
    const rows: EmojiRow[] = [];
    for (let i = 0; i < hits.length; i += COLS) {
      rows.push({ items: hits.slice(i, i + COLS), key: `search-${i}` });
    }
    return rows;
  }, [query]);

  const handlePick = useCallback(
    (e: Emoji) => {
      recordRecent(e.id);
      setRecents(getRecentEmoji());
      onPick(nativeForTone(e, tone));
      onClose();
    },
    [onPick, onClose, tone],
  );

  const handleTone = (t: number) => {
    setTone(t);
    setSkinTone(t);
    setToneOpen(false);
  };

  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const first = viewableItems.find((v) => v.section);
      if (first?.section) {
        setActiveCat((first.section as { key: EmojiCategory }).key);
      }
    },
  ).current;

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current;

  const scrollToCat = (cat: EmojiCategory) => {
    const idx = sections.findIndex((s) => s.key === cat);
    if (idx < 0) return;
    setActiveCat(cat);
    try {
      listRef.current?.scrollToLocation({
        sectionIndex: idx,
        itemIndex: 0,
        viewOffset: 0,
        animated: false,
      });
    } catch {
      /* ignore */
    }
  };

  const renderRow = useCallback(
    ({ item }: { item: EmojiRow }) => (
      <View style={styles.row}>
        {item.items.map((e) => (
          <Pressable
            key={e.id}
            style={styles.cell}
            onPress={() => handlePick(e)}
          >
            <EmojiImage variant={variantForTone(e, tone)} size={36} />
          </Pressable>
        ))}
        {item.items.length < COLS
          ? Array.from({ length: COLS - item.items.length }).map((_, i) => (
              <View key={`pad-${i}`} style={styles.cell} />
            ))
          : null}
      </View>
    ),
    [handlePick, styles, tone],
  );

  if (!visible) return null;

  return (
    <View style={styles.overlay}>
      <Pressable style={styles.scrim} onPress={onClose} />
      <View style={[styles.sheet, { height: sheetHeight }]}>
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
              onChangeText={(v) => {
                setQuery(v);
                setSearching(v.trim().length > 0);
              }}
              autoCorrect={false}
            />
            {query.length > 0 ? (
              <Pressable
                onPress={() => {
                  setQuery("");
                  setSearching(false);
                }}
                hitSlop={8}
              >
                <XIcon size={15} color={theme.textMuted} />
              </Pressable>
            ) : null}
          </View>
          <Pressable
            style={styles.toneBtn}
            onPress={() => setToneOpen((v) => !v)}
          >
            <Text style={styles.toneText}>{SKIN_TONES[tone].swatch}</Text>
          </Pressable>
        </View>

        {toneOpen && (
          <View style={styles.tonePopup}>
            {SKIN_TONES.map((t) => (
              <Pressable
                key={t.key}
                style={[
                  styles.toneSwatch,
                  t.key === tone && styles.toneSwatchActive,
                ]}
                onPress={() => handleTone(t.key)}
              >
                <Text style={styles.toneText}>{t.swatch}</Text>
              </Pressable>
            ))}
          </View>
        )}

        {searching ? (
          searchRows.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No emoji found</Text>
            </View>
          ) : (
            <FlatList
              data={searchRows}
              keyExtractor={(r) => r.key}
              keyboardShouldPersistTaps="always"
              style={styles.gridList}
              contentContainerStyle={styles.grid}
              showsVerticalScrollIndicator={false}
              renderItem={renderRow}
            />
          )
        ) : (
          <SectionList
            ref={listRef}
            sections={sections}
            keyExtractor={(r) => r.key}
            keyboardShouldPersistTaps="always"
            stickySectionHeadersEnabled
            style={styles.gridList}
            contentContainerStyle={styles.grid}
            showsVerticalScrollIndicator={false}
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={viewabilityConfig}
            onScrollToIndexFailed={() => {}}
            renderSectionHeader={({ section }) => (
              <Text style={styles.sectionHeader}>{section.meta.label}</Text>
            )}
            renderItem={renderRow}
          />
        )}

        {!searching && (
          <View style={styles.bottomStrip}>
            <FlatList
              data={stripCats}
              horizontal
              keyExtractor={(c) => c.key}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.strip}
              renderItem={({ item }) => (
                <Pressable
                  style={[
                    styles.stripTab,
                    activeCat === item.key && styles.stripTabActive,
                  ]}
                  onPress={() => scrollToCat(item.key)}
                >
                  <Text style={styles.stripIcon}>{item.icon}</Text>
                </Pressable>
              )}
            />
          </View>
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
    searchInput: {
      flex: 1,
      color: theme.text,
      fontSize: 14,
      paddingVertical: 0,
    },
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
    gridList: { flex: 1 },
    grid: { paddingHorizontal: 8, paddingTop: 2, paddingBottom: 12 },
    sectionHeader: {
      fontSize: 12,
      fontWeight: "700",
      color: theme.textSecondary,
      backgroundColor: theme.bgElevated,
      paddingHorizontal: 6,
      paddingTop: 8,
      paddingBottom: 4,
      textTransform: "uppercase",
      letterSpacing: 0.4,
    },
    row: { flexDirection: "row" },
    cell: {
      flex: 1,
      maxWidth: `${100 / COLS}%`,
      aspectRatio: 1,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    empty: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 40,
    },
    emptyText: { color: theme.textMuted, fontSize: 13 },
    bottomStrip: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 6,
      paddingVertical: 4,
      borderTopWidth: 1,
      borderTopColor: theme.border,
      backgroundColor: theme.bgElevated,
    },
    strip: {
      gap: 2,
      alignItems: "center",
      flexGrow: 1,
      justifyContent: "space-between",
    },
    stripTab: {
      paddingHorizontal: 8,
      paddingVertical: 5,
      borderRadius: 8,
      opacity: 0.5,
    },
    stripTabActive: { opacity: 1, backgroundColor: theme.surface },
    stripIcon: { fontSize: 18 },
  });
