// In-app emoji keyboard (mobile) — the docked panel shown in place of the
// system keyboard when the composer's emoji toggle is active (Signal-style).
//
// Signal renders ONE continuously-scrolling grid with sticky section headers
// per category (Recents first), a BOTTOM category strip whose active icon
// tracks the scroll position (tap → scroll to section), an inline search, a
// skin-tone selector and a backspace key. This file mirrors that layout with a
// SectionList of chunked rows (see emojiSections.ts).
//
// See docs/CHAT_DESIGN_SPEC.md §2, §3.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Platform,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type ViewToken,
} from "react-native";
import { Delete, Search as SearchIcon, X as XIcon } from "../../icons";
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

export default function EmojiKeyboard({
  visible,
  height,
  onPick,
  onBackspace,
  onOpenGif,
  onOpenSticker,
  onSearchFocus,
  onSearchBlur,
}: {
  visible: boolean;
  height: number;
  onPick: (native: string) => void;
  onBackspace: () => void;
  onOpenGif: () => void;
  onOpenSticker: () => void;
  onSearchFocus?: () => void;
  onSearchBlur?: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const [query, setQuery] = useState("");
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [tone, setTone] = useState(getSkinTone);
  const [toneOpen, setToneOpen] = useState(false);
  const [recents, setRecents] = useState<Emoji[]>(getRecentEmoji);
  // Active category for the bottom strip highlight — driven by scroll position.
  const [activeCat, setActiveCat] = useState<EmojiCategory>("smileys");

  const listRef = useRef<SectionList<EmojiRow>>(null);
  const searchInputRef = useRef<TextInput>(null);

  const { height: winH } = useWindowDimensions();
  const ownKbInset = useKeyboardInset();
  // When the search field is focused the system keyboard appears on top of
  // this docked panel.  Shrink the effective height so results stay visible
  // above the keyboard and don't get clipped on small devices.
  const effectiveHeight =
    ownKbInset > 100
      ? Math.max(
          160,
          Math.min(
            height,
            winH - ownKbInset - (Platform.OS === "android" ? 60 : 50),
          ),
        )
      : height;

  const sections = useMemo(() => buildEmojiSections(COLS, recents), [recents]);
  // Only categories that actually have a section (for the bottom strip).
  const stripCats = useMemo(
    () => CATEGORY_ORDER.filter((c) => sections.some((s) => s.key === c.key)),
    [sections],
  );

  // Search results, chunked into rows so the grid layout matches.
  const searchRows: EmojiRow[] = useMemo(() => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return [];
    const hits = searchEmoji(trimmedQuery);
    const rows: EmojiRow[] = [];
    for (let i = 0; i < hits.length; i += COLS) {
      rows.push({ items: hits.slice(i, i + COLS), key: `search-${i}` });
    }
    return rows;
  }, [query]);
  const searching = query.trim().length > 0;

  useEffect(() => {
    if (!visible || !searchExpanded) return;
    const timer = setTimeout(() => searchInputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [searchExpanded, visible]);

  useEffect(() => {
    if (visible) return;
    searchInputRef.current?.blur();
    setSearchExpanded(false);
    setToneOpen(false);
    if (query.length > 0) setQuery("");
  }, [query, visible]);

  const handlePick = useCallback(
    (e: Emoji) => {
      recordRecent(e.id);
      setRecents(getRecentEmoji());
      onPick(nativeForTone(e, tone));
    },
    [onPick, tone],
  );

  const handleTone = (t: number) => {
    setTone(t);
    setSkinTone(t);
    setToneOpen(false);
  };

  // Update the active category highlight as the user scrolls.
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const first = viewableItems.find((v) => v.section);
      if (first?.section) {
        setActiveCat((first.section as { key: EmojiCategory }).key);
      }
    },
  ).current;

  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 10,
  }).current;

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
        {/* Pad the final short row so cells stay left-aligned. */}
        {item.items.length < COLS
          ? Array.from({ length: COLS - item.items.length }).map((_, i) => (
              <View key={`pad-${i}`} style={styles.cell} />
            ))
          : null}
      </View>
    ),
    [handlePick, styles, tone],
  );

  return (
    <View
      pointerEvents={visible ? "auto" : "none"}
      style={[
        styles.wrap,
        {
          height: visible ? effectiveHeight : 0,
          opacity: visible ? 1 : 0,
          borderTopWidth: visible ? 1 : 0,
        },
      ]}
    >
      {/* ── Fixed header (always mounted, never remounted) ── */}
      <View style={styles.topRowWrap}>
        <View style={styles.topRow}>
          {searchExpanded ? (
            <View style={styles.searchBox}>
              <SearchIcon size={15} color={theme.textMuted} />
              <TextInput
                ref={searchInputRef}
                style={styles.searchInput}
                placeholder="Search emoji"
                placeholderTextColor={theme.textMuted}
                value={query}
                onChangeText={setQuery}
                onFocus={onSearchFocus}
                onBlur={onSearchBlur}
                autoCorrect={false}
                returnKeyType="search"
              />
              <Pressable
                onPress={() => {
                  setQuery("");
                  setSearchExpanded(false);
                  searchInputRef.current?.blur();
                }}
                hitSlop={8}
              >
                <XIcon size={14} color={theme.textMuted} />
              </Pressable>
            </View>
          ) : (
            <Pressable
              style={styles.iconBtn}
              onPress={() => setSearchExpanded(true)}
              hitSlop={8}
            >
              <SearchIcon size={17} color={theme.textSecondary} />
            </Pressable>
          )}
          <Pressable style={styles.mediaBtn} onPress={onOpenGif}>
            <Text style={styles.mediaBtnText}>GIF</Text>
          </Pressable>
          <Pressable style={styles.mediaBtn} onPress={onOpenSticker}>
            <Text style={styles.mediaBtnText}>Sticker</Text>
          </Pressable>
          <Pressable
            style={styles.toneBtn}
            onPress={() => setToneOpen((v) => !v)}
          >
            <Text style={styles.toneText}>{SKIN_TONES[tone].swatch}</Text>
          </Pressable>
        </View>
      </View>

      {/* ── Emoji grid ── */}
      {searching ? (
        <FlatList
          data={searchRows}
          keyExtractor={(r) => r.key}
          keyboardShouldPersistTaps="always"
          style={styles.gridList}
          contentContainerStyle={styles.grid}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No emoji found</Text>
            </View>
          }
          renderItem={renderRow}
        />
      ) : (
        <SectionList
          ref={listRef}
          sections={sections}
          keyExtractor={(r) => r.key}
          keyboardShouldPersistTaps="always"
          stickySectionHeadersEnabled={false}
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

      {/* ── Bottom category strip + backspace ── */}
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
          <Pressable style={styles.backspace} onPress={onBackspace} hitSlop={8}>
            <Delete size={20} color={theme.textSecondary} />
          </Pressable>
        </View>
      )}

      {/* ── Floating skin-tone popup ── */}
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
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    wrap: {
      backgroundColor: theme.bgSecondary,
      borderTopWidth: 1,
      borderTopColor: theme.border,
      // Don't clip the absolutely-positioned skin-tone popup that floats above
      // the emoji grid (rendered as a sibling of the scroll list).
      overflow: "visible",
    },
    // Wrapper around the search + skin-tone row when it lives inside the
    // scrolling list header. `position: relative` anchors the skin-tone popup;
    // `zIndex` keeps the popup above the emoji rows below it.
    topRowWrap: {
      position: "relative",
      zIndex: 10,
      backgroundColor: theme.bgSecondary,
    },
    topRow: {
      flexDirection: "row",
      alignItems: "center",
      minWidth: 0,
      gap: 6,
      paddingHorizontal: 8,
      paddingTop: 6,
      paddingBottom: 5,
    },
    iconBtn: {
      width: 34,
      height: 34,
      borderRadius: 17,
      borderWidth: 1,
      borderColor: theme.inputBorder,
      backgroundColor: theme.inputBg,
      alignItems: "center",
      justifyContent: "center",
    },
    mediaBtn: {
      height: 34,
      paddingHorizontal: 10,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.inputBorder,
    },
    mediaBtnText: {
      color: theme.textSecondary,
      fontSize: 11,
      fontWeight: "600",
    },
    searchBox: {
      flex: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      backgroundColor: theme.inputBg,
      borderWidth: 1,
      borderColor: theme.inputBorder,
      borderRadius: 17,
      paddingHorizontal: 10,
      height: 34,
    },
    searchInput: {
      flex: 1,
      color: theme.text,
      fontSize: 13,
      paddingVertical: 0,
    },
    toneBtn: {
      width: 34,
      height: 34,
      borderRadius: 17,
      borderWidth: 1,
      borderColor: theme.inputBorder,
      backgroundColor: theme.inputBg,
      alignItems: "center",
      justifyContent: "center",
    },
    toneText: { fontSize: 17 },
    tonePopup: {
      position: "absolute",
      top: 44,
      right: 8,
      // zIndex (iOS/web) + elevation (Android) so the popup paints ABOVE the
      // emoji grid sibling instead of being covered/clipped by it.
      zIndex: 50,
      elevation: 12,
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
    // The grid must flex to fill the space between the search row and the bottom
    // category strip so its last row isn't clipped under the strip.
    gridList: { flex: 1 },
    grid: { paddingHorizontal: 6, paddingTop: 2, paddingBottom: 12 },
    sectionHeader: {
      fontSize: 12,
      fontWeight: "700",
      color: theme.textSecondary,
      backgroundColor: theme.bgSecondary,
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
    empty: { flex: 1, alignItems: "center", justifyContent: "center" },
    emptyText: { color: theme.textMuted, fontSize: 13 },
    // Bottom category strip — the active icon tracks scroll position; a
    // backspace key is pinned at the right edge (Signal-style).
    bottomStrip: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 4,
      paddingVertical: 3,
      borderTopWidth: 1,
      borderTopColor: theme.border,
      backgroundColor: theme.bgSecondary,
    },
    strip: { gap: 1, alignItems: "center", flexGrow: 1 },
    stripTab: {
      paddingHorizontal: 7,
      paddingVertical: 4,
      borderRadius: 7,
      opacity: 0.56,
    },
    stripTabActive: { opacity: 1, backgroundColor: theme.inputBg },
    stripIcon: { fontSize: 17 },
    backspace: {
      width: 40,
      height: 30,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 7,
      backgroundColor: theme.surface,
      marginLeft: 3,
    },
  });
