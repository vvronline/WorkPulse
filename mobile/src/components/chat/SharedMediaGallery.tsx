import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { FileText, LinkIcon, Play } from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import { uploadUrl } from "../../config";
import {
  getMessages,
  getSharedFiles,
  type ChatMessage,
  type SharedFile,
} from "../../features";
import { AuthedImage } from "../AuthedImage";
import { extractFirstUrl, fmtDateTime, fmtSize } from "./chatUtils";
import { openAuthedFile } from "./openAuthedFile";
import MediaViewerPager, { type ViewerMediaItem } from "./MediaViewerPager";

type Tab = "media" | "files" | "links";

type LinkItem = {
  id: number;
  url: string;
  content?: string | null;
  sender_name?: string | null;
  created_at: string;
};

function isImageShared(f: SharedFile): boolean {
  if (f.file_type && f.file_type.startsWith("image/")) return true;
  const name = (f.file_name || f.file_url || "").toLowerCase();
  return /\.(png|jpe?g|gif|webp|heic|bmp)$/.test(name);
}

function isVideoShared(f: SharedFile): boolean {
  if (f.file_type && f.file_type.startsWith("video/")) return true;
  const name = (f.file_name || f.file_url || "").toLowerCase();
  return /\.(mp4|webm|mov|m4v|3gp)$/.test(name);
}

/**
 * SharedMediaGallery — Signal-Android's MediaOverview, in three tabs:
 *   • Media  — image/video grid (3 cols) → in-app full-screen pager viewer.
 *   • Files  — document/audio rows → open via the authed downloader (the
 *              /uploads route is behind Bearer auth, so a bare Linking.openURL
 *              401s — this is the root cause of the "shared file view broken").
 *   • Links  — messages whose text contains a URL → open externally.
 */
export default function SharedMediaGallery({
  convId,
  initialTab = "media",
}: {
  convId: number;
  initialTab?: Tab;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { width } = useWindowDimensions();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [loading, setLoading] = useState(true);
  const [files, setFiles] = useState<SharedFile[]>([]);
  const [links, setLinks] = useState<LinkItem[]>([]);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [opening, setOpening] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [filesRes, msgsRes] = await Promise.allSettled([
        getSharedFiles(convId),
        getMessages(convId),
      ]);
      if (filesRes.status === "fulfilled") {
        setFiles(filesRes.value.data || []);
      } else {
        setFiles([]);
      }
      // Derive links from message text (Signal extracts URLs client-side).
      if (msgsRes.status === "fulfilled") {
        const msgs: ChatMessage[] = msgsRes.value.data || [];
        const derived: LinkItem[] = [];
        for (const m of msgs) {
          if (m.deleted_at) continue;
          const url = extractFirstUrl(m.content);
          if (url) {
            derived.push({
              id: m.id,
              url,
              content: m.content,
              sender_name: m.sender_name,
              created_at: m.created_at,
            });
          }
        }
        derived.sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        );
        setLinks(derived);
      } else {
        setLinks([]);
      }
    } finally {
      setLoading(false);
    }
  }, [convId]);

  useEffect(() => {
    load();
  }, [load]);

  // Media = images + videos (have inline thumbnails). Files = everything else
  // (documents + audio). Both already arrive newest-first from the server.
  const media = useMemo(
    () => files.filter((f) => isImageShared(f) || isVideoShared(f)),
    [files],
  );
  const docs = useMemo(
    () => files.filter((f) => !isImageShared(f) && !isVideoShared(f)),
    [files],
  );

  const viewerItems: ViewerMediaItem[] = useMemo(
    () =>
      media.map((f) => ({
        id: f.id,
        file_url: f.file_url,
        file_name: f.file_name,
        sender_name: f.sender_name,
        created_at: f.created_at,
      })),
    [media],
  );

  const openFile = useCallback(async (f: SharedFile) => {
    setOpening(f.id);
    const res = await openAuthedFile(f.file_url, f.file_name, f.file_type);
    setOpening(null);
    if (!res.ok) {
      Alert.alert("Could not open file", res.error || "Unknown error.");
    }
  }, []);

  // 3-column grid sizing.
  const GRID_GAP = 2;
  const COLS = 3;
  const cell = Math.floor((width - GRID_GAP * (COLS - 1)) / COLS);

  return (
    <View style={styles.wrap}>
      <View style={styles.tabs}>
        <TabBtn
          label="Media"
          active={tab === "media"}
          onPress={() => setTab("media")}
          styles={styles}
        />
        <TabBtn
          label="Files"
          active={tab === "files"}
          onPress={() => setTab("files")}
          styles={styles}
        />
        <TabBtn
          label="Links"
          active={tab === "links"}
          onPress={() => setTab("links")}
          styles={styles}
        />
      </View>

      {loading ? (
        <ActivityIndicator style={styles.loading} color={theme.primary} />
      ) : tab === "media" ? (
        media.length === 0 ? (
          <Empty label="No media yet" styles={styles} />
        ) : (
          <FlatList
            // Distinct key per tab: switching tabs swaps a numColumns={3} grid
            // for a single-column list. RN throws a FATAL "Changing numColumns
            // on the fly is not supported" if the SAME FlatList instance changes
            // numColumns — keying each list forces a fresh instance per tab.
            key="media-grid"
            data={media}
            numColumns={COLS}
            keyExtractor={(f) => String(f.id)}
            contentContainerStyle={{ paddingBottom: 24 }}
            columnWrapperStyle={{ gap: GRID_GAP, marginBottom: GRID_GAP }}
            renderItem={({ item, index }) => {
              const resolved = uploadUrl(item.file_url) || undefined;
              const isLocal =
                !!resolved && /^(file|content|data):/i.test(resolved);
              const isVid = isVideoShared(item);
              return (
                <Pressable
                  style={{ width: cell, height: cell }}
                  onPress={() => setViewerIndex(index)}
                >
                  {isLocal ? (
                    <Image
                      source={{ uri: resolved }}
                      style={styles.gridImg}
                      resizeMode="cover"
                    />
                  ) : (
                    <AuthedImage
                      uri={resolved}
                      style={styles.gridImg}
                      resizeMode="cover"
                    />
                  )}
                  {isVid ? (
                    <View style={styles.playBadge}>
                      <Play size={18} color="#fff" fill="#fff" />
                    </View>
                  ) : null}
                </Pressable>
              );
            }}
          />
        )
      ) : tab === "files" ? (
        docs.length === 0 ? (
          <Empty label="No files yet" styles={styles} />
        ) : (
          <FlatList
            key="files-list"
            data={docs}
            keyExtractor={(f) => String(f.id)}
            contentContainerStyle={{ paddingBottom: 24 }}
            renderItem={({ item }) => (
              <Pressable
                style={styles.row}
                disabled={opening === item.id}
                onPress={() => openFile(item)}
              >
                {opening === item.id ? (
                  <ActivityIndicator size="small" color={theme.primary} />
                ) : (
                  <FileText size={22} color={theme.primary} />
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {item.file_name || "File"}
                  </Text>
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {item.sender_name || "Unknown"} ·{" "}
                    {fmtDateTime(item.created_at)}
                    {item.file_size ? ` · ${fmtSize(item.file_size)}` : ""}
                  </Text>
                </View>
              </Pressable>
            )}
          />
        )
      ) : links.length === 0 ? (
        <Empty label="No links yet" styles={styles} />
      ) : (
        <FlatList
          key="links-list"
          data={links}
          keyExtractor={(l) => String(l.id)}
          contentContainerStyle={{ paddingBottom: 24 }}
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              onPress={() => Linking.openURL(item.url).catch(() => {})}
            >
              <LinkIcon size={22} color={theme.primary} />
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {item.url}
                </Text>
                <Text style={styles.rowSub} numberOfLines={1}>
                  {item.sender_name || "Unknown"} ·{" "}
                  {fmtDateTime(item.created_at)}
                </Text>
              </View>
            </Pressable>
          )}
        />
      )}

      {viewerIndex != null ? (
        <MediaViewerPager
          items={viewerItems}
          initialIndex={viewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      ) : null}
    </View>
  );
}

function TabBtn({
  label,
  active,
  onPress,
  styles,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable style={styles.tabBtn} onPress={onPress}>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>
        {label}
      </Text>
      {active ? <View style={styles.tabUnderline} /> : null}
    </Pressable>
  );
}

function Empty({
  label,
  styles,
}: {
  label: string;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.emptyWrap}>
      <Text style={styles.emptyText}>{label}</Text>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    wrap: { flex: 1, backgroundColor: theme.bg },
    tabs: {
      flexDirection: "row",
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    tabBtn: {
      flex: 1,
      alignItems: "center",
      paddingVertical: 12,
    },
    tabText: {
      fontSize: 14,
      color: theme.textSecondary,
      fontFamily: theme.fontMedium,
    },
    tabTextActive: { color: theme.text, fontFamily: theme.fontSemiBold },
    tabUnderline: {
      position: "absolute",
      bottom: -1,
      height: 2,
      width: "60%",
      borderRadius: 2,
      backgroundColor: theme.primary,
    },
    loading: { paddingVertical: 40 },
    gridImg: {
      width: "100%",
      height: "100%",
      backgroundColor: theme.surface,
    },
    playBadge: {
      position: "absolute",
      top: "50%",
      left: "50%",
      marginLeft: -16,
      marginTop: -16,
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: "rgba(0,0,0,0.45)",
      alignItems: "center",
      justifyContent: "center",
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    rowTitle: { fontSize: 14, color: theme.text, fontFamily: theme.fontMedium },
    rowSub: { fontSize: 12, color: theme.textSecondary, marginTop: 3 },
    emptyWrap: { flex: 1, alignItems: "center", justifyContent: "center", paddingTop: 60 },
    emptyText: { fontSize: 14, color: theme.textMuted },
  });