import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Images as ImagesIcon, Play } from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";

/**
 * A picked item from the recent-media strip. `kind` lets the caller route
 * images through the Signal-style MediaEditor while sending videos straight to
 * upload (the editor only handles still images).
 */
export type RecentMediaItem = {
  uri: string;
  width?: number;
  height?: number;
  kind: "image" | "video";
  fileName?: string;
  mimeType?: string;
  durationMs?: number;
};

/**
 * Horizontally-scrollable strip of the device's most-recent photos/videos —
 * Signal-Android parity: this is the recent-media row that sits at the top of
 * Signal's AttachmentKeyboard ("+" attach sheet) AND the quick gallery shortcut
 * inside its camera. Tapping a thumbnail returns it to the caller; an optional
 * leading "open full gallery" tile defers to the OS picker.
 *
 * Loads lazily via expo-media-library (resolved with `require` so a missing
 * native module — e.g. Expo Go — degrades to just the "gallery" tile instead of
 * crashing the bundle). Permission is requested on mount; if denied we show a
 * single tile that re-opens the system picker.
 */
export default function RecentMediaStrip({
  height = 96,
  limit = 40,
  onPick,
  onOpenGallery,
  showGalleryTile = true,
  mediaType = "all",
}: {
  height?: number;
  limit?: number;
  onPick: (item: RecentMediaItem) => void;
  onOpenGallery?: () => void;
  showGalleryTile?: boolean;
  mediaType?: "all" | "photo";
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [items, setItems] = useState<RecentMediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Resolve the native module defensively so the bundle never crashes when
      // it's unavailable (Expo Go / web). When absent we fall back to the
      // gallery tile only. Typed as `any` so the file still compiles before the
      // native package is installed (it's added to package.json; a dev/native
      // rebuild brings in the module + its types).
      let MediaLibrary: any = null;
      try {
        MediaLibrary = require("expo-media-library");
      } catch {
        MediaLibrary = null;
      }
      if (!MediaLibrary) {
        setDenied(true);
        setItems([]);
        return;
      }

      // Request READ access. On Android 13/14 and iOS 14+ the user can grant
      // *limited* ("selected photos") access — in that case `perm.granted` is
      // false even though photos ARE readable (`accessPrivileges === "limited"`).
      // Treat limited access as allowed so the recent-media strip still shows
      // (Signal surfaces the accessible subset rather than blocking). Pass
      // `false` (writeOnly = false) to ask for read access explicitly.
      let perm = await MediaLibrary.getPermissionsAsync(false);
      if (perm.status === "undetermined" || (!perm.granted && perm.canAskAgain)) {
        perm = await MediaLibrary.requestPermissionsAsync(false);
      }
      const allowed =
        perm.granted === true ||
        perm.status === "granted" ||
        perm.accessPrivileges === "limited" ||
        perm.accessPrivileges === "all";
      if (!allowed) {
        setDenied(true);
        setItems([]);
        return;
      }

      const wantVideo = mediaType === "all";
      const assets = await MediaLibrary.getAssetsAsync({
        first: limit,
        sortBy: [MediaLibrary.SortBy.creationTime],
        mediaType: wantVideo
          ? [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video]
          : [MediaLibrary.MediaType.photo],
      });

      const mapped: RecentMediaItem[] = (assets.assets || []).map((a: any) => ({
        // `a.uri` is a content:// (Android) / ph:// (iOS) reference; that is fine
        // for <Image> previews and for FormData uploads via the existing
        // uploadChatFile path. The MediaEditor / upload pipeline resolves it.
        uri: a.uri,
        width: a.width,
        height: a.height,
        kind: a.mediaType === MediaLibrary.MediaType.video ? "video" : "image",
        fileName: a.filename,
        durationMs: a.duration ? a.duration * 1000 : undefined,
      }));
      setItems(mapped);
      setDenied(false);
    } catch {
      setDenied(true);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [limit, mediaType]);

  useEffect(() => {
    load();
  }, [load]);

  const thumbSize = height;

  // Leading tile that opens the full system gallery picker.
  const galleryTile = showGalleryTile ? (
    <Pressable
      style={[styles.galleryTile, { width: thumbSize, height: thumbSize }]}
      onPress={onOpenGallery}
    >
      <ImagesIcon size={26} color={theme.text} />
      <Text style={styles.galleryTileText}>Gallery</Text>
    </Pressable>
  ) : null;

  if (loading) {
    return (
      <View style={[styles.container, { height }]}>
        {galleryTile}
        <View style={[styles.center, { height: thumbSize }]}>
          <ActivityIndicator size="small" color={theme.textSecondary} />
        </View>
      </View>
    );
  }

  if (denied && items.length === 0) {
    // No permission / no module — still offer the gallery picker fallback so
    // the user can attach media via the OS picker.
    return (
      <View style={[styles.container, { height }]}>
        {galleryTile}
        <View style={[styles.center, { flex: 1, height: thumbSize }]}>
          <Text style={styles.deniedText}>
            Allow photo access to see recent media
          </Text>
        </View>
      </View>
    );
  }

  return (
    <FlatList
      horizontal
      data={items}
      keyExtractor={(it, i) => `${it.uri}_${i}`}
      showsHorizontalScrollIndicator={false}
      style={{ height }}
      contentContainerStyle={styles.listContent}
      ListHeaderComponent={galleryTile}
      renderItem={({ item }) => (
        <Pressable
          style={[styles.thumb, { width: thumbSize, height: thumbSize }]}
          onPress={() => onPick(item)}
        >
          <Image source={{ uri: item.uri }} style={styles.thumbImg} />
          {item.kind === "video" ? (
            <View style={styles.videoBadge}>
              <Play size={12} color="#fff" fill="#fff" />
              {item.durationMs ? (
                <Text style={styles.videoDur}>
                  {formatDuration(item.durationMs)}
                </Text>
              ) : null}
            </View>
          ) : null}
        </Pressable>
      )}
    />
  );
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
    },
    center: { alignItems: "center", justifyContent: "center" },
    listContent: {
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
    },
    galleryTile: {
      borderRadius: 10,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      alignItems: "center",
      justifyContent: "center",
      gap: 4,
    },
    galleryTileText: {
      fontSize: 11,
      color: theme.textSecondary,
      fontFamily: theme.fontMedium,
    },
    thumb: {
      borderRadius: 10,
      overflow: "hidden",
      backgroundColor: theme.bgElevated,
    },
    thumbImg: { width: "100%", height: "100%" },
    videoBadge: {
      position: "absolute",
      bottom: 4,
      left: 4,
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
      paddingHorizontal: 5,
      paddingVertical: 2,
      borderRadius: 6,
      backgroundColor: "rgba(0,0,0,0.55)",
    },
    videoDur: {
      fontSize: 10,
      color: "#fff",
      fontFamily: theme.fontMedium,
    },
    deniedText: {
      fontSize: 12,
      color: theme.textMuted,
      fontFamily: theme.fontRegular,
      textAlign: "center",
    },
  });