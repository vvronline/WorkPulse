import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as Linking from "expo-linking";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import {
  CornerUpLeft,
  FileText,
  Image as ImageIcon,
  Mic,
  MoreHorizontal,
  Pencil,
  Phone,
  Pin,
  Plus,
  Send,
  Smile,
  Star,
  Trash2,
  Video as VideoIcon,
  X as XIcon,
} from "lucide-react-native";
import { theme } from "../../src/theme";
import { uploadUrl } from "../../src/config";
import VoicePlayer from "../../src/components/VoicePlayer";
import { useAuth } from "../../src/auth/AuthContext";
import { useDialog } from "../../src/hooks/useDialog";
import {
  deleteMessage,
  editMessage,
  forwardMessage,
  getConversations,
  getChatPresence,
  getMessages,
  getPinnedMessages,
  getReadStatus,
  markConversationRead,
  pinMessage,
  starMessage,
  toggleReaction,
  uploadChatFile,
  type ChatMessage,
  type Conversation,
  type PinnedMessage,
} from "../../src/features";
import { Forward } from "lucide-react-native";
import { socket } from "../../src/realtime/socket";
import ChatAvatar from "../../src/components/ChatAvatar";
import {
  useKeyboardInset,
  scrollFocusedIntoView,
} from "../../src/hooks/useKeyboardInset";

// Quick-reaction row — matches the web MessageToolbar QUICK_EMOJIS exactly.
const EMOJIS = [
  "\u{1F44D}", // 👍
  "\u2764\uFE0F", // ❤️
  "\u{1F602}", // 😂
  "\u{1F62E}", // 😮
  "\u{1F525}", // 🔥
  "\u{1F389}", // 🎉
];

// Full emoji set for the "All Emoji" browser (grouped, common reactions).
const ALL_EMOJIS = [
  "\u{1F600}","\u{1F603}","\u{1F604}","\u{1F601}","\u{1F606}","\u{1F605}","\u{1F923}","\u{1F602}",
  "\u{1F642}","\u{1F643}","\u{1F609}","\u{1F60A}","\u{1F607}","\u{1F970}","\u{1F60D}","\u{1F929}",
  "\u{1F618}","\u{1F617}","\u{1F61A}","\u{1F619}","\u{1F60B}","\u{1F61B}","\u{1F61C}","\u{1F92A}",
  "\u{1F60E}","\u{1F913}","\u{1F9D0}","\u{1F914}","\u{1F910}","\u{1F644}","\u{1F60F}","\u{1F612}",
  "\u{1F62E}","\u{1F627}","\u{1F632}","\u{1F633}","\u{1F97A}","\u{1F622}","\u{1F62D}","\u{1F624}",
  "\u{1F620}","\u{1F621}","\u{1F92C}","\u{1F634}","\u{1F60C}","\u{1F614}","\u{1F61F}","\u{1F625}",
  "\u{1F44D}","\u{1F44E}","\u{1F44F}","\u{1F64C}","\u{1F450}","\u{1F932}","\u{1F91D}","\u{1F64F}",
  "\u270C\uFE0F","\u{1F91E}","\u{1F44C}","\u{1F90F}","\u{1F44A}","\u270A","\u{1F4AA}","\u{1F525}",
  "\u2764\uFE0F","\u{1F9E1}","\u{1F49B}","\u{1F49A}","\u{1F499}","\u{1F49C}","\u{1F5A4}","\u{1F90D}",
  "\u{1F389}","\u{1F38A}","\u2728","\u2B50","\u{1F31F}","\u{1F4AF}","\u2705","\u274C",
];

function isImageFile(m: ChatMessage): boolean {
  if (m.file_type && m.file_type.startsWith("image/")) return true;
  const name = (m.file_name || m.file_url || "").toLowerCase();
  return /\.(png|jpe?g|gif|webp|heic|bmp)$/.test(name);
}

function isAudioFile(m: ChatMessage): boolean {
  if (m.file_type && m.file_type.startsWith("audio/")) return true;
  const name = (m.file_name || m.file_url || "").toLowerCase();
  return /\.(m4a|mp3|aac|ogg|wav|webm)$/.test(name);
}

function fmtSize(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtRecTime(ms?: number): string {
  const total = Math.round((ms || 0) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * WhatsApp-style delivery indicator for the current user's own messages.
 * Mirrors the web `DeliveryStatus` component:
 *   ○  pending (optimistic, not yet acked by server)
 *   ✓  sent
 *   ✓✓ delivered (grey)
 *   ✓✓ read (blue)
 */
function MsgTicks({
  mine,
  msg,
  participantCount,
  readReceipts,
  userId,
}: {
  mine: boolean;
  msg: ChatMessage;
  participantCount: number;
  readReceipts: Record<number, string>;
  userId?: number;
}) {
  if (!mine) return null;
  if (msg._pending || msg.id < 0) {
    return <Text style={styles.tickSent}>○</Text>;
  }
  const others = (participantCount || 2) - 1;
  if (others <= 0) return null;

  const delivered = msg.delivered_to || [];
  const msgTime = new Date(msg.created_at).getTime();
  const otherReaders = Object.entries(readReceipts).filter(
    ([uid, readAt]) =>
      Number(uid) !== userId && new Date(readAt).getTime() >= msgTime,
  );

  if (
    otherReaders.length >= others ||
    (otherReaders.length > 0 && delivered.length >= others)
  ) {
    return <Text style={styles.tickRead}>✓✓</Text>;
  }
  if (delivered.length >= others || delivered.length > 0) {
    return <Text style={styles.tickDelivered}>✓✓</Text>;
  }
  return <Text style={styles.tickSent}>✓</Text>;
}

export default function ChatThread() {
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
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const kbInset = useKeyboardInset();
  const { width: winWidth, height: winHeight } = useWindowDimensions();
  const { user } = useAuth();
  const { alert, dialog } = useDialog();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
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
  // Voice recording (expo-audio).
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  // Bubble host-node refs so we can reliably measure each bubble's window rect
  // for the reaction-bar anchor (Pressable forwards its ref to the host View,
  // which exposes measureInWindow — currentTarget often does not).
  const bubbleRefs = useRef<Map<number, View>>(new Map());
  const typingSentAt = useRef(0);
  const typingClear = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scrollToEnd = useCallback((animated = false) => {
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated });
    });
  }, []);

  const loadPinned = useCallback(() => {
    getPinnedMessages(convId)
      .then((r) => setPinnedMsgs(r.data || []))
      .catch(() => {});
  }, [convId]);

  const load = useCallback(async () => {
    try {
      const { data } = await getMessages(convId);
      setMessages(data || []);
      markConversationRead(convId).catch(() => {});
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
  }, [convId, scrollToEnd]);

  useEffect(() => {
    load();
    loadPinned();
  }, [load, loadPinned]);

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
      markConversationRead(convId).catch(() => {});
      scrollToEnd(true);
    });
    return off;
  }, [convId, user?.id, loadPinned, scrollToEnd]);

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
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) return;
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch {
      /* ignore */
    }
  }

  async function stopRecordingAndSend() {
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) return;
      setUploading(true);
      const fileName = `voice-${Date.now()}.m4a`;
      const { data } = await uploadChatFile(convId, uri, fileName);
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

  async function cancelRecording() {
    try {
      await recorder.stop();
    } catch {
      /* ignore */
    }
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

  function startReply(message: ChatMessage) {
    setActionTarget(null);
    setReactTarget(null);
    setReplyTo(message);
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
    try {
      await toggleReaction(message.id, emoji);
    } catch {
      /* ignore */
    }
    // Optimistically reflect locally; server fan-out keeps others in sync.
    setMessages((prev) =>
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
      }),
    );
  }

  function pickEmoji(emoji: string) {
    if (emojiMode === "compose") {
      setText((t) => t + emoji);
    } else if (reactTarget) {
      react(reactTarget, emoji);
    }
    setShowAllEmoji(false);
  }

  function startCall(type: "voice" | "video") {
    router.push({
      pathname: "/call/[conversationId]",
      params: {
        conversationId: String(convId),
        mode: "outgoing",
        callType: type,
        peerName: name || "Call",
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

  const latestPin = pinnedMsgs[0];

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          title: name || "Chat",
          headerTitle: () => (
            <View style={styles.headerTitleWrap}>
              <ChatAvatar
                name={name}
                avatar={headerAvatar}
                size={32}
                userStatus={peerUserId ? peerStatus : undefined}
                ringColor={theme.bg}
              />
              <Text style={styles.headerTitleText} numberOfLines={1}>
                {name || "Chat"}
              </Text>
            </View>
          ),
          headerRight: () => (
            <View style={styles.headerActions}>
              <Pressable onPress={() => startCall("voice")} hitSlop={8}>
                <Phone size={20} color={theme.primary} />
              </Pressable>
              <Pressable onPress={() => startCall("video")} hitSlop={8}>
                <VideoIcon size={20} color={theme.primary} />
              </Pressable>
            </View>
          ),
        }}
      />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.primary} />
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          {/* Pinned-messages banner at the top of the chat. */}
          {latestPin ? (
            <Pressable
              style={styles.pinBanner}
              onPress={() => jumpToMessage(latestPin.id)}
            >
              <Pin size={15} color={theme.primary} />
              <View style={{ flex: 1 }}>
                <Text style={styles.pinBannerLabel} numberOfLines={1}>
                  Pinned{pinnedMsgs.length > 1 ? ` · ${pinnedMsgs.length}` : ""}
                  {latestPin.sender_name ? ` · ${latestPin.sender_name}` : ""}
                </Text>
                <Text style={styles.pinBannerText} numberOfLines={1}>
                  {latestPin.content ||
                    (latestPin.file_name
                      ? `📎 ${latestPin.file_name}`
                      : "🎤 Voice message")}
                </Text>
              </View>
              <Pressable
                hitSlop={8}
                onPress={() => unpinFromBanner(latestPin.id)}
              >
                <XIcon size={16} color={theme.textSecondary} />
              </Pressable>
            </Pressable>
          ) : null}

          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => String(m.id)}
            contentContainerStyle={styles.list}
            onContentSizeChange={() => scrollToEnd(false)}
            onScrollToIndexFailed={() => {
              setTimeout(() => scrollToEnd(false), 200);
            }}
            renderItem={({ item }) => {
              const mine = item.sender_id === user?.id;
              const deleted = !!item.deleted_at;
              const starred = starredIds.has(item.id);
              const pinned = !!item.pinned_at;
              // Aggregate reactions by emoji.
              const groups: Record<
                string,
                { count: number; mine: boolean }
              > = {};
              (item.reactions || []).forEach((r) => {
                if (!groups[r.emoji]) groups[r.emoji] = { count: 0, mine: false };
                groups[r.emoji].count += 1;
                if (r.userId === user?.id) groups[r.emoji].mine = true;
              });
              return (
                <View
                  style={[styles.bubbleRow, mine ? styles.rowMine : styles.rowTheirs]}
                >
                  <View style={styles.bubbleCol}>
                    <Pressable
                      ref={(node) => {
                        if (node) bubbleRefs.current.set(item.id, node as unknown as View);
                        else bubbleRefs.current.delete(item.id);
                      }}
                      onLongPress={() => {
                        if (deleted) return;
                        openReactionBar(item, mine);
                      }}
                      delayLongPress={250}
                      style={[
                        styles.bubble,
                        mine ? styles.bubbleMine : styles.bubbleTheirs,
                        item._pending && styles.bubblePending,
                      ]}
                    >
                      {!mine && item.sender_name ? (
                        <Text style={styles.sender}>{item.sender_name}</Text>
                      ) : null}
                      {/* Quoted reply preview */}
                      {item.reply_to_id && !deleted ? (
                        <View style={styles.replyQuote}>
                          <Text style={styles.replyQuoteName} numberOfLines={1}>
                            {item.reply_to_sender_name || "Reply"}
                          </Text>
                          <Text style={styles.replyQuoteText} numberOfLines={1}>
                            {item.reply_to_content || "Attachment"}
                          </Text>
                        </View>
                      ) : null}
                      {/* Attachment: image inline, audio player, else file card */}
                      {item.file_url && !deleted ? (
                        isImageFile(item) ? (
                          <Image
                            source={{ uri: uploadUrl(item.file_url) || undefined }}
                            style={styles.fileImage}
                            resizeMode="cover"
                          />
                        ) : isAudioFile(item) ? (
                          <VoicePlayer
                            uri={uploadUrl(item.file_url) || ""}
                          />
                        ) : (
                          <Pressable
                            style={styles.fileCard}
                            onPress={() => {
                              const u = uploadUrl(item.file_url);
                              if (u) Linking.openURL(u);
                            }}
                          >
                            <FileText size={20} color={theme.primary} />
                            <View style={{ flex: 1 }}>
                              <Text style={styles.fileName} numberOfLines={1}>
                                {item.file_name || "File"}
                              </Text>
                              {item.file_size ? (
                                <Text style={styles.fileSize}>
                                  {fmtSize(item.file_size)}
                                </Text>
                              ) : null}
                            </View>
                          </Pressable>
                        )
                      ) : null}
                      {item.content || deleted ? (
                        <Text style={[styles.content, deleted && styles.deleted]}>
                          {deleted ? "This message was deleted" : item.content}
                        </Text>
                      ) : null}
                      <View style={styles.metaLine}>
                        {pinned ? (
                          <Pin size={10} color={theme.textMuted} />
                        ) : null}
                        {starred ? (
                          <Star size={10} color={theme.warning} />
                        ) : null}
                        {item.edited_at && !deleted ? (
                          <Text style={styles.edited}>edited</Text>
                        ) : null}
                        <Text style={styles.time}>{fmtTime(item.created_at)}</Text>
                        <MsgTicks
                          mine={mine}
                          msg={item}
                          participantCount={participantCount}
                          readReceipts={readReceipts}
                          userId={user?.id}
                        />
                      </View>
                    </Pressable>

                    {/* Reactions render as a separate row BELOW the bubble
                        (outside it), exactly like the web MessageBubble. */}
                    {Object.keys(groups).length > 0 ? (
                      <View
                        style={[
                          styles.reactions,
                          mine ? styles.reactionsMine : styles.reactionsTheirs,
                        ]}
                      >
                        {Object.entries(groups).map(([emoji, g]) => (
                          <Pressable
                            key={emoji}
                            style={[
                              styles.reactionChip,
                              g.mine && styles.myReactionChip,
                            ]}
                            onPress={() => react(item, emoji)}
                          >
                            <Text style={styles.reactionEmoji}>{emoji}</Text>
                            <Text style={styles.reactionCount}>{g.count}</Text>
                          </Pressable>
                        ))}
                        <Pressable
                          style={styles.addReactionBtn}
                          onPress={() => openReactionBar(item, mine)}
                        >
                          <Plus size={13} color={theme.textMuted} />
                        </Pressable>
                      </View>
                    ) : null}
                  </View>
                </View>
              );
            }}
          />
          {peerTyping ? (
            <Text style={styles.typing}>typing…</Text>
          ) : null}
          {/* Reply composing strip */}
          {replyTo ? (
            <View style={styles.replyBar}>
              <CornerUpLeft size={16} color={theme.primary} />
              <View style={{ flex: 1 }}>
                <Text style={styles.replyBarName} numberOfLines={1}>
                  Replying to {replyTo.sender_name || "message"}
                </Text>
                <Text style={styles.replyBarText} numberOfLines={1}>
                  {replyTo.content || "Attachment"}
                </Text>
              </View>
              <Pressable onPress={() => setReplyTo(null)} hitSlop={8}>
                <XIcon size={18} color={theme.textSecondary} />
              </Pressable>
            </View>
          ) : null}
          <View
            style={[
              styles.inputBar,
              { paddingBottom: Math.max(insets.bottom, kbInset) + 8 },
            ]}
          >
            {recorderState.isRecording ? (
              <>
                <Pressable
                  style={styles.attachBtn}
                  onPress={cancelRecording}
                  hitSlop={6}
                >
                  <XIcon size={22} color={theme.danger} />
                </Pressable>
                <View style={styles.recordingBar}>
                  <View style={styles.recDot} />
                  <Text style={styles.recText}>
                    Recording… {fmtRecTime(recorderState.durationMillis)}
                  </Text>
                </View>
                <Pressable
                  style={styles.sendBtn}
                  onPress={stopRecordingAndSend}
                >
                  <Send size={18} color="#fff" />
                </Pressable>
              </>
            ) : (
              <>
                <Pressable
                  style={styles.attachBtn}
                  onPress={() => setPlusOpen(true)}
                  disabled={uploading || editingId != null}
                >
                  {uploading ? (
                    <ActivityIndicator
                      size="small"
                      color={theme.textSecondary}
                    />
                  ) : (
                    <Plus size={22} color={theme.textSecondary} />
                  )}
                </Pressable>
                <TextInput
                  style={styles.input}
                  placeholder={editingId != null ? "Edit message" : "Message"}
                  placeholderTextColor={theme.textMuted}
                  value={text}
                  onChangeText={onChangeText}
                  onFocus={scrollFocusedIntoView}
                  multiline
                />
                {text.trim() || editingId != null ? (
                  <Pressable
                    style={styles.sendBtn}
                    onPress={editingId != null ? saveEdit : send}
                  >
                    <Send size={18} color="#fff" />
                  </Pressable>
                ) : (
                  <Pressable
                    style={styles.sendBtn}
                    onPress={startRecording}
                    disabled={uploading}
                  >
                    <Mic size={18} color="#fff" />
                  </Pressable>
                )}
              </>
            )}
          </View>
        </View>
      )}

      {/* "+" composer menu — Photo/File, Voice message, Emoji (mirrors the web
          ChatInputBar plus menu). */}
      <Modal
        visible={plusOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setPlusOpen(false)}
      >
        <Pressable style={styles.plusOverlay} onPress={() => setPlusOpen(false)}>
          <View style={styles.plusSheet}>
            <Pressable style={styles.plusRow} onPress={attachFile}>
              <ImageIcon size={20} color={theme.text} />
              <Text style={styles.plusText}>Photo / File</Text>
            </Pressable>
            <Pressable
              style={styles.plusRow}
              onPress={() => {
                setPlusOpen(false);
                startRecording();
              }}
            >
              <Mic size={20} color={theme.text} />
              <Text style={styles.plusText}>Voice message</Text>
            </Pressable>
            <Pressable
              style={styles.plusRow}
              onPress={() => {
                setPlusOpen(false);
                setEmojiMode("compose");
                setShowAllEmoji(true);
              }}
            >
              <Smile size={20} color={theme.text} />
              <Text style={styles.plusText}>Emoji</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* Emoji reaction bar — STRICTLY matches the web screenshot: one single
          horizontal pill row → quick emojis · smiley(all emoji) · divider ·
          reply · ⋯(more). */}
      <Modal
        visible={!!reactTarget}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setReactTarget(null);
          setReactAnchor(null);
        }}
      >
        <Pressable
          style={styles.pickerOverlay}
          onPress={() => {
            setReactTarget(null);
            setReactAnchor(null);
          }}
        >
          <Pressable
            style={[styles.pickerBar, computeBarPosition()]}
            onPress={() => {}}
            onLayout={(e) => {
              const { width, height } = e.nativeEvent.layout;
              if (
                Math.abs(width - barSize.width) > 1 ||
                Math.abs(height - barSize.height) > 1
              ) {
                setBarSize({ width, height });
              }
            }}
          >
            {EMOJIS.map((e) => (
              <Pressable
                key={e}
                style={styles.emojiBtn}
                onPress={() => reactTarget && react(reactTarget, e)}
              >
                <Text style={styles.emojiText}>{e}</Text>
              </Pressable>
            ))}
            <Pressable
              style={styles.barIconBtn}
              onPress={() => {
                setEmojiMode("react");
                setShowAllEmoji(true);
              }}
            >
              <Smile size={18} color={theme.textSecondary} />
            </Pressable>
            <View style={styles.barDivider} />
            <Pressable
              style={styles.barIconBtn}
              onPress={() => reactTarget && startReply(reactTarget)}
            >
              <CornerUpLeft size={17} color={theme.textSecondary} />
            </Pressable>
            <Pressable
              style={styles.barIconBtn}
              onPress={() => {
                const t = reactTarget;
                setReactTarget(null);
                if (t) setActionTarget(t);
              }}
            >
              <MoreHorizontal size={17} color={theme.textSecondary} />
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Full emoji grid (opened from "All Emoji" or the composer "+"). */}
      <Modal
        visible={showAllEmoji}
        transparent
        animationType="slide"
        onRequestClose={() => setShowAllEmoji(false)}
      >
        <View style={styles.allOverlay}>
          <Pressable
            style={styles.allScrim}
            onPress={() => setShowAllEmoji(false)}
          />
          <View style={styles.allSheet}>
            <View style={styles.allHeader}>
              <Text style={styles.allTitle}>
                {emojiMode === "compose" ? "Insert emoji" : "Pick a reaction"}
              </Text>
              <Pressable onPress={() => setShowAllEmoji(false)} hitSlop={8}>
                <XIcon size={22} color={theme.textSecondary} />
              </Pressable>
            </View>
            <FlatList
              data={ALL_EMOJIS}
              keyExtractor={(e, i) => `${e}-${i}`}
              numColumns={8}
              contentContainerStyle={styles.allGrid}
              renderItem={({ item: e }) => (
                <Pressable
                  style={styles.gridEmoji}
                  onPress={() => pickEmoji(e)}
                >
                  <Text style={styles.gridEmojiText}>{e}</Text>
                </Pressable>
              )}
            />
          </View>
        </View>
      </Modal>

      {/* Message action sheet (forward / save / pin / edit / delete). The
          same modal switches to the "Forward to…" picker via forwardMode —
          a single modal avoids the Android dismiss/present race that broke
          Forward when it was a separate modal. */}
      <Modal
        visible={!!actionTarget}
        transparent
        animationType="fade"
        onRequestClose={closeActionSheet}
      >
        <Pressable
          style={styles.pickerOverlay}
          onPress={closeActionSheet}
        >
          {forwardMode ? (
            <View style={styles.forwardSheet}>
              <Text style={styles.forwardTitle}>Forward to…</Text>
              <ScrollView style={{ maxHeight: 360 }}>
                {conversations.filter((c) => c.id !== convId).length === 0 ? (
                  <Text style={styles.forwardEmpty}>No conversations</Text>
                ) : (
                  conversations
                    .filter((c) => c.id !== convId)
                    .map((c) => (
                      <Pressable
                        key={c.id}
                        style={styles.forwardConv}
                        onPress={() => doForward(c.id)}
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
            </View>
          ) : (
          <View style={styles.actionSheet}>
            {actionTarget ? (
              <>
                <Pressable
                  style={styles.actionRow}
                  onPress={openForward}
                >
                  <Forward size={18} color={theme.text} />
                  <Text style={styles.actionText}>Forward</Text>
                </Pressable>
                <Pressable
                  style={styles.actionRow}
                  onPress={() => actionTarget && doStar(actionTarget)}
                >
                  <Star size={18} color={theme.text} />
                  <Text style={styles.actionText}>
                    {actionTarget && starredIds.has(actionTarget.id)
                      ? "Unsave"
                      : "Save"}
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.actionRow}
                  onPress={() => actionTarget && doPin(actionTarget)}
                >
                  <Pin size={18} color={theme.text} />
                  <Text style={styles.actionText}>
                    {actionTarget?.pinned_at ? "Unpin" : "Pin"}
                  </Text>
                </Pressable>
                {actionTarget.sender_id === user?.id ? (
                  <>
                    <Pressable
                      style={styles.actionRow}
                      onPress={() => actionTarget && startEdit(actionTarget)}
                    >
                      <Pencil size={18} color={theme.text} />
                      <Text style={styles.actionText}>Edit</Text>
                    </Pressable>
                    <Pressable
                      style={styles.actionRow}
                      onPress={() => actionTarget && doDelete(actionTarget)}
                    >
                      <Trash2 size={18} color={theme.danger} />
                      <Text style={[styles.actionText, { color: theme.danger }]}>
                        Delete
                      </Text>
                    </Pressable>
                  </>
                ) : null}
              </>
            ) : null}
          </View>
          )}
        </Pressable>
      </Modal>

      {dialog}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  headerActions: { flexDirection: "row", gap: 18, alignItems: "center" },
  headerTitleWrap: { flexDirection: "row", alignItems: "center", gap: 10 },
  headerTitleText: {
    fontSize: 17,
    fontWeight: "700",
    color: theme.text,
    maxWidth: 180,
  },
  pinBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: theme.bgSecondary,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  pinBannerLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: theme.primaryLight,
  },
  pinBannerText: { fontSize: 13, color: theme.textSecondary },
  list: { padding: 12, gap: 8, paddingBottom: 16 },
  bubbleRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  rowMine: { justifyContent: "flex-end" },
  rowTheirs: { justifyContent: "flex-start" },
  bubbleCol: { maxWidth: "82%" },
  moreBtn: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  bubble: {
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 2,
  },
  bubbleMine: {
    backgroundColor: "rgba(35,131,226,0.18)",
    borderWidth: 1,
    borderColor: "rgba(35,131,226,0.25)",
  },
  bubbleTheirs: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  bubblePending: { opacity: 0.6 },
  sender: { fontSize: 11, fontWeight: "700", color: theme.primaryLight },
  content: { fontSize: 15, color: theme.text, lineHeight: 20 },
  deleted: { fontStyle: "italic", color: theme.textMuted },
  metaLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-end",
  },
  edited: { fontSize: 10, color: theme.textMuted, fontStyle: "italic" },
  time: { fontSize: 10, color: theme.textMuted },
  tickSent: { fontSize: 11, color: theme.textMuted },
  tickDelivered: { fontSize: 11, color: theme.textMuted },
  tickRead: { fontSize: 11, color: theme.primary, fontWeight: "700" },
  replyQuote: {
    borderLeftWidth: 3,
    borderLeftColor: theme.primary,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginBottom: 4,
    gap: 1,
  },
  replyQuoteName: { fontSize: 11, fontWeight: "700", color: theme.primaryLight },
  replyQuoteText: { fontSize: 12, color: theme.textSecondary },
  fileCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: theme.bgElevated,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: 10,
    padding: 10,
    marginBottom: 4,
    minWidth: 180,
  },
  fileName: { fontSize: 14, color: theme.text, fontWeight: "500" },
  fileSize: { fontSize: 11, color: theme.textMuted },
  fileImage: {
    width: 200,
    height: 150,
    borderRadius: 10,
    marginBottom: 4,
    backgroundColor: theme.surface,
  },
  // Reaction chips row BELOW the bubble (web .reactions: margin-top 4px).
  reactions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 4,
    marginTop: 4,
    paddingHorizontal: 2,
  },
  reactionsMine: { justifyContent: "flex-end" },
  reactionsTheirs: { justifyContent: "flex-start" },
  reactExtraRow: { flexDirection: "row", gap: 8 },
  reactionChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusFull,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  myReactionChip: {
    backgroundColor: "rgba(35,131,226,0.18)",
    borderColor: "rgba(35,131,226,0.35)",
  },
  reactionEmoji: { fontSize: 15 },
  reactionCount: { fontSize: 11, color: theme.textSecondary, fontWeight: "600" },
  addReactionBtn: {
    width: 26,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusFull,
  },
  typing: {
    color: theme.textMuted,
    fontSize: 12,
    fontStyle: "italic",
    paddingHorizontal: 16,
    paddingBottom: 4,
  },
  pickerOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  // Single horizontal reaction bar matching the web screenshot: rounded pill,
  // quick emojis, then a smiley (all-emoji), divider, reply, and ⋯ (more).
  pickerBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.bgSecondary,
    borderRadius: theme.radiusFull,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    paddingHorizontal: 4,
    paddingVertical: 3,
    maxWidth: "96%",
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  emojiBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
  },
  emojiText: { fontSize: 20 },
  barIconBtn: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 15,
  },
  barDivider: {
    width: 1,
    height: 20,
    backgroundColor: theme.glassBorder,
    marginHorizontal: 2,
  },
  allOverlay: { flex: 1, justifyContent: "flex-end" },
  allScrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  allSheet: {
    backgroundColor: theme.bgElevated,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 24,
    maxHeight: "60%",
  },
  allHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 6,
    paddingBottom: 10,
  },
  allTitle: { fontSize: 16, fontWeight: "700", color: theme.text },
  allGrid: { gap: 2 },
  gridEmoji: {
    flex: 1,
    aspectRatio: 1,
    alignItems: "center",
    justifyContent: "center",
    maxWidth: `${100 / 8}%`,
  },
  gridEmojiText: { fontSize: 28 },
  replyBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: theme.bgSecondary,
    borderTopWidth: 1,
    borderTopColor: theme.border,
  },
  replyBarName: { fontSize: 12, fontWeight: "700", color: theme.primaryLight },
  replyBarText: { fontSize: 12, color: theme.textSecondary },
  plusOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  plusSheet: {
    backgroundColor: theme.bgElevated,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingVertical: 8,
    paddingBottom: 28,
  },
  plusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 22,
    paddingVertical: 14,
  },
  plusText: { fontSize: 16, color: theme.text, fontWeight: "500" },
  forwardRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: theme.bgElevated,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusFull,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  forwardSheet: {
    backgroundColor: theme.bgElevated,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    paddingVertical: 8,
    minWidth: 260,
    maxHeight: "70%",
  },
  forwardTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: theme.text,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  forwardEmpty: {
    fontSize: 13,
    color: theme.textMuted,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  forwardConv: { paddingHorizontal: 18, paddingVertical: 12 },
  forwardConvName: { fontSize: 15, color: theme.text },
  actionSheet: {
    backgroundColor: theme.bgElevated,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    paddingVertical: 6,
    minWidth: 200,
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  actionText: { fontSize: 15, color: theme.text, fontWeight: "500" },
  actionEmoji: { fontSize: 18, width: 18, textAlign: "center" },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: theme.border,
    backgroundColor: theme.bgSecondary,
  },
  attachBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  input: {
    flex: 1,
    maxHeight: 120,
    backgroundColor: theme.inputBg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: theme.text,
    fontSize: 15,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnDisabled: { opacity: 0.4 },
  recordingBar: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: theme.inputBg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: theme.danger },
  recText: { color: theme.text, fontSize: 14 },
});