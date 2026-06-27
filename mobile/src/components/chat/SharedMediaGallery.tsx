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
import InlineVideo, { VIDEO_AVAILABLE } from "./InlineVideo";

type Tab = "images" | "videos" | "files" | "links";

// Earlier callers (header menu / conversation profile) deep-link with the
// legacy combined "media" tab — map it to the new dedicated Images tab.
function normalizeTab(t?: string): Tab {
  if (t === "videos") return "videos";
  if (t === "files") return "files";
  if (t === "links") return "links";
  return "images";
}

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
 * SharedMediaGallery — Signal-Android's MediaOverview, in four tabs:
 *   • Images — image grid (3 cols) → in-app full-screen pager viewer.
 *   • Videos — video grid (3 cols); each cell is an InlineVideo that shows the
 *              poster frame + play button and opens its own native full-screen
 *              player on tap (the pager viewer is image-only, which is why
 *              shared videos previously would not play).
 *   • Files  — document/audio rows → open via the authed downloader (the
 *              /uploads route is behind Bearer auth, so a bare Linking.openURL
 *              401s — this is the root cause of the "shared file view broken").
 *   • Links  — messages whose text contains a URL → open externally.
 */
export default function SharedMediaGallery({
  convId,
  initialTab,
}: {
  convId: number;
  initialTab?: string;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { width } = useWindowDimensions();
  const [tab, setTab] = useState<Tab>(normalizeTab(initialTab));
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

  // Images, videos and documents are kept in separate tabs. Files = everything
  // that is neither an image nor a video (documents + audio). All already arrive
  // newest-first from the server.
  const images = useMemo(() => files.filter(isImageShared), [files]);
  const videos = useMemo(() => files.filter(isVideoShared), [files]);
  const docs = useMemo(
    () => files.filter((f) => !isImageShared(f) && !isVideoShared(f)),
    [files],
  );

  // The full-screen swipeable viewer is image-only (videos play in their own
  // native player via InlineVideo).
  const viewerItems: ViewerMediaItem[] = useMemo(
    () =>
      images.map((f) => ({
        id: f.id,
        file_url: f.file_url,
        file_name: f.file_name,
        sender_name: f.sender_name,
        created_at: f.created_at,
      })),
    [images],
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
          label="Images"
          active={tab === "images"}
          onPress={() => setTab("images")}
          styles={styles}
        />
        <TabBtn
          label="Videos"
          active={tab === "videos"}
          onPress={() => setTab("videos")}
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
      ) : tab === "images" ? (
        images.length === 0 ? (
          <Empty label="No images yet" styles={styles} />
        ) : (
          <FlatList
            // Distinct key per tab: switching tabs swaps a numColumns={3} grid
            // for a single-column list. RN throws a FATAL "Changing numColumns
            // on the fly is not supported" if the SAME FlatList instance changes
            // numColumns — keying each list forces a fresh instance per tab.
            key="images-grid"
            data={images}
            numColumns={COLS}
            keyExtractor={(f) => String(f.id)}
            contentContainerStyle={{ paddingBottom: 24 }}
            columnWrapperStyle={{ gap: GRID_GAP, marginBottom: GRID_GAP }}
            renderItem={({ item, index }) => {
              const resolved = uploadUrl(item.file_url) || undefined;
              const isLocal =
                !!resolved && /^(file|content|data):/i.test(resolved);
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
                </Pressable>
              );
            }}
          />
        )
      ) : tab === "videos" ? (
        videos.length === 0 ? (
          <Empty label="No videos yet" styles={styles} />
        ) : (
          <FlatList
            key="videos-grid"
            data={videos}
            numColumns={COLS}
            keyExtractor={(f) => String(f.id)}
            contentContainerStyle={{ paddingBottom: 24 }}
            columnWrapperStyle={{ gap: GRID_GAP, marginBottom: GRID_GAP }}
            renderItem={({ item }) => {
              const resolved = uploadUrl(item.file_url) || undefined;
              const isLocal =
                !!resolved && /^(file|content|data):/i.test(resolved);
              // InlineVideo renders the poster frame + play button and opens its
              // own native full-screen player on tap (with transport controls
              // and Bearer-auth for the protected /uploads route). When the
              // native video module is unavailable, fall back to a tappable
              // poster that opens the file through the authed downloader.
              if (VIDEO_AVAILABLE && resolved) {
                return (
                  <InlineVideo
                    uri={resolved}
                    isLocal={isLocal}
                    style={{ width: cell, height: cell }}
                  />
                );
              }
              return (
                <Pressable
                  style={{ width: cell, height: cell }}
                  disabled={opening === item.id}
                  onPress={() => openFile(item)}
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
                  <View style={styles.playBadge}>
                    {opening === item.id ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Play size={18} color="#fff" fill="#fff" />
                    )}
                  </View>
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
    emptyWrap: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingTop: 60,
    },
    emptyText: { fontSize: 14, color: theme.textMuted },
  });
