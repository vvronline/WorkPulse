import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  Vibration,
  View,
  useWindowDimensions,
} from "react-native";
import {
  Check,
  CheckCircle2,
  Download,
  FileText,
  Forward,
  LinkIcon,
  Pencil,
  Play,
  Share2,
  Trash2,
  X,
} from "lucide-react-native";
import { useAuth } from "../../auth/AuthContext";
import { uploadUrl } from "../../config";
import {
  deleteMessage,
  editMessage,
  forwardMessage,
  getConversations,
  getMessages,
  getSharedFiles,
  type ChatMessage,
  type Conversation,
  type SharedFile,
} from "../../features";
import { useDialog } from "../../hooks/useDialog";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import { AuthedImage } from "../AuthedImage";
import { extractFirstUrl, fmtDateTime, fmtSize } from "./chatUtils";
import InlineVideo, { VIDEO_AVAILABLE } from "./InlineVideo";
import MediaViewerPager, { type ViewerMediaItem } from "./MediaViewerPager";
import {
  exportAuthedFile,
  saveAuthedFileToLibrary,
  shareAuthedFile,
} from "./mediaFileActions";
import { openAuthedFile } from "./openAuthedFile";

type Tab = "images" | "videos" | "files" | "links";

type LinkItem = {
  id: number;
  url: string;
  content?: string | null;
  sender_id: number;
  sender_name?: string | null;
  created_at: string;
};

type GalleryItem = SharedFile | LinkItem;

// Earlier callers (header menu / conversation profile) deep-link with the
// legacy combined "media" tab — map it to the new dedicated Images tab.
function normalizeTab(t?: string): Tab {
  if (t === "videos") return "videos";
  if (t === "files") return "files";
  if (t === "links") return "links";
  return "images";
}

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

function isLinkItem(item: GalleryItem): item is LinkItem {
  return "url" in item;
}

/**
 * SharedMediaGallery — Signal-Android-style shared media overview with:
 *   • Images / videos / files / links tabs
 *   • Long-press multi-select
 *   • Selection action bar: delete / forward / share / download / edit
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
  const { user } = useAuth();
  const { alert, confirm, dialog } = useDialog();

  const [tab, setTab] = useState<Tab>(normalizeTab(initialTab));
  const [loading, setLoading] = useState(true);
  const [files, setFiles] = useState<SharedFile[]>([]);
  const [links, setLinks] = useState<LinkItem[]>([]);
  const [messagesById, setMessagesById] = useState<Record<number, ChatMessage>>(
    {},
  );
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [opening, setOpening] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [actionBusy, setActionBusy] = useState<
    null | "delete" | "forward" | "share" | "download" | "edit"
  >(null);
  const [forwardOpen, setForwardOpen] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editText, setEditText] = useState("");
  const [editingItemId, setEditingItemId] = useState<number | null>(null);

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

      if (msgsRes.status === "fulfilled") {
        const msgs: ChatMessage[] = msgsRes.value.data || [];
        const map: Record<number, ChatMessage> = {};
        const derived: LinkItem[] = [];
        for (const m of msgs) {
          map[m.id] = m;
          if (m.deleted_at) continue;
          const url = extractFirstUrl(m.content);
          if (url) {
            derived.push({
              id: m.id,
              url,
              content: m.content,
              sender_id: m.sender_id,
              sender_name: m.sender_name,
              created_at: m.created_at,
            });
          }
        }
        derived.sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        );
        setMessagesById(map);
        setLinks(derived);
      } else {
        setMessagesById({});
        setLinks([]);
      }
    } finally {
      setLoading(false);
    }
  }, [convId]);

  useEffect(() => {
    load();
  }, [load]);

  // Files = everything that is neither an image nor a video.
  const images = useMemo(() => files.filter(isImageShared), [files]);
  const videos = useMemo(() => files.filter(isVideoShared), [files]);
  const docs = useMemo(
    () => files.filter((f) => !isImageShared(f) && !isVideoShared(f)),
    [files],
  );

  const currentItems = useMemo<GalleryItem[]>(() => {
    if (tab === "images") return images;
    if (tab === "videos") return videos;
    if (tab === "files") return docs;
    return links;
  }, [docs, images, links, tab, videos]);

  const selectionMode = selectedIds.size > 0;

  const selectedItems = useMemo(
    () => currentItems.filter((item) => selectedIds.has(item.id)),
    [currentItems, selectedIds],
  );

  useEffect(() => {
    const valid = new Set(currentItems.map((item) => item.id));
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set([...prev].filter((id) => valid.has(id)));
      if (next.size === prev.size) return prev;
      return next;
    });
  }, [currentItems]);

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

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const toggleSelected = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Vibrate once when entering selection mode for the first time (haptic
  // feedback matches Signal-Android's long-press entry). Subsequent toggles
  // within the same selection session are silent.
  const enterSelectionOrToggle = useCallback((id: number) => {
    setSelectedIds((prev) => {
      if (prev.size === 0) Vibration.vibrate(40);
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAllCurrentTab = useCallback(() => {
    setSelectedIds(new Set(currentItems.map((item) => item.id)));
  }, [currentItems]);

  const deselectAllCurrentTab = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const allSelected =
    currentItems.length > 0 && selectedIds.size === currentItems.length;

  const changeTab = useCallback((next: Tab) => {
    setTab(next);
    setViewerIndex(null);
    setSelectedIds(new Set());
  }, []);

  // Intercept the Android hardware back-press while in selection mode so it
  // clears the selection instead of navigating away from the screen.
  useEffect(() => {
    if (!selectionMode) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      clearSelection();
      return true;
    });
    return () => sub.remove();
  }, [selectionMode, clearSelection]);

  const openFile = useCallback(
    async (f: SharedFile) => {
      setOpening(f.id);
      const res = await openAuthedFile(f.file_url, f.file_name, f.file_type);
      setOpening(null);
      if (!res.ok) {
        alert("Could not open file", res.error || "Unknown error.");
      }
    },
    [alert],
  );

  const getItemSenderId = useCallback(
    (item: GalleryItem) => item.sender_id,
    [],
  );

  const getEditableText = useCallback(
    (item: GalleryItem) => {
      if (isLinkItem(item)) return item.content || "";
      return messagesById[item.id]?.content || "";
    },
    [messagesById],
  );

  const canDelete =
    selectedItems.length > 0 &&
    selectedItems.every((item) => getItemSenderId(item) === user?.id);
  const canForward = selectedItems.length > 0;
  const onlyLinks =
    selectedItems.length > 0 && selectedItems.every((item) => isLinkItem(item));
  const canShare =
    selectedItems.length > 0 && (onlyLinks || selectedItems.length === 1);
  const canDownload =
    selectedItems.length > 0 &&
    selectedItems.every((item) => !isLinkItem(item));
  const canEdit =
    selectedItems.length === 1 &&
    getItemSenderId(selectedItems[0]) === user?.id &&
    getEditableText(selectedItems[0]).trim().length > 0;

  // Contextual one-liner shown below the action bar explaining why a button is
  // greyed out. Only the highest-priority constraint is surfaced at once.
  const selectionHint = useMemo<string | null>(() => {
    if (selectedItems.length === 0) return null;
    const hasNonOwn = selectedItems.some(
      (item) => getItemSenderId(item) !== user?.id,
    );
    if (hasNonOwn) return "Select only your own messages to delete or edit";
    if (!canShare && !onlyLinks && selectedItems.length > 1)
      return "Select one item at a time to share a file";
    if (!canEdit && selectedItems.length > 1)
      return "Select exactly one message to edit";
    return null;
  }, [canEdit, canShare, getItemSenderId, onlyLinks, selectedItems, user?.id]);

  const openForwardPicker = useCallback(async () => {
    if (!canForward || actionBusy) return;
    setLoadingConversations(true);
    setForwardOpen(true);
    try {
      const { data } = await getConversations();
      setConversations(data || []);
    } catch {
      setConversations([]);
    } finally {
      setLoadingConversations(false);
    }
  }, [actionBusy, canForward]);

  const onDeleteSelected = useCallback(() => {
    if (!canDelete || actionBusy) return;
    const ids = selectedItems.map((item) => item.id);
    confirm({
      title:
        ids.length === 1
          ? "Delete selected message"
          : "Delete selected messages",
      message:
        ids.length === 1
          ? "This will remove the selected message."
          : `This will remove ${ids.length} selected messages.`,
      confirmText: "Delete",
      isDanger: true,
      onConfirm: async () => {
        setActionBusy("delete");
        try {
          const results = await Promise.allSettled(
            ids.map((id) => deleteMessage(id)),
          );
          const okCount = results.filter(
            (r) => r.status === "fulfilled",
          ).length;
          await load();
          clearSelection();
          if (okCount === 0) {
            alert("Error", "Could not delete the selected messages.");
          } else if (okCount === ids.length) {
            alert(
              "Deleted",
              okCount === 1
                ? "Message deleted."
                : `${okCount} messages deleted.`,
            );
          } else {
            alert(
              "Partially deleted",
              `${okCount} of ${ids.length} messages were deleted.`,
            );
          }
        } finally {
          setActionBusy(null);
        }
      },
    });
  }, [
    actionBusy,
    alert,
    canDelete,
    clearSelection,
    confirm,
    load,
    selectedItems,
  ]);

  const onForwardTo = useCallback(
    async (targetConvId: number) => {
      if (actionBusy) return;
      const ids = selectedItems.map((item) => item.id);
      if (ids.length === 0) return;
      setActionBusy("forward");
      try {
        const results = await Promise.allSettled(
          ids.map((id) => forwardMessage(id, [targetConvId])),
        );
        const okCount = results.filter((r) => r.status === "fulfilled").length;
        setForwardOpen(false);
        clearSelection();
        if (okCount === 0) {
          alert("Error", "Could not forward the selected messages.");
        } else if (okCount === ids.length) {
          alert(
            "Forwarded",
            okCount === 1
              ? "Message forwarded."
              : `${okCount} messages forwarded.`,
          );
        } else {
          alert(
            "Partially forwarded",
            `${okCount} of ${ids.length} messages were forwarded.`,
          );
        }
      } finally {
        setActionBusy(null);
      }
    },
    [actionBusy, alert, clearSelection, selectedItems],
  );

  const onShareSelected = useCallback(async () => {
    if (!canShare || actionBusy) return;
    setActionBusy("share");
    try {
      if (onlyLinks) {
        await Share.share({
          message: selectedItems
            .map((item) => (item as LinkItem).url)
            .join("\n"),
        });
        clearSelection();
        return;
      }

      const item = selectedItems[0];
      if (!item || isLinkItem(item)) return;
      const res = await shareAuthedFile(
        item.file_url,
        item.file_name,
        item.file_type,
      );
      if (!res.ok) {
        alert("Share failed", res.error || "Could not share this file.");
        return;
      }
      clearSelection();
    } catch (e: any) {
      alert("Share failed", e?.message || "Could not share the selected item.");
    } finally {
      setActionBusy(null);
    }
  }, [actionBusy, alert, canShare, clearSelection, onlyLinks, selectedItems]);

  const onDownloadSelected = useCallback(async () => {
    if (!canDownload || actionBusy) return;
    setActionBusy("download");
    try {
      const fileItems = selectedItems.filter(
        (item): item is SharedFile => !isLinkItem(item),
      );
      let okCount = 0;
      let firstError: string | null = null;
      for (const item of fileItems) {
        const res =
          isImageShared(item) || isVideoShared(item)
            ? await saveAuthedFileToLibrary(item.file_url, item.file_name)
            : await exportAuthedFile(
                item.file_url,
                item.file_name,
                item.file_type,
              );
        if (res.ok) okCount += 1;
        else if (!firstError)
          firstError = res.error || "Could not save this file.";
      }
      clearSelection();
      if (okCount === 0) {
        alert(
          "Save failed",
          firstError || "Could not save the selected items.",
        );
      } else if (okCount === fileItems.length) {
        alert(
          "Saved",
          okCount === 1
            ? "Item saved/exported successfully."
            : `${okCount} items saved/exported successfully.`,
        );
      } else {
        alert(
          "Partially saved",
          `${okCount} of ${fileItems.length} items were saved/exported.`,
        );
      }
    } finally {
      setActionBusy(null);
    }
  }, [actionBusy, alert, canDownload, clearSelection, selectedItems]);

  const openEditModal = useCallback(() => {
    if (!canEdit || actionBusy) return;
    const item = selectedItems[0];
    if (!item) return;
    setEditingItemId(item.id);
    setEditText(getEditableText(item));
    setEditOpen(true);
  }, [actionBusy, canEdit, getEditableText, selectedItems]);

  const onSaveEdit = useCallback(async () => {
    if (editingItemId == null || actionBusy) return;
    const content = editText.trim();
    if (!content) {
      alert("Invalid content", "Edited text cannot be empty.");
      return;
    }
    setActionBusy("edit");
    try {
      await editMessage(editingItemId, content);
      setEditOpen(false);
      setEditingItemId(null);
      setEditText("");
      await load();
      clearSelection();
      alert("Edited", "Message updated.");
    } catch (e: any) {
      alert(
        "Edit failed",
        e?.response?.data?.error || "Could not edit this message.",
      );
    } finally {
      setActionBusy(null);
    }
  }, [actionBusy, alert, clearSelection, editText, editingItemId, load]);

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
          onPress={() => changeTab("images")}
          styles={styles}
        />
        <TabBtn
          label="Videos"
          active={tab === "videos"}
          onPress={() => changeTab("videos")}
          styles={styles}
        />
        <TabBtn
          label="Files"
          active={tab === "files"}
          onPress={() => changeTab("files")}
          styles={styles}
        />
        <TabBtn
          label="Links"
          active={tab === "links"}
          onPress={() => changeTab("links")}
          styles={styles}
        />
      </View>

      {selectionMode ? (
        <>
          <View style={styles.selectionHeader}>
            <Pressable
              style={styles.selectionHeaderBtn}
              onPress={clearSelection}
            >
              <X size={18} color={theme.text} />
              <Text style={styles.selectionHeaderBtnText}>Clear</Text>
            </Pressable>
            <Text style={styles.selectionTitle}>
              {selectedIds.size}
              {" / "}
              {currentItems.length}
            </Text>
            <Pressable
              style={styles.selectionHeaderBtn}
              onPress={
                allSelected ? deselectAllCurrentTab : selectAllCurrentTab
              }
            >
              <Check
                size={18}
                color={allSelected ? theme.textMuted : theme.text}
              />
              <Text
                style={[
                  styles.selectionHeaderBtnText,
                  allSelected && styles.actionTextDisabled,
                ]}
              >
                {allSelected ? "Deselect all" : "Select all"}
              </Text>
            </Pressable>
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.actionBar}
          >
            <ActionBtn
              icon={
                <Trash2
                  size={18}
                  color={canDelete ? theme.danger : theme.textMuted}
                />
              }
              label="Delete"
              danger
              disabled={!canDelete || !!actionBusy}
              loading={actionBusy === "delete"}
              onPress={onDeleteSelected}
              styles={styles}
            />
            <ActionBtn
              icon={
                <Forward
                  size={18}
                  color={canForward ? theme.text : theme.textMuted}
                />
              }
              label="Forward"
              disabled={!canForward || !!actionBusy}
              loading={actionBusy === "forward"}
              onPress={openForwardPicker}
              styles={styles}
            />
            <ActionBtn
              icon={
                <Share2
                  size={18}
                  color={canShare ? theme.text : theme.textMuted}
                />
              }
              label="Share"
              disabled={!canShare || !!actionBusy}
              loading={actionBusy === "share"}
              onPress={onShareSelected}
              styles={styles}
            />
            <ActionBtn
              icon={
                <Download
                  size={18}
                  color={canDownload ? theme.text : theme.textMuted}
                />
              }
              label="Download"
              disabled={!canDownload || !!actionBusy}
              loading={actionBusy === "download"}
              onPress={onDownloadSelected}
              styles={styles}
            />
            <ActionBtn
              icon={
                <Pencil
                  size={18}
                  color={canEdit ? theme.text : theme.textMuted}
                />
              }
              label="Edit"
              disabled={!canEdit || !!actionBusy}
              loading={actionBusy === "edit"}
              onPress={openEditModal}
              styles={styles}
            />
          </ScrollView>
          {selectionHint ? (
            <View style={styles.hintRow}>
              <Text style={styles.hintText}>{selectionHint}</Text>
            </View>
          ) : null}
        </>
      ) : null}

      {loading ? (
        <ActivityIndicator style={styles.loading} color={theme.primary} />
      ) : tab === "images" ? (
        images.length === 0 ? (
          <Empty label="No images yet" styles={styles} />
        ) : (
          <FlatList
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
              const selected = selectedIds.has(item.id);
              return (
                <Pressable
                  style={{ width: cell, height: cell }}
                  onLongPress={() => enterSelectionOrToggle(item.id)}
                  delayLongPress={250}
                  onPress={() => {
                    if (selectionMode) toggleSelected(item.id);
                    else setViewerIndex(index);
                  }}
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
                  {selected ? <View style={styles.gridSelectedShade} /> : null}
                  {selectionMode ? (
                    <View style={styles.gridSelectionBadge}>
                      {selected ? (
                        <CheckCircle2
                          size={22}
                          color="#fff"
                          fill={theme.primary}
                        />
                      ) : (
                        <View style={styles.gridSelectionRing} />
                      )}
                    </View>
                  ) : null}
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
              const selected = selectedIds.has(item.id);
              if (VIDEO_AVAILABLE && resolved) {
                return (
                  <View style={{ width: cell, height: cell }}>
                    <InlineVideo
                      uri={resolved}
                      isLocal={isLocal}
                      style={{ width: cell, height: cell }}
                      onLongPress={() => enterSelectionOrToggle(item.id)}
                    />
                    {selectionMode ? (
                      <Pressable
                        style={styles.selectionTouchOverlay}
                        onPress={() => toggleSelected(item.id)}
                      />
                    ) : null}
                    {selected ? (
                      <View style={styles.gridSelectedShade} />
                    ) : null}
                    {selectionMode ? (
                      <View
                        style={styles.gridSelectionBadge}
                        pointerEvents="none"
                      >
                        {selected ? (
                          <CheckCircle2
                            size={22}
                            color="#fff"
                            fill={theme.primary}
                          />
                        ) : (
                          <View style={styles.gridSelectionRing} />
                        )}
                      </View>
                    ) : null}
                  </View>
                );
              }
              return (
                <Pressable
                  style={{ width: cell, height: cell }}
                  disabled={opening === item.id}
                  onLongPress={() => enterSelectionOrToggle(item.id)}
                  delayLongPress={250}
                  onPress={() => {
                    if (selectionMode) toggleSelected(item.id);
                    else void openFile(item);
                  }}
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
                  {selected ? <View style={styles.gridSelectedShade} /> : null}
                  {selectionMode ? (
                    <View style={styles.gridSelectionBadge}>
                      {selected ? (
                        <CheckCircle2
                          size={22}
                          color="#fff"
                          fill={theme.primary}
                        />
                      ) : (
                        <View style={styles.gridSelectionRing} />
                      )}
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
            renderItem={({ item }) => {
              const selected = selectedIds.has(item.id);
              return (
                <Pressable
                  style={[styles.row, selected && styles.rowSelected]}
                  disabled={opening === item.id}
                  onLongPress={() => enterSelectionOrToggle(item.id)}
                  delayLongPress={250}
                  onPress={() => {
                    if (selectionMode) toggleSelected(item.id);
                    else void openFile(item);
                  }}
                >
                  {selectionMode ? (
                    selected ? (
                      <CheckCircle2
                        size={20}
                        color={theme.primary}
                        fill={theme.primary}
                      />
                    ) : (
                      <View style={styles.listSelectionRing} />
                    )
                  ) : opening === item.id ? (
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
              );
            }}
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
          renderItem={({ item }) => {
            const selected = selectedIds.has(item.id);
            return (
              <Pressable
                style={[styles.row, selected && styles.rowSelected]}
                onLongPress={() => enterSelectionOrToggle(item.id)}
                delayLongPress={250}
                onPress={() => {
                  if (selectionMode) {
                    toggleSelected(item.id);
                    return;
                  }
                  Linking.openURL(item.url).catch(() => {});
                }}
              >
                {selectionMode ? (
                  selected ? (
                    <CheckCircle2
                      size={20}
                      color={theme.primary}
                      fill={theme.primary}
                    />
                  ) : (
                    <View style={styles.listSelectionRing} />
                  )
                ) : (
                  <LinkIcon size={22} color={theme.primary} />
                )}
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
            );
          }}
        />
      )}

      {viewerIndex != null ? (
        <MediaViewerPager
          items={viewerItems}
          initialIndex={viewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      ) : null}

      <Modal
        visible={forwardOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setForwardOpen(false)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setForwardOpen(false)}
        >
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>Forward to…</Text>
            {loadingConversations ? (
              <ActivityIndicator
                style={{ paddingVertical: 18 }}
                color={theme.primary}
              />
            ) : (
              <ScrollView style={{ maxHeight: 360 }}>
                {conversations.filter((c) => c.id !== convId).length === 0 ? (
                  <Text style={styles.modalEmpty}>No conversations</Text>
                ) : (
                  conversations
                    .filter((c) => c.id !== convId)
                    .map((c) => (
                      <Pressable
                        key={c.id}
                        style={styles.forwardConv}
                        disabled={!!actionBusy}
                        onPress={() => void onForwardTo(c.id)}
                      >
                        <Text style={styles.forwardConvName} numberOfLines={1}>
                          {c.is_group
                            ? c.group_name || `Group #${c.id}`
                            : c.other_full_name ||
                              c.other_username ||
                              `Conversation #${c.id}`}
                        </Text>
                      </Pressable>
                    ))
                )}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={editOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setEditOpen(false)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setEditOpen(false)}
        >
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>Edit message</Text>
            <TextInput
              style={styles.editInput}
              value={editText}
              onChangeText={setEditText}
              multiline
              autoFocus
              placeholder="Edit message"
              placeholderTextColor={theme.textMuted}
            />
            <View style={styles.editActions}>
              <Pressable
                style={styles.editBtnSecondary}
                onPress={() => setEditOpen(false)}
                disabled={!!actionBusy}
              >
                <Text style={styles.editBtnSecondaryText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={styles.editBtnPrimary}
                onPress={() => void onSaveEdit()}
                disabled={!!actionBusy}
              >
                <Text style={styles.editBtnPrimaryText}>Save</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {dialog}
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

function ActionBtn({
  icon,
  label,
  disabled,
  danger,
  loading,
  onPress,
  styles,
}: {
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  loading?: boolean;
  onPress: () => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable
      style={[
        styles.actionBtn,
        disabled && styles.actionBtnDisabled,
        danger && !disabled && styles.actionBtnDanger,
      ]}
      disabled={disabled}
      onPress={onPress}
    >
      {loading ? (
        <ActivityIndicator
          size={16}
          color={
            danger
              ? styles.actionBtnTextDanger.color
              : styles.actionBtnText.color
          }
        />
      ) : (
        icon
      )}
      <Text
        style={[
          styles.actionBtnText,
          disabled && styles.actionTextDisabled,
          danger && !disabled && styles.actionBtnTextDanger,
        ]}
      >
        {label}
      </Text>
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
    selectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
      backgroundColor: theme.bgElevated,
    },
    selectionHeaderBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      minWidth: 74,
    },
    selectionHeaderBtnText: {
      color: theme.text,
      fontSize: 13,
      fontFamily: theme.fontMedium,
    },
    selectionTitle: {
      color: theme.text,
      fontSize: 15,
      fontFamily: theme.fontSemiBold,
    },
    actionBar: {
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
      backgroundColor: theme.bgElevated,
    },
    actionBtn: {
      minWidth: 84,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      backgroundColor: theme.surface,
    },
    actionBtnDanger: {
      borderColor: theme.danger,
      backgroundColor: `${theme.danger}14`,
    },
    actionBtnDisabled: {
      opacity: 0.5,
    },
    actionBtnText: {
      color: theme.text,
      fontSize: 13,
      fontFamily: theme.fontMedium,
    },
    actionBtnTextDanger: {
      color: theme.danger,
    },
    actionTextDisabled: {
      color: theme.textMuted,
    },
    hintRow: {
      paddingHorizontal: 16,
      paddingVertical: 7,
      backgroundColor: theme.bgElevated,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    hintText: {
      fontSize: 12,
      color: theme.textSecondary,
      fontStyle: "italic",
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
    selectionTouchOverlay: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    },
    gridSelectedShade: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: "rgba(0,0,0,0.28)",
    },
    gridSelectionBadge: {
      position: "absolute",
      top: 8,
      right: 8,
    },
    gridSelectionRing: {
      width: 22,
      height: 22,
      borderRadius: 11,
      borderWidth: 2,
      borderColor: "rgba(255,255,255,0.92)",
      backgroundColor: "rgba(0,0,0,0.28)",
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
      backgroundColor: theme.bg,
    },
    rowSelected: {
      backgroundColor: theme.surface,
    },
    listSelectionRing: {
      width: 20,
      height: 20,
      borderRadius: 10,
      borderWidth: 2,
      borderColor: theme.textMuted,
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
    modalOverlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.56)",
      justifyContent: "center",
      paddingHorizontal: 20,
    },
    modalCard: {
      backgroundColor: theme.bgElevated,
      borderRadius: theme.radius,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      padding: 16,
      maxHeight: "75%",
    },
    modalTitle: {
      color: theme.text,
      fontSize: 16,
      fontFamily: theme.fontSemiBold,
      marginBottom: 12,
    },
    modalEmpty: {
      color: theme.textMuted,
      fontSize: 14,
      paddingVertical: 12,
    },
    forwardConv: {
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    forwardConvName: {
      color: theme.text,
      fontSize: 15,
    },
    editInput: {
      minHeight: 110,
      maxHeight: 220,
      borderWidth: 1,
      borderColor: theme.inputBorder,
      borderRadius: 12,
      backgroundColor: theme.inputBg,
      color: theme.text,
      paddingHorizontal: 12,
      paddingVertical: 10,
      textAlignVertical: "top",
      fontSize: 15,
    },
    editActions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: 10,
      marginTop: 14,
    },
    editBtnSecondary: {
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 10,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.glassBorder,
    },
    editBtnSecondaryText: {
      color: theme.text,
      fontFamily: theme.fontMedium,
    },
    editBtnPrimary: {
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 10,
      backgroundColor: theme.primary,
    },
    editBtnPrimaryText: {
      color: "#fff",
      fontFamily: theme.fontSemiBold,
    },
  });
