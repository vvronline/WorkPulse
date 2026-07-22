import {
  ActivityIndicator,
  InteractionManager,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { Modal } from "react-native";
import { Stack, useFocusEffect } from "expo-router";
import {
  ArrowLeft,
  Building2,
  ChevronDown,
  ChevronUp,
  Copy,
  Forward,
  House,
  MoreVertical,
  Phone,
  Pin,
  Star,
  Trash2,
  Video as VideoIcon,
  X,
} from "../../src/icons";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Animated, {
  FadeIn,
  FadeInRight,
  FadeOut,
  FadeOutLeft,
} from "react-native-reanimated";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import ChatAvatar from "../../src/components/ChatAvatar";
import GroupCompositeAvatar from "../../src/components/GroupCompositeAvatar";
import ReplyPreview from "../../src/components/chat/ReplyPreview";
import EditPreview from "../../src/components/chat/EditPreview";
import MessageBubble from "../../src/components/chat/MessageBubble";
import TypingIndicator from "../../src/components/chat/TypingIndicator";
import Composer from "../../src/components/chat/Composer";
import PinnedBanner from "../../src/components/chat/PinnedBanner";
import EmojiKeyboard from "../../src/components/chat/EmojiKeyboard";
import VoiceRecorderController from "../../src/components/chat/VoiceRecorderController";
import { useChatThread } from "../../src/components/chat/useChatThread";
import {
  fmtDaySeparator,
  isAudioFile,
  isImageFile,
  isVideoFile,
  WORK_MODE_LABEL,
} from "../../src/components/chat/chatUtils";

const ReactionOverlay = lazy(
  () => import("../../src/components/chat/ReactionOverlay"),
);
const EmojiPicker = lazy(() => import("../../src/components/chat/EmojiPicker"));
const TenorMediaPicker = lazy(
  () => import("../../src/components/chat/TenorMediaPicker"),
);
const AttachmentPicker = lazy(
  () => import("../../src/components/chat/AttachmentPicker"),
);
const MediaEditor = lazy(() => import("../../src/components/chat/MediaEditor"));
const DeleteOptionsSheet = lazy(
  () => import("../../src/components/chat/DeleteOptionsSheet"),
);
const MessageActionsSheet = lazy(
  () => import("../../src/components/chat/MessageActionsSheet"),
);
const HeaderMenuPopup = lazy(
  () => import("../../src/components/chat/HeaderMenuPopup"),
);
const CameraCapture = lazy(
  () => import("../../src/components/chat/CameraCapture"),
);
const VideoPreview = lazy(() => import("../../src/components/chat/VideoPreview"));

// Coloured dot next to the office/remote header badge (green = office,
// blue = remote, amber = hybrid). Mirrors the web ChatHeader.
const WORK_MODE_COLOR: Record<string, string> = {
  office: "#16a34a",
  remote: "#2563eb",
  hybrid: "#d97706",
};

// Status-dot colour for the left (presence) zone of the unified pill. Mirrors
// the web ChatHeader STATUS_DOT_COLOR.
const STATUS_DOT_COLOR: Record<string, string> = {
  available: "#22c55e",
  busy: "#ef4444",
  dnd: "#ef4444",
  brb: "#f59e0b",
  away: "#f59e0b",
  offline: "#94a3b8",
  in_call: "#ef4444",
  in_meeting: "#f59e0b",
};

/**
 * Chat thread ROUTE — Signal-Android "single active conversation" gate.
 *
 * ROOT-CAUSE FIX for the compounding "chat opens get slower / freeze after a
 * few opens" bug: the native stack can retain previously-visited `chat/[id]`
 * screens (blurred, but still MOUNTED). Each retained screen kept its own
 * `useChatThread` alive — a 3.6k-line hook that subscribes to the global
 * socket, holds the full message array, and runs effects/timers. With N chats
 * opened this session the JS thread + heap did ~N conversations' worth of work
 * on every socket event, so open #6 competed with 5 zombie threads → the 5–6s
 * freeze. `freezeOnBlur` only pauses RENDERING; it does NOT unsubscribe the
 * socket, clear timers, or free the arrays, so the leak survived it.
 *
 * The fix: mount the heavy conversation tree (`ConversationBody`, which is the
 * ONLY caller of `useChatThread`) ONLY while this route is focused. On blur we
 * unmount it, which runs every effect cleanup — socket `off()`, timer clears,
 * array GC — so at most ONE conversation is ever live, exactly like Signal's
 * single active `ConversationFragment`. On refocus it remounts and repaints
 * instantly from the MMKV cache (getCachedMessages), so the return is snappy.
 */
export default function ChatThread() {
  const [bodyMounted, setBodyMounted] = useState(true);
  const unmountTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusGeneration = useRef(0);

  useFocusEffect(
    useCallback(() => {
      focusGeneration.current += 1;
      if (unmountTimer.current) {
        clearTimeout(unmountTimer.current);
        unmountTimer.current = null;
      }
      // Mount synchronously on focus so warm cached threads paint immediately.
      // The previous next-frame gate caused a visible spinner and then a staged
      // bottom→top list paint even when MMKV already had the newest page.
      setBodyMounted(true);

      return () => {
        const blurGeneration = ++focusGeneration.current;
        // Keep the last painted chat content alive just long enough for native
        // back/pop gestures to finish, then tear down the heavy hook. The
        // generation guard prevents an old blur timer from unmounting a newly
        // focused/reopened chat.
        unmountTimer.current = setTimeout(() => {
          if (focusGeneration.current === blurGeneration) {
            unmountTimer.current = null;
            setBodyMounted(false);
          }
        }, 300);
      };
    }, []),
  );

  useEffect(
    () => () => {
      if (unmountTimer.current) clearTimeout(unmountTimer.current);
    },
    [],
  );

  return bodyMounted ? <ConversationBody /> : null;
}

/**
 * Chat thread body — a thin presentational orchestrator. All state, socket
 * effects and handlers live in the `useChatThread` hook (mirrors the web
 * ChatMessages container/hook split). The UI is composed from the chat
 * sub-components in `src/components/chat`. Mounted ONLY while the route is
 * focused (see ChatThread above) so exactly one conversation is ever live.
 */
function ConversationBody() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const c = useChatThread();
  const [threadBodyReady, setThreadBodyReady] = useState(false);

  useEffect(() => {
    setThreadBodyReady(false);
    let raf = 0;
    const task = InteractionManager.runAfterInteractions(() => {
      // Let navigation/header paint first on a TRUE cold thread. Cached threads
      // bypass this gate below and render immediately from MMKV, matching
      // Signal/WhatsApp's cache-first open path.
      raf = requestAnimationFrame(() => setThreadBodyReady(true));
    });
    return () => {
      task.cancel();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [c.convId]);

  const hasCachedRows = c.visibleMessages.length > 0;
  const showInitialSpinner = c.loading && !hasCachedRows;
  const canRenderThread = hasCachedRows || threadBodyReady || !c.loading;

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={
          c.selectionMode
            ? {
                // Signal-style selection action bar: a back/X to clear the
                // selection + the selected count on the left, and the message
                // actions (pin / save / forward / copy / delete) as icons on
                // the right. Operates on the whole selection.
                headerTitle: () => (
                  <Text style={styles.headerTitleText} numberOfLines={1}>
                    {c.selectedCount} selected
                  </Text>
                ),
                headerLeft: () => (
                  <Pressable onPress={c.clearSelection} hitSlop={8}>
                    <X size={22} color={theme.text} />
                  </Pressable>
                ),
                headerRight: () => (
                  <View style={styles.headerActions}>
                    <Pressable onPress={c.pinSelected} hitSlop={8}>
                      <Pin size={20} color={theme.text} />
                    </Pressable>
                    <Pressable onPress={c.saveSelected} hitSlop={8}>
                      <Star size={20} color={theme.text} />
                    </Pressable>
                    <Pressable onPress={c.forwardSelected} hitSlop={8}>
                      <Forward size={20} color={theme.text} />
                    </Pressable>
                    <Pressable onPress={c.copySelected} hitSlop={8}>
                      <Copy size={20} color={theme.text} />
                    </Pressable>
                    {/* Delete is always available: mixed (mine + theirs)
                        selections can be deleted for me, own-only selections
                        also offer delete for everyone (handled in the sheet). */}
                    <Pressable onPress={c.deleteSelected} hitSlop={8}>
                      <Trash2 size={20} color={theme.danger} />
                    </Pressable>
                  </View>
                ),
              }
            : c.searchMode
              ? {
                  // Signal in-conversation search: the header becomes a search
                  // field with a back arrow (exit) and a clear "X". Match
                  // count + up/down navigation stay inline in the same row.
                  headerTitleAlign: "left",
                  headerTitle: () => (
                    <Animated.View
                      entering={FadeInRight.duration(170)}
                      exiting={FadeOutLeft.duration(120)}
                      style={styles.searchHeader}
                    >
                      <TextInput
                        style={styles.searchInput}
                        placeholder="Search this chat…"
                        placeholderTextColor={theme.textMuted}
                        value={c.searchQuery}
                        onChangeText={c.onSearchQueryChange}
                        autoFocus
                        returnKeyType="search"
                      />
                      {c.searchQuery.length > 0 ? (
                        <Pressable
                          onPress={() => c.onSearchQueryChange("")}
                          hitSlop={8}
                        >
                          <X size={18} color={theme.textSecondary} />
                        </Pressable>
                      ) : null}
                    </Animated.View>
                  ),
                  headerLeft: () => (
                    <Pressable onPress={c.closeSearch} hitSlop={8}>
                      <ArrowLeft size={22} color={theme.text} />
                    </Pressable>
                  ),
                  headerRight: () => (
                    <Animated.View
                      entering={FadeIn.duration(160)}
                      exiting={FadeOut.duration(100)}
                      style={styles.searchHeaderActions}
                    >
                      <Text style={styles.searchInlineCount}>
                        {c.searchMatchIds.length > 0
                          ? `${c.searchActiveIdx + 1}/${c.searchMatchIds.length}`
                          : c.searchQuery.trim().length < 2
                            ? "Type"
                            : "No"}
                      </Text>
                      <Pressable
                        onPress={c.searchPrev}
                        hitSlop={8}
                        disabled={
                          c.searchMatchIds.length === 0 || c.searchActiveIdx <= 0
                        }
                        style={styles.searchHeaderBtn}
                      >
                        <ChevronUp
                          size={20}
                          color={
                            c.searchMatchIds.length === 0 || c.searchActiveIdx <= 0
                              ? theme.textMuted
                              : theme.text
                          }
                        />
                      </Pressable>
                      <Pressable
                        onPress={c.searchNext}
                        hitSlop={8}
                        disabled={
                          c.searchMatchIds.length === 0 ||
                          c.searchActiveIdx >= c.searchMatchIds.length - 1
                        }
                        style={styles.searchHeaderBtn}
                      >
                        <ChevronDown
                          size={20}
                          color={
                            c.searchMatchIds.length === 0 ||
                            c.searchActiveIdx >= c.searchMatchIds.length - 1
                              ? theme.textMuted
                              : theme.text
                          }
                        />
                      </Pressable>
                    </Animated.View>
                  ),
                }
              : {
                  title: c.name || "Chat",
                  // Render our own deterministic up button instead of relying on
                  // native-stack to restore its default back button after the
                  // selection/search headers override `headerLeft`. If this
                  // thread was opened as a cold-start root route, the handler
                  // falls back to the chat tab instead of exiting the app.
                  headerLeft: () => (
                    <Pressable
                      style={styles.headerBackButton}
                      onPress={c.goBackToChatList}
                      hitSlop={8}
                    >
                      <ArrowLeft size={22} color={theme.primary} />
                    </Pressable>
                  ),
                  headerTitle: () => (
                    // Signal-style: tapping the title/avatar opens the
                    // conversation profile (Conversation Settings) screen.
                    <Pressable
                      style={styles.headerTitleWrap}
                      onPress={c.openInfo}
                      hitSlop={6}
                    >
                      {c.isGroupConv ? (
                        <GroupCompositeAvatar
                          name={c.name}
                          avatar={c.headerAvatar}
                          memberAvatars={c.groupMemberAvatars}
                          size={32}
                        />
                      ) : (
                        <ChatAvatar
                          name={c.name}
                          avatar={c.headerAvatar}
                          size={32}
                          userStatus={c.peerUserId ? c.peerStatus : undefined}
                          ringColor={theme.bg}
                        />
                      )}
                      <View style={{ flexShrink: 1 }}>
                        <Text style={styles.headerTitleText} numberOfLines={1}>
                          {c.name || "Chat"}
                        </Text>
                        {(() => {
                          // Unified presence pill: left zone = live status,
                          // right zone = work mode, separated by a thin
                          // divider (mirrors the web ChatHeader).
                          const hasWorkMode = Boolean(
                            !c.isGroupConv &&
                              c.peerWorkMode &&
                              WORK_MODE_LABEL[c.peerWorkMode],
                          );
                          const statusText = c.headerSubtitle;
                          const dotColor = c.isGroupConv
                            ? null
                            : c.peerStatus
                              ? STATUS_DOT_COLOR[c.peerStatus] ||
                                STATUS_DOT_COLOR.available
                              : null;
                          if (!statusText && !hasWorkMode) return null;
                          return (
                            <View style={styles.presencePill}>
                              {statusText ? (
                                <View style={styles.presenceStatus}>
                                  {dotColor ? (
                                    <View
                                      style={[
                                        styles.statusDot,
                                        { backgroundColor: dotColor },
                                      ]}
                                    />
                                  ) : null}
                                  <Text
                                    style={styles.presenceStatusText}
                                    numberOfLines={1}
                                  >
                                    {statusText}
                                  </Text>
                                </View>
                              ) : null}
                              {statusText && hasWorkMode ? (
                                <View style={styles.presenceDivider} />
                              ) : null}
                              {hasWorkMode ? (
                                <View style={styles.presenceWorkMode}>
                                  {c.peerWorkMode === "remote" ? (
                                    <House
                                      size={11}
                                      color={
                                        WORK_MODE_COLOR[c.peerWorkMode] ||
                                        "#16a34a"
                                      }
                                    />
                                  ) : (
                                    <Building2
                                      size={11}
                                      color={
                                        WORK_MODE_COLOR[
                                          c.peerWorkMode as string
                                        ] || "#16a34a"
                                      }
                                    />
                                  )}
                                  <Text
                                    style={[
                                      styles.presenceWorkModeText,
                                      {
                                        color:
                                          WORK_MODE_COLOR[
                                            c.peerWorkMode as string
                                          ] || "#16a34a",
                                      },
                                    ]}
                                    numberOfLines={1}
                                  >
                                    {WORK_MODE_LABEL[c.peerWorkMode as string]}
                                  </Text>
                                </View>
                              ) : null}
                            </View>
                          );
                        })()}
                      </View>
                    </Pressable>
                  ),
                  // Voice/video call buttons. Shown for 1:1 AND group chats —
                  // the native call screen is single-remote-peer (first member
                  // to answer connects), exactly mirroring the web ChatHeader,
                  // which also enables calls for groups. Search lives ONLY in
                  // the 3-dot overflow menu (search / pinned / files / saved /
                  // clear chat) — the duplicate header search icon was removed.
                  headerRight: () => (
                    <View style={styles.headerActions}>
                      <Pressable
                        onPress={() => c.startCall("voice")}
                        hitSlop={8}
                      >
                        <Phone size={20} color={theme.primary} />
                      </Pressable>
                      <Pressable
                        onPress={() => c.startCall("video")}
                        hitSlop={8}
                      >
                        <VideoIcon size={20} color={theme.primary} />
                      </Pressable>
                      <Pressable
                        onPress={() => c.setMenuOpen(true)}
                        hitSlop={8}
                      >
                        <MoreVertical size={20} color={theme.text} />
                      </Pressable>
                    </View>
                  ),
                }
        }
      />
      {showInitialSpinner || !canRenderThread ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.primary} />
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          {/* Pinned-messages banner at the top of the chat. */}
          {c.latestPin ? (
            <PinnedBanner
              latestPin={c.latestPin}
              count={c.pinnedMsgs.length}
              onJump={c.jumpToMessage}
              onUnpin={c.unpinFromBanner}
            />
          ) : null}

          <ChatList c={c} styles={styles} theme={theme} />

          {c.peerTyping ? (
            <TypingIndicator name={c.name} avatar={c.headerAvatar} />
          ) : null}
          {/* Editing strip (Signal-style) — shown while a message is being
              edited so there's a clear "Editing message" indication + a way to
              cancel. Takes precedence over the reply strip (editing clears any
              pending reply). */}
          {c.editingId != null ? (
            <EditPreview text={c.text} onCancel={c.cancelEdit} />
          ) : c.replyTo ? (
            /* Reply composing strip */
            <ReplyPreview
              replyTo={c.replyTo}
              onCancel={() => c.setReplyTo(null)}
            />
          ) : null}
          {c.isBlocked && !c.isGroupConv ? (
            <View
              style={{
                paddingVertical: 14,
                paddingHorizontal: 16,
                alignItems: "center",
                gap: 10,
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: theme.glassBorder,
              }}
            >
              <Text style={{ color: theme.textSecondary, fontSize: 13, textAlign: "center" }}>
                You blocked this user. Unblock to send messages.
              </Text>
              <Pressable
                onPress={c.doToggleBlock}
                style={{
                  backgroundColor: theme.primary,
                  borderRadius: 8,
                  paddingVertical: 8,
                  paddingHorizontal: 18,
                }}
              >
                <Text style={{ color: "#fff", fontWeight: "600", fontSize: 13 }}>
                  Unblock
                </Text>
              </Pressable>
            </View>
          ) : (
          <Composer
            ref={c.inputRef}
            text={c.text}
            editing={c.editingId != null}
            uploading={c.uploading}
            // Driven purely by the recording flag now that the native recorder
            // lives in <VoiceRecorderController> (mounted only while recording),
            // instead of an always-mounted recorder-state poll.
            isRecording={c.isRecordingActive}
            recordingMillis={c.recordingMillis}
            bottomInset={c.emojiKeyboardOpen ? 8 : c.composerBottomInset}
            emojiKeyboardOpen={c.emojiKeyboardOpen}
            onChangeText={c.onChangeText}
            onSend={c.send}
            onSaveEdit={c.saveEdit}
            onOpenCamera={c.attachCamera}
            onOpenAttach={() => c.setPlusOpen(true)}
            onToggleEmojiKeyboard={c.toggleEmojiKeyboard}
            onInputFocus={c.onComposerInputFocus}
            onStartRecording={c.startRecording}
            onCancelRecording={c.cancelRecording}
            onStopAndSend={c.stopRecordingAndSend}
          />
          )}
          {/* Docked in-app emoji keyboard (shown in place of the system
              keyboard when the composer's emoji toggle is active). */}
          <EmojiKeyboard
            visible={c.emojiKeyboardOpen}
            height={c.emojiKeyboardHeight}
            onPick={c.insertEmoji}
            onBackspace={c.emojiBackspace}
            onOpenGif={c.attachGifFromEmoji}
            onOpenSticker={c.attachStickerFromEmoji}
            onSearchFocus={c.onEmojiSearchFocus}
            onSearchBlur={c.onEmojiSearchBlur}
          />
          {/* Voice recorder (headless): mounted ONLY while recording so opening
              a conversation never initializes the native audio recorder. Owns
              the recorder + auto-starts on mount; the composer's stop/cancel
              buttons drive it through the imperative handle. */}
          {c.isRecordingActive ? (
            <VoiceRecorderController
              handleRef={c.voiceHandleRef}
              onDuration={c.onRecorderDuration}
              onError={c.onRecorderError}
              onStartFailed={c.onRecorderStartFailed}
            />
          ) : null}
        </View>
      )}

      {/* "+" composer menu — recent-media strip + Photo + File/Document
          (Signal-style AttachmentKeyboard). Voice + Emoji are NOT here: they
          live in the composer itself (the Mic send-button and the inline emoji
          toggle), so duplicating them in this sheet was redundant. */}
      {c.plusOpen ? (
        <Suspense fallback={null}>
          <AttachmentPicker
            visible={c.plusOpen}
            onClose={() => c.setPlusOpen(false)}
            onPhoto={c.attachFile}
            onDocument={c.attachDocument}
            onPickRecent={c.handlePickRecentMedia}
            onOpenCamera={c.attachCamera}
          />
        </Suspense>
      ) : null}

      {/* Signal-style full-screen in-app camera (tap=photo, hold=video, flip,
          flash, recent-gallery strip). Rendered as a full-screen Modal so it
          covers the chat while open. Captures route back through the hook:
          photos → MediaEditor, videos/recent-gallery → upload. */}
      {c.cameraOpen ? (
        <Modal
          visible={c.cameraOpen}
          animationType="slide"
          onRequestClose={() => c.setCameraOpen(false)}
          statusBarTranslucent
        >
          <Suspense fallback={null}>
            <CameraCapture
              active={c.cameraOpen}
              onClose={() => c.setCameraOpen(false)}
              onCapturedPhoto={c.handleCameraPhoto}
              onCapturedVideo={c.handleCameraVideo}
              onPickRecent={c.handlePickRecentMedia}
              onOpenGallery={c.attachFile}
            />
          </Suspense>
        </Modal>
      ) : null}

      {/* Signal-style media editor — opened after capturing/picking an image.
          Provides pen/crop/rotate/quality/view-once + caption before send. */}
      {c.editorItems ? (
        <Suspense fallback={null}>
          <MediaEditor
            initialItems={c.editorItems}
            onSend={c.handleMediaEditorSend}
            onClose={() => c.setEditorItems(null)}
          />
        </Suspense>
      ) : null}

      {/* Video review screen — opened after recording/picking a video. Lets the
          user watch, caption, set view-once, and Send or discard (instead of
          firing the upload the instant the shutter is released). */}
      {c.videoPreview ? (
        <Suspense fallback={null}>
          <VideoPreview
            uri={c.videoPreview.uri}
            onSend={c.sendVideoPreview}
            onClose={() => c.setVideoPreview(null)}
          />
        </Suspense>
      ) : null}

      {/* Long-press message context menu (Signal / WhatsApp / Telegram style):
          a reaction pill PLUS a per-message action list, over a dim scrim.
          Long-press no longer enters multi-select mode — "Select" here does,
          cleanly separating "react/act on this message" from "select messages".
          Hidden while the full emoji picker is open so the picker isn't stuck
          BEHIND this Modal — but `reactTarget` stays alive so the chosen emoji
          is still applied to the right message. */}
      {!!c.reactTarget && !c.showAllEmoji ? (
        <Suspense fallback={null}>
          <ReactionOverlay
            visible={!!c.reactTarget && !c.showAllEmoji}
            anchor={c.reactAnchor}
            message={c.reactTarget}
            isOwn={Number(c.reactTarget?.sender_id) === Number(c.user?.id)}
            isStarred={!!c.reactTarget && c.starredIds.has(c.reactTarget.id)}
            isPinned={!!c.reactTarget?.pinned_at}
            userId={c.user?.id}
            onReact={(emoji) => c.reactTarget && c.react(c.reactTarget, emoji)}
            onOpenAllEmoji={() => {
              c.setEmojiMode("react");
              c.setShowAllEmoji(true);
            }}
            onReply={() => c.reactTarget && c.startReply(c.reactTarget)}
            onForward={() => c.reactTarget && c.openForwardFor(c.reactTarget)}
            onCopy={() => c.reactTarget && c.copyMessage(c.reactTarget)}
            onSave={() => {
              const m = c.reactTarget;
              c.setReactTarget(null);
              c.setReactAnchor(null);
              if (m) c.doStar(m);
            }}
            onPin={() => {
              const m = c.reactTarget;
              c.setReactTarget(null);
              c.setReactAnchor(null);
              if (m) c.doPin(m);
            }}
            onEdit={() => c.reactTarget && c.startEdit(c.reactTarget)}
            onSelect={() => c.reactTarget && c.enterSelectionWith(c.reactTarget)}
            onDelete={() => c.reactTarget && c.doDelete(c.reactTarget)}
            onClose={() => {
              c.setReactTarget(null);
              c.setReactAnchor(null);
            }}
          />
        </Suspense>
      ) : null}

      {/* Full emoji grid (opened from "All Emoji" or the composer "+").
          Closing in "react" mode also clears the long-pressed target so the
          reaction overlay (hidden only while this picker is open) doesn't pop
          back up. */}
      {c.showAllEmoji ? (
        <Suspense fallback={null}>
          <EmojiPicker
            visible={c.showAllEmoji}
            mode={c.emojiMode}
            onPick={c.pickEmoji}
            onClose={c.closeEmojiPicker}
          />
        </Suspense>
      ) : null}

      {c.tenorOpen ? (
        <Suspense fallback={null}>
          <TenorMediaPicker
            visible={c.tenorOpen}
            kind={c.tenorKind}
            onClose={() => c.setTenorOpen(false)}
            onPick={(item) => c.pickTenorMedia(item, c.tenorKind)}
          />
        </Suspense>
      ) : null}

      {/* Message action sheet (forward / save / pin / edit / delete). */}
      {c.actionTarget || c.forwardMode ? (
        <Suspense fallback={null}>
          <MessageActionsSheet
            target={c.actionTarget}
            forwardMode={c.forwardMode}
            conversations={c.conversations}
            convId={c.convId}
            isOwn={Number(c.actionTarget?.sender_id) === Number(c.user?.id)}
            isStarred={!!c.actionTarget && c.starredIds.has(c.actionTarget.id)}
            onClose={c.closeActionSheet}
            onForwardOpen={c.openForward}
            onForwardTo={c.doForward}
            onStar={() => c.actionTarget && c.doStar(c.actionTarget)}
            onPin={() => c.actionTarget && c.doPin(c.actionTarget)}
            onEdit={() => c.actionTarget && c.startEdit(c.actionTarget)}
            onDelete={() => c.actionTarget && c.doDelete(c.actionTarget)}
          />
        </Suspense>
      ) : null}

      {/* Delete chooser — "Delete for everyone" (own messages) / "Delete for
          me" (local hide). Drives both single-message and multi-select deletes. */}
      {c.deleteTargets ? (
        <Suspense fallback={null}>
          <DeleteOptionsSheet
            visible={!!c.deleteTargets}
            count={c.deleteTargets?.length ?? 0}
            canDeleteForEveryone={c.deleteCanForEveryone}
            onDeleteForEveryone={c.deleteForEveryone}
            onDeleteForMe={c.deleteForMe}
            onClose={c.closeDeleteSheet}
          />
        </Suspense>
      ) : null}

      {/* Header 3-dot overflow menu (Signal-style, top-anchored popup). Items
          navigate to the dedicated profile sub-screens (search / shared media /
          pinned / saved) instead of opening cramped bottom-sheet panels. */}
      {c.menuOpen ? (
        <Suspense fallback={null}>
          <HeaderMenuPopup
            visible={c.menuOpen}
            onClose={() => c.setMenuOpen(false)}
            onSearch={c.openSearch}
            onPinned={c.openPinnedScreen}
            onSharedMedia={() => c.openSharedMedia("media")}
            onSaved={c.openSavedScreen}
            onClearChat={c.doClearChat}
            onToggleBlock={
              !c.isGroupConv && c.peerUserId ? c.doToggleBlock : undefined
            }
            isBlocked={c.isBlocked}
          />
        </Suspense>
      ) : null}

      {c.dialog}
    </View>
  );
}

/**
 * Messages FlatList. Split out so the screen body stays readable. The
 * `extraData`, `removeClippedSubviews={false}` and `maintainVisibleContentPosition`
 * settings are load-bearing — see the inline comments.
 */
import type { ChatMessage } from "../../src/features";
import CallSystemMessage from "../../src/components/chat/CallSystemMessage";

const messageKeyExtractor = (message: ChatMessage) =>
  message.clientMsgId ?? String(message.id);

function ChatList({
  c,
  styles,
  theme,
}: {
  c: ReturnType<typeof useChatThread>;
  styles: ReturnType<typeof makeStyles>;
  theme: Theme;
}) {
  // Signal-style "scroll to bottom" pill. Once the user scrolls up past a threshold a
  // floating chevron fades in; tapping it smooth-scrolls back to the newest
  // message.
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const showScrollBtnRef = useRef(false);
  // Read changing pagination values through a ref so the native scroll callback
  // and start-reached callback keep one identity while pages update around them.
  const scrollModelRef = useRef({
    hasMore: c.hasMore,
    loadingOlder: c.loadingOlder,
    loadOlderError: c.loadOlderError,
    loadOlder: c.loadOlder,
    onListScroll: c.onListScroll,
  });
  scrollModelRef.current = {
    hasMore: c.hasMore,
    loadingOlder: c.loadingOlder,
    loadOlderError: c.loadOlderError,
    loadOlder: c.loadOlder,
    onListScroll: c.onListScroll,
  };

  // Gate the per-bubble FadeIn/LinearTransition animations. They stay OFF for
  // the initial render so opening the conversation paints the whole visible
  // thread at once and slides in cleanly (no per-row fade flicker fighting the
  // navigation transition — the old cause of the laggy/flickery open). Once the
  // open transition settles we flip this ON so genuinely new messages still
  // fade into place, matching Signal-Android.
  const [entryAnimReady, setEntryAnimReady] = useState(false);
  useEffect(() => {
    // Flip the per-bubble layout/enter animations ON only AFTER the open
    // transition has fully settled AND one extra frame past the first idle
    // frame. The hook's `load()` network reconcile also runs on that first idle
    // frame (via its own InteractionManager); if `LinearTransition` were enabled
    // in the SAME frame the reconcile's `setMessages` commits, every visible row
    // would animate its layout at once — the "settle"/stutter right after the
    // chat opens. Waiting an extra rAF lets the reconcile paint statically first,
    // then we arm the animations so only genuinely new incoming/sent messages
    // animate (Signal-Android feel).
    let raf = 0;
    const task = InteractionManager.runAfterInteractions(() => {
      raf = requestAnimationFrame(() => setEntryAnimReady(true));
    });
    return () => {
      task.cancel();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // Signal-Android parity: a STABLE, memoized row renderer. Defining renderItem
  // inline created a NEW function identity on every ChatList render, which
  // defeated FlatList's ability to skip re-rendering unchanged cells and forced
  // every visible row to reconcile on each parent render (scroll, typing pulse,
  // receipt update…). The consecutive-grouping + day-divider math it used to do
  // per row (two `new Date(...)` parses each) is now precomputed ONCE per page in
  // the hook (`c.rowMeta`) and looked up here in O(1) — mirroring how Signal's
  // ConversationAdapter resolves presentation when a page is built, not on bind.
  const { rowMeta, deliveryPhaseByKey, visibleMessages, user, starredIds } = c;
  // Identity of the NEWEST message. Only this row
  // is allowed to play the FadeIn enter animation — see the comment in
  // MessageBubble. Gating on the newest id (instead of a global `entryAnimReady`
  // flag applied to every row) means recycled rows scrolling into the FlatList
  // window never replay their fade, which — combined with removing the per-row
  // LinearTransition spring — kills the recursive Reanimated frame flood.
  const newestKey =
    visibleMessages.length > 0
      ? (visibleMessages[visibleMessages.length - 1].clientMsgId ??
        String(visibleMessages[visibleMessages.length - 1].id))
      : null;
  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const model = scrollModelRef.current;

      const distanceFromBottom = Math.max(
        0,
        contentSize.height - layoutMeasurement.height - contentOffset.y,
      );
      // This ref-only write is the only work required every frame.
      model.onListScroll(distanceFromBottom);

      const shouldShow = distanceFromBottom > 400;
      if (shouldShow !== showScrollBtnRef.current) {
        showScrollBtnRef.current = shouldShow;
        setShowScrollBtn(shouldShow);
      }
    },
    [],
  );

  const handleStartReached = useCallback(() => {
    const model = scrollModelRef.current;
    // After a network error, avoid an automatic retry loop while the list stays
    // at the edge. The header remains a deliberate tap-to-retry control.
    if (model.hasMore && !model.loadingOlder && !model.loadOlderError) {
      void model.loadOlder();
    }
  }, []);

  const maintainVisiblePosition = useMemo(
    () => ({
      startRenderingFromBottom: true,
    }),
    [],
  );
  const getMessageType = useCallback((item: ChatMessage) => {
    if (item.format_type === "system") {
      return item.metadata?.type === "call" ? "call" : "system";
    }
    // Separate structurally different attachment trees into their own recycling
    // pools. Rebinding a video/player cell as a tiny document/text row causes
    // avoidable layout churn and visible blanking during fast flings.
    if (item.file_url) {
      if (item.metadata?.viewOnce) return "view-once";
      if (isImageFile(item)) return "image";
      if (isVideoFile(item)) return "video";
      if (isAudioFile(item)) return "audio";
      return "file";
    }
    return "text";
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: ChatMessage }) => {
      const mine = Number(item.sender_id) === Number(user?.id);
      const key = item.clientMsgId ?? String(item.id);
      const meta = rowMeta.get(key);
      const firstInGroup = meta?.firstInGroup ?? true;
      const lastInGroup = meta?.lastInGroup ?? true;
      const showDaySeparator = meta?.showDaySeparator ?? false;
      // Only the newest message animates its entrance (Signal/WhatsApp: only the
      // just-arrived item animates, never every visible row).
      const isNewest = key === newestKey;

      // Inline call-history row (Signal parity): a `system` message whose
      // metadata describes a call renders as a centred call event instead
      // of a chat bubble.
      if (item.format_type === "system" && item.metadata?.type === "call") {
        return (
          <View>
            {showDaySeparator ? (
              <View style={styles.daySeparator}>
                <View style={styles.dayPill}>
                  <Text style={styles.dayPillText}>
                    {fmtDaySeparator(item.created_at)}
                  </Text>
                </View>
              </View>
            ) : null}
            <CallSystemMessage
              message={item}
              userId={user?.id}
              onCallBack={c.startCall}
            />
          </View>
        );
      }
      // Group activity tombstone (Phase 1): member added/removed/left,
      // renamed, role changed, ownership transferred, etc. Any non-call
      // system message renders as a centred grey pill.
      if (item.format_type === "system") {
        const label = (item.metadata?.text as string) || item.content || "";
        return (
          <View>
            {showDaySeparator ? (
              <View style={styles.daySeparator}>
                <View style={styles.dayPill}>
                  <Text style={styles.dayPillText}>
                    {fmtDaySeparator(item.created_at)}
                  </Text>
                </View>
              </View>
            ) : null}
            <View style={styles.sysWrap}>
              <Text style={styles.sysText}>{label}</Text>
            </View>
          </View>
        );
      }
      return (
        <View>
          {showDaySeparator ? (
            <View style={styles.daySeparator}>
              <View style={styles.dayPill}>
                <Text style={styles.dayPillText}>
                  {fmtDaySeparator(item.created_at)}
                </Text>
              </View>
            </View>
          ) : null}
          <MessageBubble
            message={item}
            mine={mine}
            deleted={!!item.deleted_at}
            starred={starredIds.has(item.id)}
            pinned={!!item.pinned_at}
            deliveryPhase={deliveryPhaseByKey.get(key) ?? "sent"}
            userId={user?.id}
            firstInGroup={firstInGroup}
            lastInGroup={lastInGroup}
            highlighted={c.highlightedId === item.id}
            selected={c.selectedIds.has(item.id)}
            selectionActive={c.selectionMode}
            registerRef={c.registerBubbleRef}
            onLongPress={c.openReactionBar}
            onPressSelect={c.toggleSelect}
            onReact={c.react}
            onAddReaction={c.openReactionBar}
            onReply={c.startReply}
            onRetry={c.retryFailedMessage}
            onCancelUpload={c.cancelMediaUpload}
            onRetryUpload={c.retryMediaUpload}
            onJumpToReply={c.jumpToReply}
            animateEntry={entryAnimReady && isNewest}
          />
        </View>
      );
    },
    // c is a stable object of refs/callbacks from the hook; listing the fields
    // actually read keeps the row renderer identity stable across scrolls while
    // still updating when selection/highlight/receipt state changes.
    [
      rowMeta,
      deliveryPhaseByKey,
      newestKey,
      user?.id,
      starredIds,
      entryAnimReady,
      c.highlightedId,
      c.selectedIds,
      c.selectionMode,
      c.registerBubbleRef,
      c.openReactionBar,
      c.toggleSelect,
      c.react,
      c.startReply,
      c.retryFailedMessage,
      c.cancelMediaUpload,
      c.retryMediaUpload,
      c.jumpToReply,
      c.startCall,
      styles,
    ],
  );

  return (
    <View style={styles.listWrap}>
      <FlashList
        ref={c.listRef as React.RefObject<FlashListRef<ChatMessage>>}
        data={c.visibleMessages}
        // Messages are oldest-first, so FlashList's default index 0 opens a long
        // conversation at its oldest loaded row. `startRenderingFromBottom`
        // bottom-aligns short content but does not select the tail of a
        // scrollable variable-height list. Start at the final visible row on
        // mount; FlashList clamps it to the bottom, making the latest message
        // visible immediately while leaving later history prepends untouched.
        initialScrollIndex={Math.max(0, c.visibleMessages.length - 1)}
        extraData={c.listExtraData}
        // Stable row identity across the optimistic→confirmed swap. An optimistic
        // message starts with a temporary NEGATIVE id; when the server confirms it
        // over the socket the row is replaced with the positive server id. Keying
        // by `id` alone changed the key on that swap → FlatList unmounted the old
        // row and mounted a new one, replaying the bubble's FadeIn entering
        // animation (the visible "blink"/settle on send). The confirmed message
        // keeps the same `clientMsgId`, so keying by it first keeps ONE row
        // instance that updates in place — no remount, no second animation
        // (Signal keeps a single view from "sending" through "sent").
        keyExtractor={messageKeyExtractor}
        // `flex: 1` is load-bearing: without it the FlatList doesn't claim the
        // available column height.
        style={styles.listFlex}
        contentContainerStyle={styles.list}
        // Track scroll distance from the visual bottom. Show the button once the user has scrolled up
        // past ~1.5 screens of history.
        onScroll={handleScroll}
        // `initialScrollIndex` can run before variable-height rows are measured.
        // Once FlashList reports its first draw, the hook performs the reliable
        // non-animated tail correction for a normal chat open.
        onLoad={c.onListLoad}
        // Respect immediate user intent: if they drag during opening, neither the
        // first-layout nor background-reconcile correction may pull them down.
        onScrollBeginDrag={c.cancelInitialTailScroll}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onStartReached={handleStartReached}
        // Start fetching before a fast upward fling reaches the loaded boundary.
        onStartReachedThreshold={0.8}
        // Media/reply/reaction rows are expensive and highly variable in height;
        // render roughly 1–2 phone screens ahead to avoid outrunning the recycler.
        drawDistance={1000}
        maintainVisibleContentPosition={maintainVisiblePosition}
        getItemType={getMessageType}
        ListHeaderComponent={
          c.hasMore ? (
            <Pressable
              style={styles.loadOlderBtn}
              onPress={c.loadOlder}
              disabled={c.loadingOlder}
            >
              {c.loadingOlder ? (
                <ActivityIndicator size="small" color={theme.primary} />
              ) : (
                <View style={styles.loadOlderContent}>
                  <Text style={styles.loadOlderText}>
                    {c.loadOlderError
                      ? "Retry loading earlier messages"
                      : "Load earlier messages"}
                  </Text>
                  {c.loadOlderError ? (
                    <Text style={styles.loadOlderError}>
                      {c.loadOlderError}
                    </Text>
                  ) : null}
                </View>
              )}
            </Pressable>
          ) : null
        }
        renderItem={renderItem}
      />
      {/* Floating "scroll to latest" pill (Signal-style). Fades in/out and
          smooth-scrolls to the newest message when tapped. */}
      {showScrollBtn ? (
        <Animated.View
          entering={FadeIn.duration(160)}
          exiting={FadeOut.duration(160)}
          style={styles.scrollBtnWrap}
          pointerEvents="box-none"
        >
          <Pressable
            style={styles.scrollBtn}
            onPress={() => c.scrollToEnd(true)}
            hitSlop={8}
          >
            <ChevronDown size={22} color={theme.text} />
          </Pressable>
        </Animated.View>
      ) : null}
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      width: "100%",
      backgroundColor: theme.bg,
      overflow: "hidden",
    },
    center: { flex: 1, alignItems: "center", justifyContent: "center" },
    headerActions: { flexDirection: "row", gap: 14, alignItems: "center" },
    headerBackButton: {
      width: 44,
      height: 40,
      alignItems: "flex-start",
      justifyContent: "center",
      marginRight: 8,
    },
    headerTitleWrap: { flexDirection: "row", alignItems: "center", gap: 10 },
    // Signal in-conversation search: header field + bottom match-nav bar.
    searchHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      flex: 1,
      minWidth: 0,
    },
    searchInput: {
      flex: 1,
      fontSize: 16,
      color: theme.text,
      paddingVertical: 4,
      fontFamily: theme.fontRegular,
    },
    searchHeaderActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    searchInlineCount: {
      fontSize: 11,
      color: theme.textMuted,
      fontFamily: theme.fontMedium,
      minWidth: 28,
      textAlign: "right",
    },
    searchHeaderBtn: {
      width: 28,
      height: 28,
      alignItems: "center",
      justifyContent: "center",
    },
    headerTitleText: {
      fontSize: 17,
      fontFamily: theme.fontBold,
      color: theme.text,
      maxWidth: 180,
    },
    // ─── Unified presence pill ───
    // A single cohesive pill combining the peer's live status (left zone) and
    // work mode (right zone), separated by a thin divider. Replaces the old
    // decoupled headerSubtitle text + separate work-mode badge.
    presencePill: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      marginTop: 3,
      height: 20,
      paddingHorizontal: 8,
      borderRadius: 999,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.border,
      maxWidth: 220,
    },
    presenceStatus: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      flexShrink: 1,
    },
    statusDot: {
      width: 7,
      height: 7,
      borderRadius: 3.5,
    },
    presenceStatusText: {
      fontSize: 10,
      color: theme.text,
      fontFamily: theme.fontMedium,
      flexShrink: 1,
    },
    presenceDivider: {
      width: 1,
      height: 12,
      marginHorizontal: 8,
      backgroundColor: theme.border,
    },
    presenceWorkMode: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    presenceWorkModeText: {
      fontSize: 10,
      fontFamily: theme.fontMedium,
    },
    // Wraps the list so the floating scroll-to-bottom pill can be positioned over it.
    listWrap: {
      flex: 1,
      width: "100%",
      position: "relative",
      backgroundColor: theme.bg,
      overflow: "hidden",
    },
    listFlex: { flex: 1, width: "100%", backgroundColor: theme.bg },
    // Floating "scroll to latest" pill anchored to the bottom-right, above the
    // composer.
    scrollBtnWrap: {
      position: "absolute",
      right: 14,
      bottom: 12,
    },
    scrollBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.bgElevated,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      shadowColor: "#000",
      shadowOpacity: 0.3,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 2 },
      elevation: 4,
    },
    // Signal-style message-list padding. The larger bottom gap keeps the newest
    // bubble comfortably clear of the composer and typing indicator.
    list: { paddingHorizontal: 10, paddingTop: 8, paddingBottom: 24 },
    // Signal-style centered day-divider pill above the first message of each day.
    daySeparator: {
      alignItems: "center",
      marginVertical: 10,
    },
    dayPill: {
      paddingHorizontal: 12,
      paddingVertical: 4,
      borderRadius: theme.radiusFull,
      backgroundColor: theme.bgElevated,
      borderWidth: 1,
      borderColor: theme.glassBorder,
    },
    dayPillText: {
      fontSize: 11,
      color: theme.textSecondary,
      fontFamily: theme.fontSemiBold,
    },
    // Group activity tombstone (member added/removed/left, renamed, role
    // change, ownership transfer). Centred grey pill, Signal-style.
    sysWrap: {
      alignSelf: "center",
      maxWidth: "85%",
      marginVertical: 6,
      paddingHorizontal: 12,
      paddingVertical: 5,
      borderRadius: theme.radiusFull,
      backgroundColor: theme.bgElevated,
      borderWidth: 1,
      borderColor: theme.glassBorder,
    },
    sysText: {
      fontSize: 12,
      color: theme.textSecondary,
      textAlign: "center",
      fontFamily: theme.fontMedium,
    },
    loadOlderBtn: {
      alignSelf: "center",
      paddingHorizontal: 16,
      paddingVertical: 8,
      marginBottom: 4,
      borderRadius: theme.radiusFull,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.glassBorder,
    },
    loadOlderText: {
      fontSize: 12,
      color: theme.primaryLight,
      fontFamily: theme.fontSemiBold,
    },
    loadOlderContent: {
      alignItems: "center",
      gap: 2,
    },
    loadOlderError: {
      fontSize: 10,
      color: theme.textSecondary,
      fontFamily: theme.fontMedium,
    },
  });
