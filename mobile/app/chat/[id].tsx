import {
  ActivityIndicator,
  InteractionManager,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Modal } from "react-native";
import { Stack } from "expo-router";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Copy,
  Forward,
  MoreVertical,
  Phone,
  Pin,
  Star,
  Trash2,
  Video as VideoIcon,
  X,
} from "lucide-react-native";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { useEffect, useMemo, useState } from "react";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import ChatAvatar from "../../src/components/ChatAvatar";
import {
  ReplyPreview,
  EditPreview,
  MessageBubble,
  TypingIndicator,
  Composer,
  PinnedBanner,
  ReactionOverlay,
  EmojiPicker,
  EmojiKeyboard,
  TenorMediaPicker,
  AttachmentPicker,
  MediaEditor,
  DeleteOptionsSheet,
  MessageActionsSheet,
  HeaderMenuPopup,
  CameraCapture,
  VideoPreview,
  useChatThread,
} from "../../src/components/chat";
import {
  fmtDaySeparator,
  isSameDay,
} from "../../src/components/chat/chatUtils";

/**
 * Chat thread screen — a thin presentational orchestrator. All state, socket
 * effects and handlers live in the `useChatThread` hook (mirrors the web
 * ChatMessages container/hook split). The UI is composed from the chat
 * sub-components in `src/components/chat`.
 */
export default function ChatThread() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const c = useChatThread();

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
                  // field with a back arrow (exit) and a clear "X". The match
                  // counter + up/down navigation live in a bottom bar.
                  headerTitle: () => (
                    <View style={styles.searchHeader}>
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
                    </View>
                  ),
                  headerLeft: () => (
                    <Pressable onPress={c.closeSearch} hitSlop={8}>
                      <ArrowLeft size={22} color={theme.text} />
                    </Pressable>
                  ),
                  headerRight: () => null,
                }
              : {
                  title: c.name || "Chat",
                  // Render our own deterministic up button instead of relying on
                  // native-stack to restore its default back button after the
                  // selection/search headers override `headerLeft`. If this
                  // thread was opened as a cold-start root route, the handler
                  // falls back to the chat tab instead of exiting the app.
                  headerLeft: () => (
                    <Pressable onPress={c.goBackToChatList} hitSlop={8}>
                      <ArrowLeft size={22} color={theme.text} />
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
                      <ChatAvatar
                        name={c.name}
                        avatar={c.headerAvatar}
                        size={32}
                        userStatus={c.peerUserId ? c.peerStatus : undefined}
                        ringColor={theme.bg}
                      />
                      <View style={{ flexShrink: 1 }}>
                        <Text style={styles.headerTitleText} numberOfLines={1}>
                          {c.name || "Chat"}
                        </Text>
                        {c.headerSubtitle ? (
                          <Text style={styles.headerSubtitle} numberOfLines={1}>
                            {c.headerSubtitle}
                          </Text>
                        ) : null}
                      </View>
                    </Pressable>
                  ),
                  // 1:1 calls only — the native call screen can't handle group
                  // calls yet, so hide the call buttons in group conversations.
                  // The 3-dot overflow menu (search / pinned / files / saved /
                  // clear chat) is available everywhere, mirroring the web
                  // ChatHeader.
                  headerRight: () => (
                    <View style={styles.headerActions}>
                      {!c.isGroupConv ? (
                        <>
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
                        </>
                      ) : null}
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
      {c.loading ? (
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

          {/* Signal in-conversation search match-navigation bar. Shows the
              current match position and up/down arrows to step through results
              (each step scrolls the list to the match + flashes its highlight). */}
          {c.searchMode ? (
            <View style={styles.searchNavBar}>
              <Text style={styles.searchNavCount}>
                {c.searchMatchIds.length > 0
                  ? `${c.searchActiveIdx + 1} of ${c.searchMatchIds.length}`
                  : c.searchQuery.trim().length < 2
                    ? "Type to search"
                    : "No results"}
              </Text>
              <View style={styles.searchNavBtns}>
                <Pressable
                  onPress={c.searchPrev}
                  hitSlop={8}
                  disabled={
                    c.searchMatchIds.length === 0 || c.searchActiveIdx <= 0
                  }
                  style={styles.searchNavBtn}
                >
                  <ChevronUp
                    size={22}
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
                  style={styles.searchNavBtn}
                >
                  <ChevronDown
                    size={22}
                    color={
                      c.searchMatchIds.length === 0 ||
                      c.searchActiveIdx >= c.searchMatchIds.length - 1
                        ? theme.textMuted
                        : theme.text
                    }
                  />
                </Pressable>
              </View>
            </View>
          ) : null}

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
          <Composer
            ref={c.inputRef}
            text={c.text}
            editing={c.editingId != null}
            uploading={c.uploading}
            // OR the explicit synchronous flag with the polled state so the
            // recording bar appears INSTANTLY on mic-tap (the poll lags on
            // Android and previously left the tap with no visible feedback).
            isRecording={c.isRecordingActive || c.recorderState.isRecording}
            recordingMillis={c.recorderState.durationMillis}
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
          {/* Docked in-app emoji keyboard (shown in place of the system
              keyboard when the composer's emoji toggle is active). */}
          {c.emojiKeyboardOpen ? (
            <EmojiKeyboard
              height={c.emojiKeyboardHeight}
              onPick={c.insertEmoji}
              onBackspace={c.emojiBackspace}
              onOpenGif={c.attachGifFromEmoji}
              onOpenSticker={c.attachStickerFromEmoji}
            />
          ) : null}
        </View>
      )}

      {/* "+" composer menu — recent-media strip + Photo + File/Document
          (Signal-style AttachmentKeyboard). Voice + Emoji are NOT here: they
          live in the composer itself (the Mic send-button and the inline emoji
          toggle), so duplicating them in this sheet was redundant. */}
      <AttachmentPicker
        visible={c.plusOpen}
        onClose={() => c.setPlusOpen(false)}
        onPhoto={c.attachFile}
        onDocument={c.attachDocument}
        onPickRecent={c.handlePickRecentMedia}
        onOpenCamera={c.attachCamera}
      />

      {/* Signal-style full-screen in-app camera (tap=photo, hold=video, flip,
          flash, recent-gallery strip). Rendered as a full-screen Modal so it
          covers the chat while open. Captures route back through the hook:
          photos → MediaEditor, videos/recent-gallery → upload. */}
      <Modal
        visible={c.cameraOpen}
        animationType="slide"
        onRequestClose={() => c.setCameraOpen(false)}
        statusBarTranslucent
      >
        <CameraCapture
          active={c.cameraOpen}
          onClose={() => c.setCameraOpen(false)}
          onCapturedPhoto={c.handleCameraPhoto}
          onCapturedVideo={c.handleCameraVideo}
          onPickRecent={c.handlePickRecentMedia}
          onOpenGallery={c.attachFile}
        />
      </Modal>

      {/* Signal-style media editor — opened after capturing/picking an image.
          Provides pen/crop/rotate/quality/view-once + caption before send. */}
      {c.editorItems ? (
        <MediaEditor
          initialItems={c.editorItems}
          onSend={c.handleMediaEditorSend}
          onClose={() => c.setEditorItems(null)}
        />
      ) : null}

      {/* Video review screen — opened after recording/picking a video. Lets the
          user watch, caption, set view-once, and Send or discard (instead of
          firing the upload the instant the shutter is released). */}
      {c.videoPreview ? (
        <VideoPreview
          uri={c.videoPreview.uri}
          onSend={c.sendVideoPreview}
          onClose={() => c.setVideoPreview(null)}
        />
      ) : null}

      {/* Long-press message context menu (Signal / WhatsApp / Telegram style):
          a reaction pill PLUS a per-message action list, over a dim scrim.
          Long-press no longer enters multi-select mode — "Select" here does,
          cleanly separating "react/act on this message" from "select messages".
          Hidden while the full emoji picker is open so the picker isn't stuck
          BEHIND this Modal — but `reactTarget` stays alive so the chosen emoji
          is still applied to the right message. */}
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

      {/* Full emoji grid (opened from "All Emoji" or the composer "+").
          Closing in "react" mode also clears the long-pressed target so the
          reaction overlay (hidden only while this picker is open) doesn't pop
          back up. */}
      <EmojiPicker
        visible={c.showAllEmoji}
        mode={c.emojiMode}
        onPick={c.pickEmoji}
        onClose={c.closeEmojiPicker}
      />

      <TenorMediaPicker
        visible={c.tenorOpen}
        kind={c.tenorKind}
        onClose={() => c.setTenorOpen(false)}
        onPick={(item) => c.pickTenorMedia(item, c.tenorKind)}
      />

      {/* Message action sheet (forward / save / pin / edit / delete). */}
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

      {/* Delete chooser — "Delete for everyone" (own messages) / "Delete for
          me" (local hide). Drives both single-message and multi-select deletes. */}
      <DeleteOptionsSheet
        visible={!!c.deleteTargets}
        count={c.deleteTargets?.length ?? 0}
        canDeleteForEveryone={c.deleteCanForEveryone}
        onDeleteForEveryone={c.deleteForEveryone}
        onDeleteForMe={c.deleteForMe}
        onClose={c.closeDeleteSheet}
      />

      {/* Header 3-dot overflow menu (Signal-style, top-anchored popup). Items
          navigate to the dedicated profile sub-screens (search / shared media /
          pinned / saved) instead of opening cramped bottom-sheet panels. */}
      <HeaderMenuPopup
        visible={c.menuOpen}
        onClose={() => c.setMenuOpen(false)}
        onSearch={c.openSearch}
        onPinned={c.openPinnedScreen}
        onSharedMedia={() => c.openSharedMedia("media")}
        onSaved={c.openSavedScreen}
        onClearChat={c.doClearChat}
      />

      {c.dialog}
    </View>
  );
}

/**
 * Messages FlatList. Split out so the screen body stays readable. The
 * `extraData`, `removeClippedSubviews={false}` and `maintainVisibleContentPosition`
 * settings are load-bearing — see the inline comments.
 */
import { FlatList } from "react-native";
import type { ChatMessage } from "../../src/features";
import CallSystemMessage from "../../src/components/chat/CallSystemMessage";

function ChatList({
  c,
  styles,
  theme,
}: {
  c: ReturnType<typeof useChatThread>;
  styles: ReturnType<typeof makeStyles>;
  theme: Theme;
}) {
  // Signal-style "scroll to bottom" pill. In the INVERTED list, offset 0 is the
  // visual bottom (newest message). Once the user scrolls up past a threshold a
  // floating chevron fades in; tapping it smooth-scrolls back to the newest
  // message.
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  // Gate the per-bubble FadeIn/LinearTransition animations. They stay OFF for
  // the initial render so opening the conversation paints the whole visible
  // thread at once and slides in cleanly (no per-row fade flicker fighting the
  // navigation transition — the old cause of the laggy/flickery open). Once the
  // open transition settles we flip this ON so genuinely new messages still
  // fade into place, matching Signal-Android.
  const [entryAnimReady, setEntryAnimReady] = useState(false);
  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      setEntryAnimReady(true);
    });
    return () => task.cancel();
  }, []);

  return (
    // NOTE: this list stays on the stock FlatList because it is INVERTED — the
    // Signal-Android bottom-pinned model below depends on `inverted`, which
    // FlashList v2 dropped. The big perf win here comes from the memoized
    // MessageBubble (see src/components/chat/MessageBubble.tsx) plus the
    // windowing props below; the conversation LIST (non-inverted) uses
    // FlashList instead. See app/(tabs)/chat.tsx.
    <View style={styles.listWrap}>
      <FlatList
        ref={c.listRef as React.RefObject<FlatList<ChatMessage>>}
        // INVERTED list (Signal-Android model). The data is newest-first
        // (`messagesReversed`) and `inverted` flips the visual axis so index 0
        // sits at the visual BOTTOM. This pins the newest message to the bottom
        // STRUCTURALLY — opening/closing the keyboard or sending a message can
        // never push it under the composer, and no scroll math is needed to stick
        // to the bottom (fixes "last message hides during typing / I have to
        // scroll down to see my sent message").
        inverted
        data={c.messagesReversed}
        extraData={c.listSignature}
        // Stable row identity across the optimistic→confirmed swap. An optimistic
        // message starts with a temporary NEGATIVE id; when the server confirms it
        // over the socket the row is replaced with the positive server id. Keying
        // by `id` alone changed the key on that swap → FlatList unmounted the old
        // row and mounted a new one, replaying the bubble's FadeIn entering
        // animation (the visible "blink"/settle on send). The confirmed message
        // keeps the same `clientMsgId`, so keying by it first keeps ONE row
        // instance that updates in place — no remount, no second animation
        // (Signal keeps a single view from "sending" through "sent").
        keyExtractor={(m) => m.clientMsgId ?? String(m.id)}
        // `flex: 1` is load-bearing: without it the FlatList doesn't claim the
        // available column height.
        style={styles.listFlex}
        contentContainerStyle={styles.list}
        // Track scroll distance from the visual bottom (offset 0 in an inverted
        // list). Show the "scroll to bottom" pill once the user has scrolled up
        // past ~1.5 screens of history.
        onScroll={(e) => {
          const y = e.nativeEvent.contentOffset.y;
          const next = y > 400;
          if (next !== showScrollBtn) setShowScrollBtn(next);
        }}
        scrollEventThrottle={16}
        onScrollToIndexFailed={() => {
          setTimeout(() => c.scrollToEnd(false), 200);
        }}
        // Older history lives at the visual TOP — which in an inverted list is the
        // END of the scroll range — so `onEndReached` is the "scrolled up to the
        // top" trigger. Load the previous page there (replaces the old header
        // button + onContentSizeChange stick-to-bottom hack).
        onEndReached={() => {
          if (!c.prependingRef.current) c.loadOlder();
        }}
        onEndReachedThreshold={0.4}
        // Android clips off-screen subviews by default; when a reaction is
        // toggled the bubble's height GROWS (a new chip row appears). With
        // clipping on, the freshly-grown region wasn't repainted until the
        // row scrolled — making the reaction look delayed. Disabling it
        // forces the chip to paint instantly (matches the web).
        removeClippedSubviews={false}
        // Windowing tuned for SMOOTH scrolling on long threads (Signal-Android
        // feel): a small initial batch paints the thread fast on open, a larger
        // render window keeps off-screen rows mounted so fast flings don't reveal
        // blank gaps, and a short batching period commits new rows quickly.
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={21}
        updateCellsBatchingPeriod={30}
        // In an inverted list the FOOTER renders at the visual TOP, so the
        // "load earlier" spinner/button belongs here (not the header).
        ListFooterComponent={
          c.hasMore ? (
            <Pressable
              style={styles.loadOlderBtn}
              onPress={c.loadOlder}
              disabled={c.loadingOlder}
            >
              {c.loadingOlder ? (
                <ActivityIndicator size="small" color={theme.primary} />
              ) : (
                <Text style={styles.loadOlderText}>Load earlier messages</Text>
              )}
            </Pressable>
          ) : null
        }
        renderItem={({ item, index }) => {
          // Type-safe ownership: sender_id / user.id can mismatch number vs
          // string, which previously hid Edit/Delete in the reaction overlay.
          const mine = Number(item.sender_id) === Number(c.user?.id);
          // Consecutive-message grouping (same sender within 5 min) — see
          // docs/CHAT_DESIGN_SPEC.md §4. firstInGroup drives the sender name,
          // lastInGroup drives the bubble tail.
          //
          // INVERTED-LIST INDEXING: the data is newest-first, so the visually
          // PREVIOUS (older, ABOVE) message is at index+1 and the visually NEXT
          // (newer, BELOW) message is at index-1 — the opposite of a normal list.
          const prev = c.messagesReversed[index + 1]; // older, above
          const next = c.messagesReversed[index - 1]; // newer, below
          const within = (a?: ChatMessage, b?: ChatMessage) =>
            !!a &&
            !!b &&
            a.sender_id === b.sender_id &&
            Math.abs(
              new Date(b.created_at).getTime() -
                new Date(a.created_at).getTime(),
            ) <= 300000;
          const firstInGroup = !within(prev, item);
          const lastInGroup = !within(item, next);
          // Signal-style day divider. The list is INVERTED so a row's visual TOP
          // is rendered AFTER the bubble; `prev` (index+1) is the older message
          // ABOVE. We show the divider when this message starts a new calendar
          // day relative to the older neighbour (or it's the oldest message).
          const showDaySeparator =
            !prev || !isSameDay(prev.created_at, item.created_at);
          // Inline call-history row (Signal parity): a `system` message whose
          // metadata describes a call renders as a centred call event instead
          // of a chat bubble.
          if (item.format_type === "system" && item.metadata?.type === "call") {
            return (
              <View>
                <CallSystemMessage
                  message={item}
                  userId={c.user?.id}
                  onCallBack={c.startCall}
                />
                {showDaySeparator ? (
                  <View style={styles.daySeparator}>
                    <View style={styles.dayPill}>
                      <Text style={styles.dayPillText}>
                        {fmtDaySeparator(item.created_at)}
                      </Text>
                    </View>
                  </View>
                ) : null}
              </View>
            );
          }
          return (
            <View>
              <MessageBubble
                message={item}
                mine={mine}
                deleted={!!item.deleted_at}
                starred={c.starredIds.has(item.id)}
                pinned={!!item.pinned_at}
                participantCount={c.participantCount}
                readReceipts={c.readReceipts}
                userId={c.user?.id}
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
                animateEntry={entryAnimReady}
              />
              {showDaySeparator ? (
                <View style={styles.daySeparator}>
                  <View style={styles.dayPill}>
                    <Text style={styles.dayPillText}>
                      {fmtDaySeparator(item.created_at)}
                    </Text>
                  </View>
                </View>
              ) : null}
            </View>
          );
        }}
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
    screen: { flex: 1, backgroundColor: theme.bg },
    center: { flex: 1, alignItems: "center", justifyContent: "center" },
    headerActions: { flexDirection: "row", gap: 18, alignItems: "center" },
    headerTitleWrap: { flexDirection: "row", alignItems: "center", gap: 10 },
    // Signal in-conversation search: header field + bottom match-nav bar.
    searchHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minWidth: 240,
      flex: 1,
    },
    searchInput: {
      flex: 1,
      fontSize: 16,
      color: theme.text,
      paddingVertical: 4,
      fontFamily: theme.fontRegular,
    },
    searchNavBar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingVertical: 8,
      backgroundColor: theme.bgSecondary,
      borderTopWidth: 1,
      borderTopColor: theme.border,
    },
    searchNavCount: {
      fontSize: 13,
      color: theme.textSecondary,
      fontFamily: theme.fontMedium,
    },
    searchNavBtns: { flexDirection: "row", alignItems: "center", gap: 20 },
    searchNavBtn: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
    },
    headerTitleText: {
      fontSize: 17,
      fontFamily: theme.fontBold,
      color: theme.text,
      maxWidth: 180,
    },
    headerSubtitle: {
      fontSize: 11,
      color: theme.textSecondary,
      maxWidth: 180,
      fontFamily: theme.fontRegular,
    },
    // Wraps the FlatList so the floating scroll-to-bottom pill can be absolutely
    // positioned over the visual bottom of the (inverted) list.
    listWrap: { flex: 1, position: "relative" },
    listFlex: { flex: 1 },
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
    // Signal-style message list padding. NOTE: the list is INVERTED (rotated
    // 180°), so contentContainerStyle padding is applied in the flipped space —
    // `paddingTop` here appears at the VISUAL BOTTOM (above the composer) and
    // `paddingBottom` appears at the VISUAL TOP. We therefore put the larger
    // breathing-room gap on `paddingTop` so the newest bubble always clears the
    // composer / typing indicator with a consistent gap.
    list: { paddingHorizontal: 10, paddingTop: 24, paddingBottom: 8 },
    // Signal-style centered day-divider pill rendered between messages on a
    // day boundary. In the INVERTED list this sits visually ABOVE the first
    // message of each day.
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
  });
