import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Search, X } from "../../icons";
import { api } from "../../api";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";

type TenorKind = "gif" | "sticker";
type TenorItem = { id: string; previewUrl: string; mediaUrl: string };

export default function TenorMediaPicker({
  visible,
  kind,
  onClose,
  onPick,
}: {
  visible: boolean;
  kind: TenorKind;
  onClose: () => void;
  onPick: (item: TenorItem) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<TenorItem[]>([]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const q = query.trim();
    const type = kind === "sticker" ? "stickers" : "gifs";
    setLoading(true);
    // GIF/Sticker search is proxied through our server (GIPHY key stays
    // server-side). Empty query falls back to trending on the server.
    api
      .get<{ results: TenorItem[] }>("/giphy/search", { params: { q, type } })
      .then((res) => {
        if (!cancelled) setItems(res.data?.results || []);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, query, visible]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.scrim} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{kind === "gif" ? "GIF Picker" : "Sticker Picker"}</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <X size={20} color={theme.textSecondary} />
            </Pressable>
          </View>
          <View style={styles.searchRow}>
            <Search size={16} color={theme.textMuted} />
            <TextInput
              style={styles.searchInput}
              placeholder={kind === "gif" ? "Search GIFs" : "Search stickers"}
              placeholderTextColor={theme.textMuted}
              value={query}
              onChangeText={setQuery}
              autoCorrect={false}
            />
          </View>

          {loading ? (
            <View style={styles.center}>
              <ActivityIndicator size="small" color={theme.primary} />
            </View>
          ) : (
            <FlatList
              data={items}
              keyExtractor={(i) => i.id}
              numColumns={2}
              contentContainerStyle={styles.grid}
              columnWrapperStyle={styles.row}
              renderItem={({ item }) => (
                <Pressable style={styles.card} onPress={() => onPick(item)}>
                  <Image source={{ uri: item.previewUrl }} style={styles.image} resizeMode="cover" />
                </Pressable>
              )}
              ListEmptyComponent={
                <View style={styles.center}>
                  <Text style={styles.emptyText}>No results found.</Text>
                </View>
              }
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    overlay: { flex: 1, justifyContent: "flex-end" },
    scrim: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(0,0,0,0.55)" },
    sheet: {
      backgroundColor: theme.bgElevated,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      maxHeight: "76%",
      paddingBottom: 16,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 14,
      paddingTop: 12,
      paddingBottom: 8,
    },
    title: { color: theme.text, fontSize: 16, fontWeight: "700" },
    searchRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginHorizontal: 12,
      marginBottom: 8,
      paddingHorizontal: 12,
      height: 38,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: theme.inputBorder,
      backgroundColor: theme.inputBg,
    },
    searchInput: { flex: 1, color: theme.text, fontSize: 14, paddingVertical: 0 },
    grid: { paddingHorizontal: 10, paddingBottom: 8 },
    row: { gap: 8 },
    card: {
      flex: 1,
      borderRadius: 10,
      overflow: "hidden",
      borderWidth: 1,
      borderColor: theme.glassBorder,
      backgroundColor: theme.surface,
      marginBottom: 8,
    },
    image: { width: "100%", aspectRatio: 1 },
    center: { paddingVertical: 24, alignItems: "center", justifyContent: "center" },
    emptyText: { color: theme.textMuted, fontSize: 13 },
  });
