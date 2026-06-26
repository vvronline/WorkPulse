import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  FlatList,
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  Images as ImagesIcon,
  Settings2,
  Video as VideoIcon,
} from "lucide-react-native";
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

// The device's read access to the photo library, mirroring the states
// Signal-Android branches on in AttachmentKeyboard.onMediaChanged():
//   "all"     → full library read (StorageUtil.canReadAnyFromMediaStore)
//   "limited" → "selected photos" subset (canOnlyReadSelectedMediaStore)
//   "none"    → no read permission at all
type Access = "all" | "limited" | "none";

// One cell in the horizontal strip. Beyond the actual media thumbnails we have
// an optional leading "open full gallery" tile and — in LIMITED access — a
// trailing "Manage" tile that lets the user add more photos to the accessible
// subset (Signal's "Select more photos" affordance).
type StripRow =
  | { type: "gallery" }
  | { type: "media"; item: RecentMediaItem }
  | { type: "manage" };

// Resolve the native module defensively so the JS bundle never crashes when
// it's unavailable (Expo Go / web). Returns null when absent.
//
// IMPORTANT: we import the LEGACY entry point. As of expo-media-library 56 the
// default export switched to the new class-based (`Query`/`Asset`) API, and the
// old functional helpers we rely on here — `getAssetsAsync`, `SortBy`,
// `MediaType`, `presentPermissionsPickerAsync` — are now deprecated stubs on
// the default export that THROW at runtime (see expo-media-library's
// `legacyWarnings`). Pulling them from `/legacy` keeps them working (and is the
// path expo's own migration warning points to). The permission response from
// the legacy API still carries `accessPrivileges`, which drives our Signal-style
// limited/full/none branching below.
function getMediaLibrary(): any {
  try {
    return require("expo-media-library/legacy");
  } catch {
    try {
      return require("expo-media-library");
    } catch {
      return null;
    }
  }
}

// Map an expo-media-library PermissionResponse onto Signal's access model.
// On iOS 14+/Android 14+ the user can grant a LIMITED ("selected photos")
// subset; expo surfaces that via `accessPrivileges === "limited"` even though
// `granted` may be false.
function resolveAccess(perm: any): Access {
  if (perm?.accessPrivileges === "limited") return "limited";
  if (perm?.accessPrivileges === "all") return "all";
  if (perm?.granted === true || perm?.status === "granted") return "all";
  return "none";
}

/**
 * Horizontally-scrollable strip of the device's most-recent photos/videos —
 * Signal-Android parity: this is the recent-media row that sits at the top of
 * Signal's AttachmentKeyboard ("+" attach sheet) AND the quick gallery shortcut
 * inside its camera. Tapping a thumbnail returns it to the caller.
 *
 * Visibility mirrors AttachmentKeyboard.onMediaChanged() exactly:
 *   • full access  → the recent strip.
 *   • limited (has media) → the recent strip + a trailing "Manage" tile.
 *   • limited (empty)     → a "No photos found" prompt + a "Manage" button.
 *   • no access    → a "permission needed" prompt + an "Allow access" button.
 *
 * Loads lazily via expo-media-library (resolved with `require` so a missing
 * native module degrades gracefully). Reloads whenever the strip becomes active
 * and when the app returns to the foreground after a Settings trip.
 */
export default function RecentMediaStrip({
  height = 96,
  limit = 40,
  onPick,
  onOpenGallery,
  showGalleryTile = true,
  mediaType = "all",
  active = true,
}: {
  height?: number;
  limit?: number;
  onPick: (item: RecentMediaItem) => void;
  onOpenGallery?: () => void;
  showGalleryTile?: boolean;
  mediaType?: "all" | "photo";
  // True when the strip is actually on-screen (the "+" sheet / camera is open).
  // Driving the (re)load off this — instead of only mount — means the strip
  // re-queries each time it's opened, so newly-granted photo access and
  // freshly-captured media show up without leaving the chat.
  active?: boolean;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [items, setItems] = useState<RecentMediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [access, setAccess] = useState<Access>("none");
  // True when the OS will no longer surface the permission dialog (the user
  // chose "Don't allow" previously). In that state requesting again is a no-op,
  // so the action button must deep-link to the app's system settings instead.
  const [canAskAgain, setCanAskAgain] = useState(true);
  // While a permission request is in flight, disable the action button.
  const [requesting, setRequesting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const MediaLibrary = getMediaLibrary();
      if (!MediaLibrary) {
        setAccess("none");
        setItems([]);
        return;
      }

      // Request READ access. Only auto-prompt when the OS will actually show
      // the dialog and we don't already hold a (limited) grant — re-prompting a
      // limited grant would be a no-op. Pass `false` (writeOnly = false) so we
      // ask for read access explicitly.
      let perm = await MediaLibrary.getPermissionsAsync(false);
      if (
        perm.status === "undetermined" ||
        (!perm.granted &&
          perm.canAskAgain &&
          perm.accessPrivileges !== "limited")
      ) {
        perm = await MediaLibrary.requestPermissionsAsync(false);
      }

      const mode = resolveAccess(perm);
      setCanAskAgain(perm.canAskAgain !== false);
      setAccess(mode);
      if (mode === "none") {
        setItems([]);
        return;
      }

      const wantVideo = mediaType === "all";
      const assets = await MediaLibrary.getAssetsAsync({
        first: limit,
        // Descending creation time — newest first. A bare `SortBy.creationTime`
        // sorts ASCENDING (oldest first), which is the opposite of a "recent"
        // strip and made it look empty/irrelevant.
        sortBy: [[MediaLibrary.SortBy.creationTime, false]],
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
    } catch {
      setAccess("none");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [limit, mediaType]);

  // (Re)load whenever the strip becomes active (the sheet/camera opens). This
  // picks up permission granted elsewhere and any media captured since the last
  // open. While inactive we skip the work (and the permission prompt).
  useEffect(() => {
    if (active) load();
  }, [active, load]);

  // When the user grants access (or edits the selected-photos subset) from the
  // OS and returns to the app, re-load so the strip refreshes without requiring
  // the sheet to be re-opened (Signal re-checks on resume).
  const accessRef = useRef(access);
  accessRef.current = access;
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && accessRef.current !== "all") {
        load();
      }
    });
    return () => sub.remove();
  }, [load]);

  // "Allow access" from the no-permission prompt: re-request, or (if the OS
  // won't ask again) open the app's system settings so the user can flip it on.
  const requestAccess = useCallback(async () => {
    if (requesting) return;
    setRequesting(true);
    try {
      const MediaLibrary = getMediaLibrary();
      if (!MediaLibrary || !canAskAgain) {
        await Linking.openSettings();
        return;
      }
      const perm = await MediaLibrary.requestPermissionsAsync(false);
      if (resolveAccess(perm) !== "none") {
        await load();
      } else {
        setCanAskAgain(perm.canAskAgain !== false);
        if (perm.canAskAgain === false) {
          await Linking.openSettings();
        }
      }
    } catch {
      /* ignore */
    } finally {
      setRequesting(false);
    }
  }, [requesting, canAskAgain, load]);

  // "Manage" / "Select more photos" from the LIMITED state: open the OS picker
  // for the accessible subset (Signal's onDisplayMoreContextMenu → selectMore).
  // Falls back to re-requesting, then to system settings, on older runtimes.
  const manageSelection = useCallback(async () => {
    const MediaLibrary = getMediaLibrary();
    if (!MediaLibrary) {
      await Linking.openSettings();
      return;
    }
    try {
      if (typeof MediaLibrary.presentPermissionsPickerAsync === "function") {
        await MediaLibrary.presentPermissionsPickerAsync();
      } else {
        await MediaLibrary.requestPermissionsAsync(false);
      }
      await load();
    } catch {
      await Linking.openSettings();
    }
  }, [load]);

  const thumbSize = height;

  // ----- Permission / empty prompts (media list hidden) -------------------
  // These replace the whole strip, exactly like Signal swaps the RecyclerView
  // for the permission text + action button.

  if (loading) {
    return (
      <View style={[styles.container, { height }]}>
        <ActivityIndicator size="small" color={theme.textSecondary} />
      </View>
    );
  }

  if (access === "none") {
    return (
      <View style={[styles.promptWrap, { minHeight: height }]}>
        <Text style={styles.promptText}>
          WorkPulse needs permission to show your photos and videos
        </Text>
        <Pressable
          style={styles.promptButton}
          onPress={requestAccess}
          disabled={requesting}
        >
          {requesting ? (
            <ActivityIndicator size="small" color={theme.primary} />
          ) : (
            <Text style={styles.promptButtonText}>
              {canAskAgain ? "Allow access" : "Settings"}
            </Text>
          )}
        </Pressable>
      </View>
    );
  }

  if (access === "limited" && items.length === 0) {
    return (
      <View style={[styles.promptWrap, { minHeight: height }]}>
        <Text style={styles.promptText}>No photos found</Text>
        <Pressable style={styles.promptButton} onPress={manageSelection}>
          <Text style={styles.promptButtonText}>Manage</Text>
        </Pressable>
      </View>
    );
  }

  // ----- The recent-media strip ------------------------------------------
  const rows: StripRow[] = [
    ...(showGalleryTile ? [{ type: "gallery" } as StripRow] : []),
    ...items.map((item) => ({ type: "media", item }) as StripRow),
    // Trailing "Manage" tile only in limited access — Signal appends a footer
    // placeholder in canOnlyReadSelectedMediaStore() to add more photos.
    ...(access === "limited" ? [{ type: "manage" } as StripRow] : []),
  ];

  return (
    <FlatList
      horizontal
      data={rows}
      keyExtractor={(row, i) =>
        row.type === "media" ? `${row.item.uri}_${i}` : `${row.type}_${i}`
      }
      showsHorizontalScrollIndicator={false}
      style={{ height }}
      contentContainerStyle={styles.listContent}
      renderItem={({ item: row }) => {
        if (row.type === "gallery") {
          return (
            <Pressable
              style={[
                styles.utilityTile,
                { width: thumbSize, height: thumbSize },
              ]}
              onPress={onOpenGallery}
            >
              <ImagesIcon size={26} color={theme.text} />
              <Text style={styles.utilityTileText}>Gallery</Text>
            </Pressable>
          );
        }
        if (row.type === "manage") {
          return (
            <Pressable
              style={[
                styles.utilityTile,
                { width: thumbSize, height: thumbSize },
              ]}
              onPress={manageSelection}
            >
              <Settings2 size={24} color={theme.text} />
              <Text style={styles.utilityTileText}>Manage</Text>
            </Pressable>
          );
        }
        const item = row.item;
        return (
          <Pressable
            style={[styles.thumb, { width: thumbSize, height: thumbSize }]}
            onPress={() => onPick(item)}
          >
            <Image source={{ uri: item.uri }} style={styles.thumbImg} />
            {item.kind === "video" ? (
              <View style={styles.videoBadge}>
                {item.durationMs ? (
                  <Text style={styles.videoDur}>
                    {formatDuration(item.durationMs)}
                  </Text>
                ) : (
                  <VideoIcon size={12} color="#fff" />
                )}
              </View>
            ) : null}
          </Pressable>
        );
      }}
    />
  );
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  // Signal formats as mm:ss, or h:mm:ss for clips an hour or longer.
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingHorizontal: 12,
    },
    listContent: {
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
    },
    // Leading "Gallery" / trailing "Manage" tiles share the same square chrome.
    utilityTile: {
      borderRadius: 10,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      alignItems: "center",
      justifyContent: "center",
      gap: 4,
    },
    utilityTileText: {
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
      right: 4,
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
    // Permission / empty prompt that replaces the strip (Signal parity).
    promptWrap: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 12,
      paddingHorizontal: 16,
    },
    promptText: {
      flexShrink: 1,
      fontSize: 13,
      color: theme.textSecondary,
      fontFamily: theme.fontRegular,
    },
    promptButton: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.primary,
    },
    promptButtonText: {
      fontSize: 13,
      color: theme.primary,
      fontFamily: theme.fontSemiBold,
    },
  });
