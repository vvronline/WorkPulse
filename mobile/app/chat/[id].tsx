import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Stack } from "expo-router";
import { MoreVertical, Phone, Video as VideoIcon } from "lucide-react-native";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { useMemo } from "react";
import ChatAvatar from "../../src/components/ChatAvatar";
import {
  ReplyPreview,
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
  MessageActionsSheet,
  HeaderMenuSheet,
  useChatThread,
} from "../../src/components/chat";

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
        options={{
          title: c.name || "Chat",
          headerTitle: () => (
            <View style={styles.headerTitleWrap}>
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
            </View>
          ),
          // 1:1 calls only — the native call screen can't handle group calls
          // yet, so hide the call buttons in group conversations. The 3-dot
          // overflow menu (search / pinned / files / saved / clear chat) is
          // available everywhere, mirroring the web ChatHeader.
          headerRight: () => (
            <View style={styles.headerActions}>
              {!c.isGroupConv ? (
                <>
                  <Pressable onPress={() => c.startCall("voice")} hitSlop={8}>
                    <Phone size={20} color={theme.primary} />
                  </Pressable>
                  <Pressable onPress={() => c.startCall("video")} hitSlop={8}>
                    <VideoIcon size={20} color={theme.primary} />
                  </Pressable>
                </>
              ) : null}
              <Pressable onPress={() => c.openHeaderPanel("menu")} hitSlop={8}>
                <MoreVertical size={20} color={theme.text} />
              </Pressable>
            </View>
          ),
        }}
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

          {c.peerTyping ? (
            <TypingIndicator name={c.name} avatar={c.headerAvatar} />
          ) : null}
          {/* Reply composing strip */}
          {c.replyTo ? (
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

      {/* "+" composer menu — Photo + File/Document (Signal-style attach sheet).
          Voice + Emoji are NOT here: they live in the composer itself (the Mic
          send-button and the inline emoji toggle), so duplicating them in this
          sheet was redundant. */}
      <AttachmentPicker
        visible={c.plusOpen}
        onClose={() => c.setPlusOpen(false)}
        onPhoto={c.attachFile}
        onDocument={c.attachDocument}
      />

      {/* Signal-style media editor — opened after capturing/picking an image.
          Provides pen/crop/rotate/quality/view-once + caption before send. */}
      {c.editorItems ? (
        <MediaEditor
          initialItems={c.editorItems}
          onSend={c.handleMediaEditorSend}
          onClose={() => c.setEditorItems(null)}
        />
      ) : null}

      {/* Long-press reaction + context overlay (Signal ConversationReactionOverlay):
          dim + lifted bubble + reaction pill (quick emoji + "+") + vertical
          action menu. Hidden while the full emoji picker is open so the picker
          isn't stuck BEHIND this Modal — but `reactTarget` stays alive so the
          chosen emoji is still applied to the right message. */}
      <ReactionOverlay
        visible={!!c.reactTarget && !c.showAllEmoji}
        anchor={c.reactAnchor}
        message={c.reactTarget}
        isOwn={Number(c.reactTarget?.sender_id) === Number(c.user?.id)}
        isStarred={!!c.reactTarget && c.starredIds.has(c.reactTarget.id)}
        userId={c.user?.id}
        onReact={(emoji) => c.reactTarget && c.react(c.reactTarget, emoji)}
        onOpenAllEmoji={() => {
          c.setEmojiMode("react");
          c.setShowAllEmoji(true);
        }}
        onReply={() => c.reactTarget && c.startReply(c.reactTarget)}
        onForward={() => c.reactTarget && c.openForwardFor(c.reactTarget)}
        onCopy={() => c.reactTarget && c.copyMessage(c.reactTarget)}
        onStar={() => c.reactTarget && c.doStar(c.reactTarget)}
        onPin={() => c.reactTarget && c.doPin(c.reactTarget)}
        onEdit={() => c.reactTarget && c.startEdit(c.reactTarget)}
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

      {/* Header 3-dot menu + its panels (search / pinned / files / saved). */}
      <HeaderMenuSheet
        sheet={c.headerSheet}
        name={c.name}
        convId={c.convId}
        loading={c.sheetLoading}
        searchQ={c.sheetSearchQ}
        searchResults={c.sheetSearchResults}
        pinnedMsgs={c.pinnedMsgs}
        sharedFiles={c.sharedFiles}
        savedMsgs={c.savedMsgs}
        onClose={() => c.setHeaderSheet(null)}
        onOpenPanel={c.openHeaderPanel}
        onSearchChange={c.onSheetSearchChange}
        onJump={c.jumpFromSheet}
        onUnpin={c.unpinFromBanner}
        onUnstar={c.unstarFromSheet}
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

function ChatList({
  c,
  styles,
  theme,
}: {
  c: ReturnType<typeof useChatThread>;
  styles: ReturnType<typeof makeStyles>;
  theme: Theme;
}) {
  return (
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
      keyExtractor={(m) => String(m.id)}
      // `flex: 1` is load-bearing: without it the FlatList doesn't claim the
      // available column height.
      style={styles.listFlex}
      contentContainerStyle={styles.list}
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
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
          ) <= 300000;
        const firstInGroup = !within(prev, item);
        const lastInGroup = !within(item, next);
        return (
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
            registerRef={c.registerBubbleRef}
            onLongPress={c.openReactionBar}
            onReact={c.react}
            onAddReaction={c.openReactionBar}
            onReply={c.startReply}
            onRetry={c.retryFailedMessage}
            onCancelUpload={c.cancelMediaUpload}
            onRetryUpload={c.retryMediaUpload}
          />
        );
      }}
    />
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.bg },
    center: { flex: 1, alignItems: "center", justifyContent: "center" },
    headerActions: { flexDirection: "row", gap: 18, alignItems: "center" },
    headerTitleWrap: { flexDirection: "row", alignItems: "center", gap: 10 },
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
    listFlex: { flex: 1 },
    // Signal-style message list padding. NOTE: the list is INVERTED (rotated
    // 180°), so contentContainerStyle padding is applied in the flipped space —
    // `paddingTop` here appears at the VISUAL BOTTOM (above the composer) and
    // `paddingBottom` appears at the VISUAL TOP. We therefore put the larger
    // breathing-room gap on `paddingTop` so the newest bubble always clears the
    // composer / typing indicator with a consistent gap.
    list: { paddingHorizontal: 10, paddingTop: 24, paddingBottom: 8 },
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
