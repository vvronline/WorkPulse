import { useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useDialog } from "../../hooks/useDialog";
import {
  getSharedFiles,
  getStarredMessages,
  searchMessages,
  starMessage,
  type ChatMessage,
  type MessageSearchResult,
  type PinnedMessage,
  type SharedFile,
  type StarredMessage,
} from "../../features";
import { clearCachedMessages } from "../../storage/chatCache";
import { setClearedAt } from "../../storage/chatLocalDeletes";
import type { HeaderSheet } from "./chatUtils";
import type { PendingTailScroll } from "./useChatThreadScroll";

type UseChatSearchPanelsOptions = {
  convId: number;
  messages: ChatMessage[];
  jumpToMessage: (messageId: number) => void;
  loadPinned: () => void;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setPinnedMsgs: Dispatch<SetStateAction<PinnedMessage[]>>;
  setStarredIds: Dispatch<SetStateAction<Set<number>>>;
  setHasMore: Dispatch<SetStateAction<boolean>>;
  setLoadingOlder: Dispatch<SetStateAction<boolean>>;
  setLoadOlderError: Dispatch<SetStateAction<string | null>>;
  messageGenerationRef: MutableRefObject<number>;
  latestLoadRequestRef: MutableRefObject<number>;
  olderRequestCursorRef: MutableRefObject<number | null>;
  pendingTailScrollRef: MutableRefObject<PendingTailScroll | null>;
  confirm: ReturnType<typeof useDialog>["confirm"];
};

/**
 * The two search surfaces plus the header 3-dot menu panels.
 *
 * In-conversation search (Signal-style) runs IN PLACE over the loaded thread —
 * the header swaps to a search bar and a bottom match-navigation bar steps
 * through hits — while the header sheet hosts a separate server-backed search,
 * the pinned/files/saved panels and Clear chat. Both searches share one debounce
 * timer (as in the original), so they live in a single hook.
 */
export default function useChatSearchPanels({
  convId,
  messages,
  jumpToMessage,
  loadPinned,
  setMessages,
  setPinnedMsgs,
  setStarredIds,
  setHasMore,
  setLoadingOlder,
  setLoadOlderError,
  messageGenerationRef,
  latestLoadRequestRef,
  olderRequestCursorRef,
  pendingTailScrollRef,
  confirm,
}: UseChatSearchPanelsOptions) {
  // Top-anchored overflow menu (Signal-style) open state.
  const [menuOpen, setMenuOpen] = useState(false);
  // ── Signal-style IN-CONVERSATION search ──────────────────────────────────
  // Instead of pushing a separate route, search runs in-place over the
  // currently-loaded thread: the header swaps to a search bar and a bottom
  // match-navigation bar steps through hits, scrolling the (inverted) list to
  // each and flashing a highlight on the matched bubble.
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Matching message ids in OLDEST-FIRST order (same order as `messages`).
  const [searchMatchIds, setSearchMatchIds] = useState<number[]>([]);
  const [searchActiveIdx, setSearchActiveIdx] = useState(0);
  // The message currently focused by search — drives the bubble highlight flash.
  const [highlightedId, setHighlightedId] = useState<number | null>(null);
  // Header 3-dot menu + its panels (search / pinned / shared files / saved).
  const [headerSheet, setHeaderSheet] = useState<HeaderSheet>(null);
  const [sheetSearchQ, setSheetSearchQ] = useState("");
  const [sheetSearchResults, setSheetSearchResults] = useState<
    MessageSearchResult[]
  >([]);
  const [sheetLoading, setSheetLoading] = useState(false);
  const [sharedFiles, setSharedFiles] = useState<SharedFile[]>([]);
  const [savedMsgs, setSavedMsgs] = useState<StarredMessage[]>([]);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Signal-style "tap a quoted reply → jump to the original": scroll the list
  // to the replied-to message and briefly flash its highlight (reuses the
  // search-match highlight). The original lives at `reply_to_id`; if it isn't
  // in the currently-loaded window we no-op gracefully (a best-effort jump,
  // same as the search/pinned cross-screen jumps).
  function jumpToReply(message: ChatMessage) {
    const targetId = message.reply_to_id;
    if (!targetId) return;
    const exists = messages.some((m) => m.id === targetId);
    if (!exists) return;
    jumpToMessage(targetId);
    // Flash the highlight: clear first so a transition null → id re-fires the
    // bubble's highlight effect even if it was the same id last time.
    setHighlightedId(null);
    setTimeout(() => setHighlightedId(targetId), 60);
    // Auto-clear the highlight after the flash so it doesn't stay tinted.
    setTimeout(() => setHighlightedId(null), 1400);
  }

  // ── Signal-style in-conversation search ───────────────────────────────────
  // Open the in-place search bar (called from the overflow menu). Dismisses the
  // keyboard-stealing emoji panel and clears any previous query/results.
  function openSearch() {
    setMenuOpen(false);
    setSearchQuery("");
    setSearchMatchIds([]);
    setSearchActiveIdx(0);
    setHighlightedId(null);
    setSearchMode(true);
  }

  // Close search and clear all of its transient state.
  function closeSearch() {
    setSearchMode(false);
    setSearchQuery("");
    setSearchMatchIds([]);
    setSearchActiveIdx(0);
    setHighlightedId(null);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
  }

  // Scroll the list to a matched message and flash its highlight.
  // Re-applies highlightedId even for the same id by briefly clearing it so the
  // bubble's highlight effect re-fires when stepping onto the same match twice.
  function focusMatch(messageId: number) {
    jumpToMessage(messageId);
    setHighlightedId(null);
    // Next tick so the bubble sees a transition from null → id and re-flashes.
    setTimeout(() => setHighlightedId(messageId), 30);
  }

  // Debounced query → server search scoped to this conversation. Results are
  // mapped to the message ids that are present in the loaded thread (so we can
  // scroll to them) and ordered oldest-first to match `messages`.
  function onSearchQueryChange(v: string) {
    setSearchQuery(v);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    const q = v.trim();
    if (q.length < 2) {
      setSearchMatchIds([]);
      setSearchActiveIdx(0);
      setHighlightedId(null);
      return;
    }
    searchDebounce.current = setTimeout(() => {
      searchMessages(q, convId)
        .then((r) => {
          const ids = (r.data || []).map((m) => m.id);
          // Keep only ids currently loaded in the thread and order them to
          // match the message list (oldest → newest).
          const present = messages
            .filter((m) => ids.includes(m.id))
            .map((m) => m.id);
          setSearchMatchIds(present);
          if (present.length > 0) {
            // Signal lands on the NEWEST match first.
            const startIdx = present.length - 1;
            setSearchActiveIdx(startIdx);
            focusMatch(present[startIdx]);
          } else {
            setSearchActiveIdx(0);
            setHighlightedId(null);
          }
        })
        .catch(() => {
          setSearchMatchIds([]);
          setSearchActiveIdx(0);
          setHighlightedId(null);
        });
    }, 300);
  }

  // Step to the PREVIOUS (older) match — up arrow in Signal's search nav bar.
  function searchPrev() {
    if (searchMatchIds.length === 0) return;
    const next = Math.max(0, searchActiveIdx - 1);
    setSearchActiveIdx(next);
    focusMatch(searchMatchIds[next]);
  }

  // Step to the NEXT (newer) match — down arrow.
  function searchNext() {
    if (searchMatchIds.length === 0) return;
    const next = Math.min(searchMatchIds.length - 1, searchActiveIdx + 1);
    setSearchActiveIdx(next);
    focusMatch(searchMatchIds[next]);
  }

  // ── Header 3-dot menu (mirrors the web ChatHeader overflow menu) ──

  function openHeaderPanel(panel: HeaderSheet) {
    if (panel === "search") {
      setSheetSearchQ("");
      setSheetSearchResults([]);
    } else if (panel === "pinned") {
      loadPinned();
    } else if (panel === "files") {
      setSheetLoading(true);
      getSharedFiles(convId)
        .then((r) => setSharedFiles(r.data || []))
        .catch(() => setSharedFiles([]))
        .finally(() => setSheetLoading(false));
    } else if (panel === "saved") {
      setSheetLoading(true);
      getStarredMessages()
        .then((r) => setSavedMsgs(r.data || []))
        .catch(() => setSavedMsgs([]))
        .finally(() => setSheetLoading(false));
    }
    setHeaderSheet(panel);
  }

  function onSheetSearchChange(v: string) {
    setSheetSearchQ(v);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    const q = v.trim();
    if (q.length < 2) {
      setSheetSearchResults([]);
      return;
    }
    searchDebounce.current = setTimeout(() => {
      setSheetLoading(true);
      searchMessages(q, convId)
        .then((r) => setSheetSearchResults(r.data || []))
        .catch(() => setSheetSearchResults([]))
        .finally(() => setSheetLoading(false));
    }, 300);
  }

  // Close the sheet first, then jump — scrollToIndex while a modal is
  // dismissing gets swallowed on Android.
  function jumpFromSheet(messageId: number) {
    setHeaderSheet(null);
    setTimeout(() => jumpToMessage(messageId), 350);
  }

  // Clear chat — Signal-style, LOCAL/device-only. This never touches the other
  // participant's copy (the old behaviour wrongly called the server, which
  // wiped the conversation for everyone). We record a per-conversation "cleared
  // at" cutoff so every message up to now is hidden on THIS device — including
  // messages not yet loaded via pagination — while NEW messages that arrive
  // afterwards still appear. The cutoff is persisted so the clear survives
  // reloads/app restarts.
  function doClearChat() {
    setHeaderSheet(null);
    // Defer so the confirm dialog never collides with the dismissing modal.
    setTimeout(() => {
      confirm({
        title: "Clear chat",
        message:
          "Clear this chat on your device? The other person will still have their copy.",
        confirmText: "Clear",
        isDanger: true,
        onConfirm: () => {
          messageGenerationRef.current += 1;
          latestLoadRequestRef.current += 1;
          olderRequestCursorRef.current = null;
          pendingTailScrollRef.current = null;
          setClearedAt(convId);
          setMessages([]);
          setPinnedMsgs([]);
          setHasMore(false);
          setLoadingOlder(false);
          setLoadOlderError(null);
          clearCachedMessages(convId);
        },
      });
    }, 300);
  }

  function unstarFromSheet(messageId: number) {
    starMessage(messageId)
      .then(() => {
        setSavedMsgs((prev) => prev.filter((m) => m.id !== messageId));
        setStarredIds((prev) => {
          const next = new Set(prev);
          next.delete(messageId);
          return next;
        });
      })
      .catch(() => {});
  }

  return {
    menuOpen,
    setMenuOpen,
    searchMode,
    searchQuery,
    searchMatchIds,
    searchActiveIdx,
    highlightedId,
    headerSheet,
    setHeaderSheet,
    sheetSearchQ,
    sheetSearchResults,
    sheetLoading,
    sharedFiles,
    savedMsgs,
    jumpToReply,
    openSearch,
    closeSearch,
    onSearchQueryChange,
    searchPrev,
    searchNext,
    openHeaderPanel,
    onSheetSearchChange,
    jumpFromSheet,
    doClearChat,
    unstarFromSheet,
  };
}
