import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, View, type FlatList, type TextInput, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import * as Clipboard from "expo-clipboard";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { useAuth } from "../../auth/AuthContext";
import { useDialog } from "../../hooks/useDialog";
import {
  ackDelivered,
  clearChat,
  deleteMessage,
  editMessage,
  forwardMessage,
  getConversations,
  getChatPresence,
  getMessages,
  getPinnedMessages,
  getReadStatus,
  getSharedFiles,
  getStarredMessages,
  markConversationRead,
  pinMessage,
  searchMessages,
  starMessage,
  toggleReaction,
  uploadChatFile,
  type ChatMessage,
  type Conversation,
  type MessageSearchResult,
  type PinnedMessage,
  type SharedFile,
  type StarredMessage,
} from "../../features";
import { socket } from "../../realtime/socket";
import { emitChatUnreadChanged, chatUnreadManager } from "../../realtime/chatUnreadEvents";
import { useKeyboardInset } from "../../hooks/useKeyboardInset";
import { hydrateEmojiStore } from "../../emoji/emojiStore";
import { STATUS_LABEL, type HeaderSheet } from "./chatUtils";

/**
 * All state, side-effects and handlers for the chat thread screen. Extracted
 * from `app/chat/[id].tsx` so the screen is a thin presentational orchestrator
 * (mirrors the web ChatMessages container/hook split). Behavior-preserving.
 */
export function useChatThread() {
  const params = useLocalSearchParams<{
    id: string;
    name?: string;
    avatar?: string;
    peerId?: string;
    isGroup?: string;
  }>();
  const { id, name } = params;
  const headerAvatar = params.avatar || null;
  const convId = Number(id);
  // Group conversations get NO 1:1 call buttons — the native call screen is
  // strictly peer-to-peer (single remote stream), so initiating a "group call"
  // from here would produce a broken half-connected call. Mirrors the web,
  // where group calls go through the meeting flow instead.
  const [isGroupConv, setIsGroupConv] = useState(params.isGroup === "1");
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const kbInset = useKeyboardInset();
  const { width: winWidth, height: winHeight } = useWindowDimensions();
  const { user } = useAuth();
  const { alert, confirm, dialog } = useDialog();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  // Cursor pagination for older history (mirrors web loadMore).
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [text, setText] = useState("");
  const [peerTyping, setPeerTyping] = useState(false);
  const [reactTarget, setReactTarget] = useState<ChatMessage | null>(null);
  // Window-space rect of the long-pressed bubble so the reaction bar can be
  // positioned right next to it (matching the web behavior), instead of being
  // fixed in the middle of the screen.
  const [reactAnchor, setReactAnchor] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
    mine: boolean;
  } | null>(null);
  const [barSize, setBarSize] = useState<{ width: number; height: number }>({
    width: 300,
    height: 44,
  });
  const [actionTarget, setActionTarget] = useState<ChatMessage | null>(null);
  // When true, the action-sheet modal shows the "Forward to…" conversation
  // picker INSTEAD of the action rows. Forward used to live in a separate
  // <Modal> opened via setTimeout after dismissing the action sheet — on
  // Android presenting a modal while another is dismissing silently fails,
  // which is why Forward appeared broken. A single modal with switching
  // content has no such race.
  const [forwardMode, setForwardMode] = useState(false);
  const [showAllEmoji, setShowAllEmoji] = useState(false);
  // Whether the emoji grid inserts into the composer ("compose") or reacts to
  // the selected message ("react").
  const [emojiMode, setEmojiMode] = useState<"react" | "compose">("react");
  const [plusOpen, setPlusOpen] = useState(false);
  // Docked in-app emoji keyboard (Signal-style). When open we hide the system
  // keyboard and show EmojiKeyboard at the last-measured keyboard height so the
  // message list doesn't jump.
  const [emojiKeyboardOpen, setEmojiKeyboardOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  // Peer (1:1) identity + live status for the header avatar badge.
  const [peerUserId, setPeerUserId] = useState<number | null>(
    params.peerId ? Number(params.peerId) : null,
  );
  const [peerStatus, setPeerStatus] = useState<string | null>(null);
  // Delivery / read receipts (userId → ISO last_read_at) + participant count.
  const [readReceipts, setReadReceipts] = useState<Record<number, string>>({});
  const [participantCount, setParticipantCount] = useState(2);
  // Pinned messages (banner at the top of the chat).
  const [pinnedMsgs, setPinnedMsgs] = useState<PinnedMessage[]>([]);
  // Locally-tracked starred message ids (server list doesn't return per-message
  // starred state, so we reflect it optimistically after the action).
  const [starredIds, setStarredIds] = useState<Set<number>>(new Set());
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
  // Voice recording (expo-audio). Poll the recorder state every 100ms (vs the
  // 500ms default) so the in-composer recording bar appears immediately on
  // record() and the live duration counter ticks smoothly.
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 100);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  // Bubble host-node refs so we can reliably measure each bubble's window rect
  // for the reaction-bar anchor (Pressable forwards its ref to the host View,
  // which exposes measureInWindow — currentTarget often does not).
  const bubbleRefs = useRef<Map<number, View>>(new Map());
  const typingSentAt = useRef(0);
  const typingClear = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while older messages are being prepended, so the auto
  // scroll-to-end on content-size change doesn't yank the list to the
  // bottom and defeat pagination.
  const prependingRef = useRef(false);
  // TextInput handle so we can blur/focus when switching between the system
  // keyboard and the in-app emoji keyboard.
  const inputRef = useRef<TextInput>(null);
  // One-shot guard so the "system keyboard appeared → close emoji" safety
  // effect below ignores the STALE keyboard height reported while the OS
  // keyboard is still animating away after we deliberately switched to the
  // in-app emoji keyboard. Without it, tapping the emoji toggle WHILE typing
  // immediately re-closed the emoji panel (the dismiss is async, so kbInset
  // was still > 100 on the render that opened it). Re-armed once the system
  // keyboard is genuinely hidden (kbInset back to 0). Mirrors Signal-Android's
  // transition-based InputAwareLayout (it tracks the keyboard transition, not a
  // momentary height value).
  const ignoreKbForEmoji = useRef(false);
  // Last-measured system keyboard height — the in-app emoji keyboard is shown
  // at this height so toggling between them doesn't shift the message list.
  const lastKbHeight = useRef(280);
  if (kbInset > 100) lastKbHeight.current = kbInset;

  // Hydrate emoji recents + skin-tone preference once.
  useEffect(() => {
    hydrateEmojiStore();
  }, []);

  // If the system keyboard GENUINELY appears (user tapped the field), close the
  // in-app emoji keyboard so the two never stack. We must ignore the STALE
  // keyboard height reported while the OS keyboard is still animating away
  // right after we deliberately switched to the emoji keyboard — otherwise
  // tapping the emoji toggle WHILE typing instantly re-closed the panel that
  // had just opened (the dismiss is async, so kbInset was momentarily still
  // > 100 on the render that set emojiKeyboardOpen=true). Once the keyboard is
  // fully hidden (kbInset back to 0) we re-arm the guard so a real later
  // keyboard appearance still closes the emoji panel.
  useEffect(() => {
    if (kbInset > 100) {
      if (ignoreKbForEmoji.current) return; // stale height from the dismissing keyboard
      if (emojiKeyboardOpen) setEmojiKeyboardOpen(false);
    } else {
      ignoreKbForEmoji.current = false; // keyboard fully hidden → re-arm
    }
  }, [kbInset, emojiKeyboardOpen]);

  const scrollToEnd = useCallback((animated = false) => {
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated });
    });
  }, []);

  // When the peer STARTS typing, the typing-indicator row appears below the
  // list and shrinks the FlatList — which can crop/hide the newest bubble.
  // Re-anchor to the bottom so the last message stays fully visible above the
  // typing indicator (mirrors the web auto-scroll on typing).
  useEffect(() => {
    if (peerTyping) scrollToEnd(true);
  }, [peerTyping, scrollToEnd]);

  // Register/unregister a bubble's host node so the reaction bar can measure
  // it (see openReactionBar). Keeping this stable avoids re-registering on
  // every render.
  const registerBubbleRef = useCallback((msgId: number, node: View | null) => {
    if (node) bubbleRefs.current.set(msgId, node);
    else bubbleRefs.current.delete(msgId);
  }, []);

  const loadPinned = useCallback(() => {
    getPinnedMessages(convId)
      .then((r) => setPinnedMsgs(r.data || []))
      .catch(() => {});
  }, [convId]);

  const markReadAndSync = useCallback(() => {
    markConversationRead(convId)
      .then(() => {
        // T030: Update unread manager when conversation is marked read
        chatUnreadManager.markConversationRead(convId);
        emitChatUnreadChanged();
      })
      .catch(() => {});
  }, [convId]);

  const load = useCallback(async () => {
    try {
      const { data } = await getMessages(convId);
      setMessages(data || []);
      setHasMore((data || []).length >= 50);
      markReadAndSync();
      // Seed read receipts so own messages show the correct tick immediately.
      getReadStatus(convId)
        .then((r) => {
          const map: Record<number, string> = {};
          for (const row of r.data || []) {
            if (row.user_id != null && row.last_read_at) {
              map[row.user_id] = row.last_read_at;
            }
          }
          setReadReceipts(map);
        })
        .catch(() => {});
      // Jump to the newest message once the list has content.
      setTimeout(() => scrollToEnd(false), 80);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [convId, markReadAndSync, scrollToEnd]);

  useEffect(() => {
    load();
    loadPinned();
  }, [load, loadPinned]);

  // Load an older page of messages using the oldest real message id as a
  // cursor (mirrors the web loadMore). Triggered by the "load earlier"
  // header button / top-reach.
  const loadOlder = useCallback(async () => {
    if (loadingOlder || !hasMore) return;
    // Oldest REAL (server-assigned) id — skip optimistic negative ids.
    const oldest = messages.find((m) => m.id > 0);
    if (!oldest) return;
    setLoadingOlder(true);
    prependingRef.current = true;
    try {
      const { data } = await getMessages(convId, oldest.id);
      const older = data || [];
      setHasMore(older.length >= 50);
      if (older.length > 0) {
        setMessages((prev) => {
          const have = new Set(prev.map((m) => m.id));
          return [...older.filter((m) => !have.has(m.id)), ...prev];
        });
      }
    } catch {
      /* ignore */
    } finally {
      setLoadingOlder(false);
      // Give the list a beat to settle before re-enabling stick-to-end.
      setTimeout(() => {
        prependingRef.current = false;
      }, 350);
    }
  }, [convId, hasMore, loadingOlder, messages]);

  // Resolve the 1:1 peer's userId + initial status, participant count and a
  // fallback avatar for the header badge.
  useEffect(() => {
    let active = true;
    getConversations()
      .then(({ data }) => {
        if (!active) return;
        const conv = (data || []).find((c) => c.id === convId);
        if (!conv) return;
        if (conv.member_count) setParticipantCount(conv.member_count);
        setIsGroupConv(!!conv.is_group);
        if (!conv.is_group && conv.other_user_id) {
          const uid = conv.other_user_id;
          setPeerUserId(uid);
          getChatPresence([uid])
            .then((r) => {
              if (active) setPeerStatus(r.data?.[uid]?.userStatus ?? null);
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [convId]);

  // Keep the peer's header status live via the unified `user_status` event.
  useEffect(() => {
    const off = socket.subscribe((msg) => {
      if (msg.type !== "user_status") return;
      if (!peerUserId || msg.data?.userId !== peerUserId) return;
      setPeerStatus(msg.data.effective);
    });
    return off;
  }, [peerUserId]);

  // Live incoming messages / typing / read receipts / pins for this conversation.
  useEffect(() => {
    const off = socket.subscribe((msg) => {
      const d = msg.data || {};
      if (msg.type === "chat_typing") {
        if (Number(d.conversationId) !== convId) return;
        if (d.userId === user?.id) return;
        setPeerTyping(true);
        if (typingClear.current) clearTimeout(typingClear.current);
        typingClear.current = setTimeout(() => setPeerTyping(false), 3500);
        return;
      }
      if (msg.type === "chat_read_receipt") {
        if (Number(d.conversationId) !== convId) return;
        if (d.userId && d.readAt) {
          setReadReceipts((prev) => ({ ...prev, [d.userId]: d.readAt }));
        }
        return;
      }
      if (msg.type === "chat_pin") {
        if (Number(d.conversationId) !== convId) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === d.messageId
              ? {
                  ...m,
                  pinned_at: d.pinned ? new Date().toISOString() : null,
                  pinned_by: d.pinned ? d.pinnedBy : null,
                }
              : m,
          ),
        );
        loadPinned();
        return;
      }
      // Peer reactions — add/remove live (mirrors web chat_reaction handler).
      if (msg.type === "chat_reaction") {
        if (Number(d.conversationId) !== convId) return;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== d.messageId) return m;
            let reactions = [...(m.reactions || [])];
            if (d.action === "added") {
              // Idempotent: don't duplicate an optimistically-added reaction.
              if (
                !reactions.some(
                  (r) => r.userId === d.userId && r.emoji === d.emoji,
                )
              ) {
                reactions.push({
                  userId: d.userId,
                  fullName: d.fullName,
                  emoji: d.emoji,
                });
              }
            } else {
              reactions = reactions.filter(
                (r) => !(r.userId === d.userId && r.emoji === d.emoji),
              );
            }
            return { ...m, reactions };
          }),
        );
        return;
      }
      // Peer edits — update content live (mirrors web chat_edit handler).
      if (msg.type === "chat_edit") {
        if (Number(d.conversationId) !== convId) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === d.messageId
              ? { ...m, content: d.content, edited_at: d.editedAt }
              : m,
          ),
        );
        return;
      }
      // Peer deletions — mark deleted live (mirrors web chat_delete handler).
      if (msg.type === "chat_delete") {
        if (Number(d.conversationId) !== convId) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === d.messageId
              ? { ...m, deleted_at: new Date().toISOString() }
              : m,
          ),
        );
        return;
      }
      // Conversation cleared by a peer — empty the list (mirrors web).
      if (msg.type === "chat_cleared") {
        if (Number(d.conversationId) !== convId) return;
        setMessages([]);
        setPinnedMsgs([]);
        setHasMore(false);
        return;
      }
      // Conversation deleted, or current user removed from the group —
      // leave the screen (the web equivalent clears activeConv).
      if (msg.type === "chat_conv_deleted") {
        if (Number(d.conversationId) !== convId) return;
        router.back();
        return;
      }
      if (msg.type === "chat_group_removed") {
        if (Number(d.conversationId) !== convId) return;
        if (d.userId === user?.id) router.back();
        return;
      }
      if (msg.type !== "chat_message") return;
      if (Number(d.conversationId) !== convId) return;
      setPeerTyping(false);
      setMessages((prev) => {
        // Replace optimistic message if clientMsgId matches, else append.
        if (d.clientMsgId) {
          const idx = prev.findIndex((m) => m.clientMsgId === d.clientMsgId);
          if (idx >= 0) {
            const copy = [...prev];
            copy[idx] = {
              id: d.id,
              sender_id: d.senderId,
              sender_name: d.senderName,
              content: d.content,
              created_at: d.createdAt,
              file_url: d.fileUrl,
              file_name: d.fileName,
              file_type: d.fileType,
              file_size: d.fileSize,
              reply_to_id: d.replyToId ?? null,
              reply_to_content: d.replyContent ?? null,
              reply_to_sender_name: d.replySenderName ?? null,
              clientMsgId: d.clientMsgId,
            };
            return copy;
          }
        }
        if (prev.some((m) => m.id === d.id)) return prev;
        return [
          ...prev,
          {
            id: d.id,
            sender_id: d.senderId,
            sender_name: d.senderName,
            content: d.content,
            created_at: d.createdAt,
            file_url: d.fileUrl,
            file_name: d.fileName,
            file_type: d.fileType,
            file_size: d.fileSize,
            reply_to_id: d.replyToId ?? null,
            reply_to_content: d.replyContent ?? null,
            reply_to_sender_name: d.replySenderName ?? null,
          },
        ];
      });
      markReadAndSync();
      // Acknowledge delivery so the sender sees "✓✓ delivered" (mirrors the
      // web ackDelivered call in the chat_message WS handler).
      if (d.senderId !== user?.id && d.id) {
        ackDelivered(d.id).catch(() => {});
      }
      scrollToEnd(true);
    });
    return off;
  }, [convId, user?.id, loadPinned, markReadAndSync, scrollToEnd, router]);

  const send = useCallback(() => {
    const content = text.trim();
    if (!content || !user) return;
    const clientMsgId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const replyToId = replyTo?.id;
    // Optimistic append.
    setMessages((prev) => [
      ...prev,
      {
        id: -Date.now(),
        sender_id: user.id,
        sender_name: user.full_name,
        content,
        created_at: new Date().toISOString(),
        reply_to_id: replyToId ?? null,
        reply_to_content: replyTo?.content ?? null,
        reply_to_sender_name: replyTo?.sender_name ?? null,
        _pending: true,
        clientMsgId,
      },
    ]);
    socket.send("chat_message", {
      conversationId: convId,
      content,
      clientMsgId,
      ...(replyToId ? { replyToId } : {}),
    });
    setText("");
    setReplyTo(null);
    scrollToEnd(true);
  }, [text, user, convId, replyTo, scrollToEnd]);

  const onChangeText = useCallback(
    (v: string) => {
      setText(v);
      // Throttle typing pings to one per ~2s.
      const now = Date.now();
      if (now - typingSentAt.current > 2000) {
        typingSentAt.current = now;
        socket.send("chat_typing", { conversationId: convId });
      }
    },
    [convId],
  );

  async function startRecording() {
    // Guard against a double-tap while a recording is already underway (the
    // recorder throws if record() is called twice without an intervening stop).
    if (recorderState.isRecording) return;
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        alert(
          "Microphone needed",
          "Allow microphone access to record a voice message.",
        );
        return;
      }
      // Switch the audio session into record mode BEFORE preparing/recording.
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      // prepareToRecordAsync MUST resolve before record() — calling record()
      // on an unprepared recorder silently no-ops on Android, which is why the
      // Mic button "did nothing" (no recording bar, nothing sent).
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch (e: any) {
      // Restore the playback session so a failed start doesn't leave the audio
      // route stuck in record mode.
      setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
      }).catch(() => {});
      alert(
        "Recording failed",
        e?.message || "Could not start the voice recording.",
      );
    }
  }

  async function stopRecordingAndSend() {
    try {
      await recorder.stop();
    } catch {
      /* the recorder may already be stopped; fall through to upload the uri */
    }
    // Restore the playback audio session — leaving allowsRecording=true
    // routes/silences subsequent voice-note playback on iOS.
    setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(
      () => {},
    );
    const uri = recorder.uri;
    if (!uri) return;
    try {
      setUploading(true);
      const fileName = `voice-${Date.now()}.m4a`;
      const { data } = await uploadChatFile(convId, uri, fileName);
      setMessages((prev) =>
        prev.some((m) => m.id === data.id) ? prev : [...prev, data],
      );
      scrollToEnd(true);
    } catch (e: any) {
      alert(
        "Send failed",
        e?.response?.data?.error || "Could not send the voice message.",
      );
    } finally {
      setUploading(false);
    }
  }

  async function cancelRecording() {
    try {
      await recorder.stop();
    } catch {
      /* ignore */
    }
    // Same audio-session restore as stopRecordingAndSend.
    setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(
      () => {},
    );
  }

  async function attachFile() {
    setPlusOpen(false);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.8,
    });
    if (result.canceled || !result.assets?.[0]?.uri) return;
    setUploading(true);
    try {
      const asset = result.assets[0];
      const { data } = await uploadChatFile(
        convId,
        asset.uri,
        asset.fileName || undefined,
      );
      setMessages((prev) =>
        prev.some((m) => m.id === data.id) ? prev : [...prev, data],
      );
      scrollToEnd(true);
    } catch {
      /* ignore */
    } finally {
      setUploading(false);
    }
  }

  // Document attachment — the old single "Photo / File" option only opened
  // the IMAGE library despite its label, so PDFs/docs could never be sent
  // from mobile (the web supports them). Uses expo-document-picker.
  async function attachDocument() {
    setPlusOpen(false);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || !result.assets?.[0]?.uri) return;
      const asset = result.assets[0];
      setUploading(true);
      const { data } = await uploadChatFile(
        convId,
        asset.uri,
        asset.name || undefined,
        asset.mimeType || undefined,
      );
      setMessages((prev) =>
        prev.some((m) => m.id === data.id) ? prev : [...prev, data],
      );
      scrollToEnd(true);
    } catch (e: any) {
      alert(
        "Upload failed",
        e?.response?.data?.error || "Could not send this file.",
      );
    } finally {
      setUploading(false);
    }
  }

  function startEdit(message: ChatMessage) {
    setActionTarget(null);
    setEditingId(message.id);
    setText(message.content);
  }

  async function saveEdit() {
    if (editingId == null) return;
    const content = text.trim();
    if (!content) return;
    try {
      const { data } = await editMessage(editingId, content);
      setMessages((prev) =>
        prev.map((m) => (m.id === editingId ? { ...m, content: data.content } : m)),
      );
    } catch {
      /* ignore */
    } finally {
      setEditingId(null);
      setText("");
    }
  }

  function doDelete(message: ChatMessage) {
    setActionTarget(null);
    deleteMessage(message.id)
      .then(() =>
        setMessages((prev) =>
          prev.map((m) =>
            m.id === message.id
              ? { ...m, deleted_at: new Date().toISOString() }
              : m,
          ),
        ),
      )
      .catch(() => alert("Error", "Could not delete message."));
  }

  function doPin(message: ChatMessage) {
    setActionTarget(null);
    pinMessage(message.id)
      .then(({ data }) => {
        const pinned = !!(data as { pinned?: boolean })?.pinned;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === message.id
              ? { ...m, pinned_at: pinned ? new Date().toISOString() : null }
              : m,
          ),
        );
        loadPinned();
        alert(
          pinned ? "Pinned" : "Unpinned",
          pinned ? "Message pinned to this chat." : "Message unpinned.",
        );
      })
      .catch(() => alert("Error", "Could not pin message."));
  }

  function doStar(message: ChatMessage) {
    setActionTarget(null);
    starMessage(message.id)
      .then(({ data }) => {
        const starred = !!(data as { starred?: boolean })?.starred;
        setStarredIds((prev) => {
          const next = new Set(prev);
          if (starred) next.add(message.id);
          else next.delete(message.id);
          return next;
        });
        alert(
          starred ? "Saved" : "Removed",
          starred ? "Message added to saved." : "Removed from saved.",
        );
      })
      .catch(() => alert("Error", "Could not save message."));
  }

  function unpinFromBanner(messageId: number) {
    pinMessage(messageId)
      .then(() => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === messageId ? { ...m, pinned_at: null } : m,
          ),
        );
        loadPinned();
      })
      .catch(() => {});
  }

  function jumpToMessage(messageId: number) {
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;
    try {
      listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.3 });
    } catch {
      /* ignore */
    }
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

  function doClearChat() {
    setHeaderSheet(null);
    // Defer so the confirm dialog never collides with the dismissing modal.
    setTimeout(() => {
      confirm({
        title: "Clear chat",
        message:
          "Delete all messages in this conversation for everyone? This cannot be undone.",
        confirmText: "Clear",
        isDanger: true,
        onConfirm: () => {
          clearChat(convId)
            .then(() => {
              setMessages([]);
              setPinnedMsgs([]);
              setHasMore(false);
            })
            .catch((e: any) =>
              alert(
                "Error",
                e?.response?.data?.error || "Could not clear chat.",
              ),
            );
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

  function startReply(message: ChatMessage) {
    setActionTarget(null);
    setReactTarget(null);
    setReplyTo(message);
  }

  // Copy a message's text to the clipboard (overlay "Copy" action).
  function copyMessage(message: ChatMessage) {
    setReactTarget(null);
    setReactAnchor(null);
    if (message.content) {
      Clipboard.setStringAsync(message.content).catch(() => {});
    }
  }

  // Open the Forward picker for a message reached from the reaction overlay.
  // The overlay's target lives in `reactTarget`; we promote it to
  // `actionTarget` (which drives the forward picker modal + doForward) and
  // switch into forward mode.
  function openForwardFor(message: ChatMessage) {
    setReactTarget(null);
    setReactAnchor(null);
    setActionTarget(message);
    getConversations()
      .then((r) => setConversations(r.data || []))
      .catch(() => setConversations([]));
    setForwardMode(true);
  }

  function openForward() {
    // Switch the already-open action-sheet modal into "forward" mode. We do
    // NOT dismiss this modal and present another — that cross-modal race on
    // Android is what made Forward silently fail before.
    setReactTarget(null);
    // Preload conversations so the picker isn't empty when it appears.
    getConversations()
      .then((r) => setConversations(r.data || []))
      .catch(() => setConversations([]));
    setForwardMode(true);
  }

  function closeActionSheet() {
    setActionTarget(null);
    setForwardMode(false);
  }

  function doForward(targetConvId: number) {
    const msg = actionTarget;
    if (!msg) return;
    closeActionSheet();
    forwardMessage(msg.id, [targetConvId])
      .then(() => {
        // Small defer so the result dialog never collides with the
        // dismissing modal.
        setTimeout(() => alert("Forwarded", "Message forwarded."), 300);
      })
      .catch((e: any) => {
        setTimeout(
          () =>
            alert(
              "Error",
              e?.response?.data?.error || "Could not forward message.",
            ),
          300,
        );
      });
  }

  async function react(message: ChatMessage, emoji: string) {
    setReactTarget(null);
    // Optimistic toggle FIRST (mirrors web handleReact): the chip appears /
    // disappears instantly. Doing the API call before the state update caused
    // two bugs: (a) the reaction only showed after the network round-trip and
    // (b) a remove raced the server's WS "removed" fan-out — the WS handler
    // removed the chip, then the late local toggle re-ADDED it, making
    // "remove reaction" appear broken.
    const applyToggle = (prev: ChatMessage[]) =>
      prev.map((m) => {
        if (m.id !== message.id) return m;
        const existing = m.reactions || [];
        const mineIdx = existing.findIndex(
          (r) => r.userId === user?.id && r.emoji === emoji,
        );
        if (mineIdx >= 0) {
          return { ...m, reactions: existing.filter((_, i) => i !== mineIdx) };
        }
        return {
          ...m,
          reactions: [
            ...existing,
            { emoji, userId: user?.id ?? 0, fullName: user?.full_name ?? "" },
          ],
        };
      });
    setMessages(applyToggle);
    try {
      await toggleReaction(message.id, emoji);
    } catch {
      // API failed — revert the optimistic toggle so UI matches the server.
      setMessages(applyToggle);
    }
  }

  function pickEmoji(emoji: string) {
    if (emojiMode === "compose") {
      setText((t) => t + emoji);
    } else if (reactTarget) {
      // Apply the chosen reaction to the long-pressed message. `react()` clears
      // reactTarget itself, but clear the anchor too so the reaction overlay
      // doesn't briefly re-appear behind the closing picker.
      react(reactTarget, emoji);
      setReactAnchor(null);
    }
    setShowAllEmoji(false);
  }

  // Close the full emoji picker WITHOUT picking. In "react" mode this must also
  // drop the long-pressed target/anchor, otherwise the reaction overlay (which
  // is hidden only while the picker is open) would pop straight back up.
  function closeEmojiPicker() {
    setShowAllEmoji(false);
    if (emojiMode === "react") {
      setReactTarget(null);
      setReactAnchor(null);
    }
  }

  // ── Inline emoji keyboard (Signal-style composer toggle) ──────────────────
  // Toggle between the system keyboard and the docked in-app emoji keyboard.
  function toggleEmojiKeyboard() {
    if (emojiKeyboardOpen) {
      // Emoji → system keyboard: re-focus the field (which re-shows the OS
      // keyboard because showSoftInputOnFocus flips back to true).
      setEmojiKeyboardOpen(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      // System → emoji: dismiss the OS keyboard, then dock the emoji keyboard.
      // Arm the guard FIRST so the safety effect ignores the system keyboard's
      // still-animating (stale) height — otherwise the emoji panel we open on
      // the next line would be instantly closed again (the dismiss is async).
      ignoreKbForEmoji.current = true;
      Keyboard.dismiss();
      setEmojiKeyboardOpen(true);
    }
  }

  // Called from the docked emoji keyboard — insert at the end of the draft.
  function insertEmoji(native: string) {
    setText((t) => t + native);
  }

  // Backspace key on the docked emoji keyboard (mobile keyboard mode).
  function emojiBackspace() {
    setText((t) => Array.from(t).slice(0, -1).join(""));
  }

  // When the field gains focus via a tap, ensure the emoji keyboard is closed.
  function onComposerInputFocus() {
    if (emojiKeyboardOpen) setEmojiKeyboardOpen(false);
  }

  function startCall(type: "voice" | "video") {
    router.push({
      pathname: "/call/[conversationId]",
      params: {
        conversationId: String(convId),
        mode: "outgoing",
        callType: type,
        peerName: name || "Call",
        peerAvatar: headerAvatar || "",
      },
    });
  }

  // Anchor the reaction bar to the long-pressed bubble (mirrors the web
  // MessageBubble). Measures the bubble's host node directly for reliability.
  function openReactionBar(item: ChatMessage, mine: boolean) {
    const node = bubbleRefs.current.get(item.id) as unknown as {
      measureInWindow?: (
        cb: (x: number, y: number, width: number, height: number) => void,
      ) => void;
    } | null;
    // IMPORTANT: call measureInWindow ON the node (not via a detached
    // reference). It is a method bound to the native view instance — invoking
    // it without its receiver loses `this` and crashes the app natively.
    if (node && typeof node.measureInWindow === "function") {
      try {
        node.measureInWindow((x, y, width, height) => {
          setReactAnchor({ x, y, width, height, mine });
          setReactTarget(item);
        });
      } catch {
        setReactAnchor(null);
        setReactTarget(item);
      }
    } else {
      setReactAnchor(null);
      setReactTarget(item);
    }
  }

  // Position the reaction bar right next to the long-pressed bubble (mirrors
  // the web MessageBubble behavior). Falls back to centered if no anchor.
  function computeBarPosition() {
    if (!reactAnchor) {
      return {
        position: "absolute" as const,
        top: winHeight / 2 - barSize.height / 2,
        left: winWidth / 2 - barSize.width / 2,
      };
    }
    const margin = 8;
    const gap = 6;
    const barW = barSize.width || 300;
    const barH = barSize.height || 44;

    // Horizontal: align with the bubble edge, clamped to the screen.
    let left = reactAnchor.mine
      ? reactAnchor.x + reactAnchor.width - barW
      : reactAnchor.x;
    left = Math.max(margin, Math.min(left, winWidth - barW - margin));

    // Vertical: prefer above the bubble; if it doesn't fit, place below.
    let top = reactAnchor.y - barH - gap;
    if (top < insets.top + margin) {
      top = reactAnchor.y + reactAnchor.height + gap;
    }
    top = Math.max(
      insets.top + margin,
      Math.min(top, winHeight - barH - margin),
    );

    return { position: "absolute" as const, top, left };
  }

  // Reaction-bar size measurement (keeps the anchor positioning accurate).
  function onReactionBarLayout(width: number, height: number) {
    if (
      Math.abs(width - barSize.width) > 1 ||
      Math.abs(height - barSize.height) > 1
    ) {
      setBarSize({ width, height });
    }
  }

  const latestPin = pinnedMsgs[0];

  // FlatList re-render key. With `maintainVisibleContentPosition` enabled,
  // RN's VirtualizedList skips re-rendering already-mounted rows unless
  // `extraData` changes. Optimistic reaction add/remove mutates a message's
  // `reactions` in place (same array length/order), so without this the chip
  // only appeared after an unrelated re-render or the WS echo — making
  // react/unreact feel laggy. Deriving a signature from reactions + starred
  // ids forces the toggled row to re-render instantly (matches the web).
  const listSignature = useMemo(() => {
    let sig = "";
    for (const m of messages) {
      sig += `${m.id}:${(m.reactions || [])
        .map((r) => `${r.userId}${r.emoji}`)
        .join(",")}:${m.pinned_at ? 1 : 0}:${m.deleted_at ? 1 : 0};`;
    }
    sig += `|starred:${Array.from(starredIds).join(",")}`;
    return sig;
  }, [messages, starredIds]);

  // Status line under the chat name (mirrors the web ChatHeader meta line):
  // member count for groups, live effective status for 1:1 chats.
  const headerSubtitle = isGroupConv
    ? participantCount
      ? `${participantCount} members`
      : ""
    : peerStatus
      ? STATUS_LABEL[peerStatus] || peerStatus
      : "";

  // Composer bottom inset (keyboard-aware).
  const composerBottomInset = Math.max(insets.bottom, kbInset) + 8;

  return {
    // identity / header
    name,
    headerAvatar,
    convId,
    isGroupConv,
    peerUserId,
    peerStatus,
    headerSubtitle,
    startCall,
    openHeaderPanel,
    // list
    loading,
    messages,
    listRef,
    listSignature,
    scrollToEnd,
    prependingRef,
    hasMore,
    loadOlder,
    loadingOlder,
    // bubble
    user,
    starredIds,
    participantCount,
    readReceipts,
    registerBubbleRef,
    openReactionBar,
    react,
    // typing / reply
    peerTyping,
    replyTo,
    setReplyTo,
    // pinned banner
    latestPin,
    pinnedMsgs,
    jumpToMessage,
    unpinFromBanner,
    // composer
    text,
    editingId,
    uploading,
    recorderState,
    composerBottomInset,
    onChangeText,
    send,
    saveEdit,
    setPlusOpen,
    startRecording,
    cancelRecording,
    stopRecordingAndSend,
    // inline emoji keyboard (Signal-style)
    inputRef,
    emojiKeyboardOpen,
    emojiKeyboardHeight: lastKbHeight.current,
    toggleEmojiKeyboard,
    insertEmoji,
    emojiBackspace,
    onComposerInputFocus,
    // attachment picker
    plusOpen,
    attachFile,
    attachDocument,
    setEmojiMode,
    setShowAllEmoji,
    // reaction bar / overlay
    reactTarget,
    reactAnchor,
    computeBarPosition,
    onReactionBarLayout,
    startReply,
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
    // dialog
    dialog,
  };
}