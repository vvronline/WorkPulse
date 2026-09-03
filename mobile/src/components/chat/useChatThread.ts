import { useEffect, useMemo, useRef, useState } from "react";
import { useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAuth } from "../../auth/AuthContext";
import { useDialog } from "../../hooks/useDialog";
import { useKeyboardInset } from "../../hooks/useKeyboardInset";
import type { ChatMessage } from "../../features";
import { getCachedMessages } from "../../storage/chatCache";
import {
  INITIAL_THREAD_PAGE_SIZE,
  mergeOutboxIntoMessages,
} from "./chatThreadMessageUtils";
import useMobileConversationDraft from "./useMobileConversationDraft";
import useChatMessageSelection from "./useChatMessageSelection";
import useChatComposerKeyboard from "./useChatComposerKeyboard";
import useChatPeerIdentity from "./useChatPeerIdentity";
import useChatThreadScroll from "./useChatThreadScroll";
import useChatMessageContextMenu from "./useChatMessageContextMenu";
import useChatPinsAndStars from "./useChatPinsAndStars";
import useChatMessageLoader from "./useChatMessageLoader";
import useChatSearchPanels from "./useChatSearchPanels";
import useChatRealtimeSync from "./useChatRealtimeSync";
import useChatMediaUploads from "./useChatMediaUploads";
import useChatVoiceRecording from "./useChatVoiceRecording";
import useChatForwardActions from "./useChatForwardActions";
import useChatComposerActions from "./useChatComposerActions";
import useChatDeleteActions from "./useChatDeleteActions";
import useChatThreadNavigation from "./useChatThreadNavigation";
import useChatListPresentation from "./useChatListPresentation";

/**
 * Conversation-thread controller.
 *
 * This hook is a COMPOSER: it owns only the state that genuinely crosses every
 * concern (the message array + its ref, the composer text and the mounted
 * guard) and wires together the focused sub-hooks that each own one concern —
 * identity/presence, scrolling, the loader/pagination, realtime, media uploads,
 * reactions, pins/stars, search panels, navigation and list presentation.
 *
 * The sub-hooks are called in DEPENDENCY ORDER: a hook that consumes another
 * hook's callbacks or refs is called after it. The returned object is the
 * screen's full view model (see app/chat/[id].tsx).
 */
export function useChatThread() {
  const params = useLocalSearchParams<{
    id: string;
    name?: string;
    avatar?: string;
    peerId?: string;
    isGroup?: string;
    groupMemberAvatars?: string;
    messageId?: string;
  }>();
  const { id } = params;
  const convId = Number(id);
  const notificationMessageId = useMemo(() => {
    const n = Number(params.messageId);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [params.messageId]);
  const parsedGroupMemberAvatars = useMemo(() => {
    if (!params.groupMemberAvatars) return [];
    try {
      const parsed = JSON.parse(params.groupMemberAvatars);
      return Array.isArray(parsed)
        ? parsed.filter(
            (v): v is string => typeof v === "string" && v.length > 0,
          )
        : [];
    } catch {
      return [];
    }
  }, [params.groupMemberAvatars]);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const kbInset = useKeyboardInset();
  const { width: winWidth, height: winHeight } = useWindowDimensions();
  const { user } = useAuth();
  const { alert, confirm, dialog } = useDialog();

  // Seed from the on-device cache SYNCHRONOUSLY so the thread paints instantly
  // (Signal-style) instead of blocking on a full-screen spinner. The network
  // refresh in `load()` reconciles in the background. `loading` only stays true
  // on a true cold cache (first-ever open of this conversation).
  const cachedMessages = useMemo(() => getCachedMessages(convId), [convId]);
  const initialCachedMessages = useMemo(() => {
    if (!cachedMessages || cachedMessages.length <= INITIAL_THREAD_PAGE_SIZE) {
      return cachedMessages;
    }
    // Messages are oldest-first; keep the newest page for the initial paint.
    return cachedMessages.slice(-INITIAL_THREAD_PAGE_SIZE);
  }, [cachedMessages]);
  // Merge pending OUTBOX messages (sent while offline, awaiting delivery)
  // into the seed so they reappear as pending bubbles after exiting and
  // reopening the chat — see mergeOutboxIntoMessages.
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    mergeOutboxIntoMessages(
      initialCachedMessages || [],
      convId,
      user?.id,
      user?.full_name,
    ),
  );
  // Pagination reads the latest window without making loadOlder depend on the
  // entire array (and therefore change callback identity after every page).
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const [text, setText] = useState("");
  // Guards async continuations after route replacement / back navigation. A
  // replaced chat screen can unmount while messages/read-status/presence requests
  // are still in flight; without this guard their `.then()` continuations can
  // still allocate objects and call setState on a dead conversation.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Docked in-app emoji keyboard + composer input handle.
  const {
    inputRef,
    emojiKeyboardOpen,
    emojiKeyboardHeight,
    toggleEmojiKeyboard,
    insertEmoji,
    emojiBackspace,
    onComposerInputFocus,
    onEmojiSearchFocus,
    onEmojiSearchBlur,
  } = useChatComposerKeyboard({
    setText,
    kbInset,
    windowHeight: winHeight,
  });

  // Header identity (name / avatar / group flag) + live peer presence + block.
  const {
    name,
    headerAvatar,
    isGroupConv,
    groupMemberAvatars,
    myGroupRole,
    groupDescription,
    peerUserId,
    peerStatus,
    peerWorkMode,
    participantCount,
    isBlocked,
    headerSubtitle,
    doToggleBlock,
  } = useChatPeerIdentity({
    convId,
    paramName: params.name,
    paramAvatar: params.avatar,
    paramPeerId: params.peerId,
    paramIsGroup: params.isGroup,
    paramGroupMemberAvatars: params.groupMemberAvatars,
    parsedGroupMemberAvatars,
    confirm,
  });

  const {
    selectedIds,
    selectedMessages,
    selectionMode,
    selectionAllOwn,
    selectedCount,
    clearSelection,
    toggleSelect,
    selectOnly,
  } = useChatMessageSelection(messages, user?.id);

  const {
    listRef,
    atBottomRef,
    initialReconcileTailAllowedRef,
    pendingTailScrollRef,
    scrollToEnd,
    onListLoad,
    requestTailScroll,
    onListScroll,
    onListInteraction,
    jumpToMessage,
  } = useChatThreadScroll({
    messages,
    messagesRef,
    mountedRef,
    allowInitialTailScroll: notificationMessageId == null,
  });

  // Long-press surfaces: the reaction bar/overlay, the action sheet target and
  // the emoji picker they share.
  const {
    reactTarget,
    setReactTarget,
    reactAnchor,
    setReactAnchor,
    actionTarget,
    setActionTarget,
    showAllEmoji,
    setShowAllEmoji,
    emojiMode,
    setEmojiMode,
    registerBubbleRef,
    react,
    pickEmoji,
    closeEmojiPicker,
    enterSelectionWith,
    openReactionBar,
    computeBarPosition,
    onReactionBarLayout,
  } = useChatMessageContextMenu({
    user,
    setMessages,
    setText,
    selectedIds,
    toggleSelect,
    selectOnly,
    windowWidth: winWidth,
    windowHeight: winHeight,
    insetTop: insets.top,
  });

  const {
    pinnedMsgs,
    setPinnedMsgs,
    latestPin,
    starredIds,
    setStarredIds,
    loadPinned,
    doPin,
    doStar,
    unpinFromBanner,
    pinSelected,
    saveSelected,
  } = useChatPinsAndStars({
    convId,
    setMessages,
    setActionTarget,
    selectedMessages,
    clearSelection,
    alert,
  });

  const {
    loading,
    hasMore,
    setHasMore,
    loadingOlder,
    setLoadingOlder,
    loadOlderError,
    setLoadOlderError,
    setLocallyDeleted,
    readReceipts,
    setReadReceipts,
    visibleMessages,
    loadOlder,
    markReadAndSync,
    messageGenerationRef,
    latestLoadRequestRef,
    olderRequestCursorRef,
  } = useChatMessageLoader({
    convId,
    user,
    messages,
    setMessages,
    messagesRef,
    mountedRef,
    initialCachedMessages,
    notificationMessageId,
    loadPinned,
    pendingTailScrollRef,
    initialReconcileTailAllowedRef,
  });

  // In-conversation search, the header 3-dot menu panels and Clear chat.
  const {
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
  } = useChatSearchPanels({
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
  });

  // Live socket stream for this conversation (messages, typing, receipts, pins).
  const { peerTyping } = useChatRealtimeSync({
    convId,
    user,
    router,
    setMessages,
    setPinnedMsgs,
    setReadReceipts,
    setHasMore,
    setLoadingOlder,
    setLoadOlderError,
    loadPinned,
    markReadAndSync,
    requestTailScroll,
    scrollToEnd,
    jumpToMessage,
    atBottomRef,
    pendingTailScrollRef,
    messageGenerationRef,
    latestLoadRequestRef,
    olderRequestCursorRef,
  });

  const {
    uploading,
    setUploading,
    plusOpen,
    setPlusOpen,
    cameraOpen,
    setCameraOpen,
    editorItems,
    setEditorItems,
    videoPreview,
    setVideoPreview,
    tenorOpen,
    setTenorOpen,
    tenorKind,
    mediaUploadControllers,
    mediaUploadSources,
    enqueueMediaUpload,
    attachFile,
    attachCamera,
    handleCameraPhoto,
    handleCameraVideo,
    sendVideoPreview,
    handlePickRecentMedia,
    handleMediaEditorSend,
    attachGifFromEmoji,
    attachStickerFromEmoji,
    pickTenorMedia,
    attachDocument,
    cancelMediaUpload,
    retryMediaUpload,
  } = useChatMediaUploads({
    convId,
    user,
    setMessages,
    requestTailScroll,
    alert,
  });

  const {
    isRecordingActive,
    recordingMillis,
    voiceHandleRef,
    startRecording,
    stopRecordingAndSend,
    cancelRecording,
    onRecorderDuration,
    onRecorderError,
    onRecorderStartFailed,
  } = useChatVoiceRecording({ alert, enqueueMediaUpload });

  const {
    replyTo,
    setReplyTo,
    editingId,
    setEditingId,
    send,
    retryFailedMessage,
    onChangeText,
    startReply,
    copyMessage,
    copySelected,
    cancelEdit,
    startEdit,
    saveEdit,
  } = useChatComposerActions({
    convId,
    user,
    text,
    setText,
    setMessages,
    inputRef,
    requestTailScroll,
    scrollToEnd,
    setReactTarget,
    setReactAnchor,
    setActionTarget,
    selectedMessages,
    clearSelection,
    mediaUploadControllers,
    mediaUploadSources,
    setUploading,
  });

  // Persist / restore the per-conversation composer draft (text, reply target,
  // pending edit and any picked media) across screen exits and app restarts.
  useMobileConversationDraft({
    conversationId: convId,
    user,
    messages,
    setMessages,
    text,
    setText,
    replyTo,
    setReplyTo,
    editingId,
    setEditingId,
    mediaUploadSources,
  });

  const {
    forwardMode,
    conversations,
    openForward,
    openForwardFor,
    closeActionSheet,
    doForward,
    forwardSelected,
  } = useChatForwardActions({
    actionTarget,
    setActionTarget,
    setReactTarget,
    setReactAnchor,
    selectedMessages,
    clearSelection,
    alert,
  });

  const {
    deleteTargets,
    deleteCanForEveryone,
    doDelete,
    closeDeleteSheet,
    deleteForEveryone,
    deleteForMe,
    deleteSelected,
  } = useChatDeleteActions({
    convId,
    user,
    setMessages,
    setLocallyDeleted,
    setReactTarget,
    setReactAnchor,
    setActionTarget,
    selectedMessages,
    clearSelection,
    alert,
  });

  const {
    goBackToChatList,
    openInfo,
    openSearchScreen,
    openSharedMedia,
    openPinnedScreen,
    openSavedScreen,
    startCall,
  } = useChatThreadNavigation({
    convId,
    name: name || "",
    headerAvatar: headerAvatar || "",
    peerUserId,
    isGroupConv,
    groupMemberAvatars,
    peerStatus: peerStatus || "",
    peerWorkMode: peerWorkMode || "",
    participantCount,
    myGroupRole,
    groupDescription,
    selectionMode,
    clearSelection,
    searchMode,
    closeSearch,
    alert,
  });

  const { rowMeta, readReceiptTimes, deliveryPhaseByKey, listExtraData } =
    useChatListPresentation({
      visibleMessages,
      readReceipts,
      participantCount,
      user,
      starredIds,
      selectedIds,
      highlightedId,
      selectionMode,
    });

  // Composer bottom inset (keyboard-aware).
  const composerBottomInset = Math.max(insets.bottom, kbInset) + 8;

  return {
    // identity / header
    name,
    headerAvatar,
    groupMemberAvatars,
    convId,
    isGroupConv,
    peerUserId,
    peerStatus,
    peerWorkMode,
    headerSubtitle,
    startCall,
    goBackToChatList,
    openHeaderPanel,
    // Signal-style overflow menu + navigation
    menuOpen,
    setMenuOpen,
    openInfo,
    openSearchScreen,
    openSharedMedia,
    openPinnedScreen,
    openSavedScreen,
    // Signal-style in-conversation search
    searchMode,
    searchQuery,
    searchMatchIds,
    searchActiveIdx,
    highlightedId,
    openSearch,
    closeSearch,
    onSearchQueryChange,
    searchPrev,
    searchNext,
    // list
    loading,
    messages,
    visibleMessages,
    rowMeta,
    deliveryPhaseByKey,
    listRef,
    listExtraData,
    scrollToEnd,
    onListLoad,
    onListInteraction,
    onListScroll,
    hasMore,
    loadOlder,
    loadingOlder,
    loadOlderError,
    // bubble
    user,
    starredIds,
    participantCount,
    readReceiptTimes,
    registerBubbleRef,
    openReactionBar,
    react,
    cancelMediaUpload,
    retryMediaUpload,
    // multi-select (Signal-style)
    selectedIds,
    selectionMode,
    selectionAllOwn,
    selectedCount,
    toggleSelect,
    clearSelection,
    enterSelectionWith,
    pinSelected,
    saveSelected,
    copySelected,
    forwardSelected,
    deleteSelected,
    // delete chooser (delete for everyone / delete for me)
    deleteTargets,
    deleteCanForEveryone,
    deleteForEveryone,
    deleteForMe,
    closeDeleteSheet,
    // typing / reply
    peerTyping,
    replyTo,
    setReplyTo,
    // pinned banner
    latestPin,
    pinnedMsgs,
    jumpToMessage,
    jumpToReply,
    unpinFromBanner,
    // composer
    text,
    editingId,
    uploading,
    recordingMillis,
    composerBottomInset,
    onChangeText,
    send,
    saveEdit,
    cancelEdit,
    setPlusOpen,
    startRecording,
    cancelRecording,
    stopRecordingAndSend,
    isRecordingActive,
    // voice recorder controller wiring (mounted only while recording)
    voiceHandleRef,
    onRecorderDuration,
    onRecorderError,
    onRecorderStartFailed,
    // inline emoji keyboard (Signal-style)
    inputRef,
    emojiKeyboardOpen,
    emojiKeyboardHeight,
    kbInset,
    toggleEmojiKeyboard,
    insertEmoji,
    emojiBackspace,
    onComposerInputFocus,
    onEmojiSearchFocus,
    onEmojiSearchBlur,
    // attachment picker
    plusOpen,
    attachCamera,
    attachFile,
    // in-app camera (Signal-style)
    cameraOpen,
    setCameraOpen,
    handleCameraPhoto,
    handleCameraVideo,
    handlePickRecentMedia,
    // video preview (review before send)
    videoPreview,
    setVideoPreview,
    sendVideoPreview,
    // media editor (Signal-style)
    editorItems,
    setEditorItems,
    handleMediaEditorSend,
    attachGifFromEmoji,
    attachStickerFromEmoji,
    tenorOpen,
    tenorKind,
    setTenorOpen,
    pickTenorMedia,
    attachDocument,
    setEmojiMode,
    setShowAllEmoji,
    // reaction bar / overlay
    reactTarget,
    reactAnchor,
    computeBarPosition,
    onReactionBarLayout,
    startReply,
    retryFailedMessage,
    copyMessage,
    openForwardFor,
    setReactTarget,
    setActionTarget,
    setReactAnchor,
    // emoji picker
    showAllEmoji,
    emojiMode,
    pickEmoji,
    closeEmojiPicker,
    // action sheet
    actionTarget,
    forwardMode,
    conversations,
    closeActionSheet,
    openForward,
    doForward,
    doStar,
    doPin,
    startEdit,
    doDelete,
    // header sheet
    headerSheet,
    sheetLoading,
    sheetSearchQ,
    sheetSearchResults,
    sharedFiles,
    savedMsgs,
    setHeaderSheet,
    onSheetSearchChange,
    jumpFromSheet,
    unstarFromSheet,
    doClearChat,
    // block user (Signal parity)
    isBlocked,
    doToggleBlock,
    // dialog
    dialog,
  };
}
