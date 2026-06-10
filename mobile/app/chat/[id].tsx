import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Stack, useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as Linking from "expo-linking";
import {
  CornerUpLeft,
  FileText,
  MoreVertical,
  Paperclip,
  Pencil,
  Pin,
  Send,
  Star,
  Trash2,
  X as XIcon,
} from "lucide-react-native";
import { theme } from "../../src/theme";
import { uploadUrl } from "../../src/config";
import { useAuth } from "../../src/auth/AuthContext";
import {
  deleteMessage,
  editMessage,
  forwardMessage,
  getConversations,
  getMessages,
  markConversationRead,
  pinMessage,
  starMessage,
  toggleReaction,
  uploadChatFile,
  type ChatMessage,
  type Conversation,
} from "../../src/features";
import { Forward } from "lucide-react-native";
import { socket } from "../../src/realtime/socket";
import {
  useKeyboardInset,
  scrollFocusedIntoView,
} from "../../src/hooks/useKeyboardInset";

const EMOJIS = ["\u{1F44D}", "\u2764\uFE0F", "\u{1F602}", "\u{1F62E}", "\u{1F622}", "\u{1F64F}"];

function isImageFile(m: ChatMessage): boolean {
  if (m.file_type && m.file_type.startsWith("image/")) return true;
  const name = (m.file_name || m.file_url || "").toLowerCase();
  return /\.(png|jpe?g|gif|webp|heic|bmp)$/.test(name);
}

function fmtSize(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function ChatThread() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const convId = Number(id);
  const insets = useSafeAreaInsets();
  const kbInset = useKeyboardInset();
  const { user } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [peerTyping, setPeerTyping] = useState(false);
  const [reactTarget, setReactTarget] = useState<ChatMessage | null>(null);
  const [actionTarget, setActionTarget] = useState<ChatMessage | null>(null);
  const [forwardTarget, setForwardTarget] = useState<ChatMessage | null>(null);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const typingSentAt = useRef(0);
  const typingClear = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const { data } = await getMessages(convId);
      setMessages(data || []);
      markConversationRead(convId).catch(() => {});
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [convId]);

  useEffect(() => {
    load();
  }, [load]);

  // Live incoming messages for this conversation.
  useEffect(() => {
    const off = socket.subscribe((msg) => {
      if (msg.type === "chat_typing") {
        if (Number(msg.data?.conversationId) !== convId) return;
        if (msg.data?.userId === user?.id) return;
        setPeerTyping(true);
        if (typingClear.current) clearTimeout(typingClear.current);
        typingClear.current = setTimeout(() => setPeerTyping(false), 3500);
        return;
      }
      if (msg.type !== "chat_message") return;
      const d = msg.data;
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
    });
    return off;
  }, [convId]);

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
  }, [text, user, convId, replyTo]);

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

  async function attachFile() {
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
      .catch(() => {});
  }

  function doPin(message: ChatMessage) {
    setActionTarget(null);
    pinMessage(message.id).catch(() => {});
  }

  function doStar(message: ChatMessage) {
    setActionTarget(null);
    starMessage(message.id).catch(() => {});
  }

  function startReply(message: ChatMessage) {
    setActionTarget(null);
    setReactTarget(null);
    setReplyTo(message);
  }

  function openForward(message: ChatMessage) {
    setActionTarget(null);
    setReactTarget(null);
    setForwardTarget(message);
    getConversations()
      .then((r) => setConversations(r.data || []))
      .catch(() => setConversations([]));
  }

  function doForward(targetConvId: number) {
    if (!forwardTarget) return;
    const msg = forwardTarget;
    setForwardTarget(null);
    forwardMessage(msg.id, [targetConvId])
      .then(() => {})
      .catch(() => {});
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

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: name || "Chat" }} />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.primary} />
        </View>
      ) : (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          keyboardVerticalOffset={90}
        >
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => String(m.id)}
            contentContainerStyle={styles.list}
            onContentSizeChange={() =>
              listRef.current?.scrollToEnd({ animated: false })
            }
            renderItem={({ item }) => {
              const mine = item.sender_id === user?.id;
              const deleted = !!item.deleted_at;
              // Aggregate reactions by emoji.
              const counts: Record<string, number> = {};
              (item.reactions || []).forEach((r) => {
                counts[r.emoji] = (counts[r.emoji] || 0) + 1;
              });
              return (
                <View
                  style={[styles.bubbleRow, mine ? styles.rowMine : styles.rowTheirs]}
                >
                  <View style={styles.bubbleCol}>
                    <Pressable
                      onLongPress={() =>
                        !deleted &&
                        (mine ? setActionTarget(item) : setReactTarget(item))
                      }
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
                      {/* Attachment: image inline, other files as a card */}
                      {item.file_url && !deleted ? (
                        isImageFile(item) ? (
                          <Image
                            source={{ uri: uploadUrl(item.file_url) || undefined }}
                            style={styles.fileImage}
                            resizeMode="cover"
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
                        {item.edited_at && !deleted ? (
                          <Text style={styles.edited}>edited</Text>
                        ) : null}
                        <Text style={styles.time}>{fmtTime(item.created_at)}</Text>
                      </View>
                    </Pressable>

                    {/* Reactions sit just below/outside the bubble */}
                    {Object.keys(counts).length > 0 ? (
                      <View
                        style={[
                          styles.reactions,
                          mine ? styles.reactionsMine : styles.reactionsTheirs,
                        ]}
                      >
                        {Object.entries(counts).map(([emoji, count]) => (
                          <Pressable
                            key={emoji}
                            style={styles.reactionChip}
                            onPress={() => react(item, emoji)}
                          >
                            <Text style={styles.reactionText}>
                              {emoji} {count > 1 ? count : ""}
                            </Text>
                          </Pressable>
                        ))}
                      </View>
                    ) : null}
                  </View>

                  {/* Always-visible ⋯ affordance (reliable tap fallback for
                      long-press, which can be flaky in release builds). */}
                  {!deleted ? (
                    <Pressable
                      style={styles.moreBtn}
                      hitSlop={8}
                      onPress={() =>
                        mine ? setActionTarget(item) : setReactTarget(item)
                      }
                    >
                      <MoreVertical size={16} color={theme.textMuted} />
                    </Pressable>
                  ) : null}
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
            <Pressable
              style={styles.attachBtn}
              onPress={attachFile}
              disabled={uploading || editingId != null}
            >
              {uploading ? (
                <ActivityIndicator size="small" color={theme.textSecondary} />
              ) : (
                <Paperclip size={20} color={theme.textSecondary} />
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
            <Pressable
              style={[styles.sendBtn, !text.trim() && styles.sendBtnDisabled]}
              onPress={editingId != null ? saveEdit : send}
              disabled={!text.trim()}
            >
              <Send size={18} color="#fff" />
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      )}

      {/* Emoji reaction picker */}
      <Modal
        visible={!!reactTarget}
        transparent
        animationType="fade"
        onRequestClose={() => setReactTarget(null)}
      >
        <Pressable style={styles.pickerOverlay} onPress={() => setReactTarget(null)}>
          <View style={styles.pickerWrap}>
            <View style={styles.picker}>
              {EMOJIS.map((e) => (
                <Pressable
                  key={e}
                  style={styles.pickerEmoji}
                  onPress={() => reactTarget && react(reactTarget, e)}
                >
                  <Text style={styles.pickerEmojiText}>{e}</Text>
                </Pressable>
              ))}
            </View>
            {reactTarget ? (
              <View style={styles.reactExtraRow}>
                <Pressable
                  style={styles.forwardRow}
                  onPress={() => reactTarget && startReply(reactTarget)}
                >
                  <CornerUpLeft size={16} color={theme.text} />
                  <Text style={styles.actionText}>Reply</Text>
                </Pressable>
                <Pressable
                  style={styles.forwardRow}
                  onPress={() => reactTarget && openForward(reactTarget)}
                >
                  <Forward size={16} color={theme.text} />
                  <Text style={styles.actionText}>Forward</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        </Pressable>
      </Modal>

      {/* Own-message action sheet (edit / pin / star / react / delete) */}
      <Modal
        visible={!!actionTarget}
        transparent
        animationType="fade"
        onRequestClose={() => setActionTarget(null)}
      >
        <Pressable
          style={styles.pickerOverlay}
          onPress={() => setActionTarget(null)}
        >
          <View style={styles.actionSheet}>
            {actionTarget ? (
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
                  onPress={() => actionTarget && startReply(actionTarget)}
                >
                  <CornerUpLeft size={18} color={theme.text} />
                  <Text style={styles.actionText}>Reply</Text>
                </Pressable>
                <Pressable
                  style={styles.actionRow}
                  onPress={() => actionTarget && doPin(actionTarget)}
                >
                  <Pin size={18} color={theme.text} />
                  <Text style={styles.actionText}>Pin</Text>
                </Pressable>
                <Pressable
                  style={styles.actionRow}
                  onPress={() => actionTarget && doStar(actionTarget)}
                >
                  <Star size={18} color={theme.text} />
                  <Text style={styles.actionText}>Star</Text>
                </Pressable>
                <Pressable
                  style={styles.actionRow}
                  onPress={() => actionTarget && openForward(actionTarget)}
                >
                  <Forward size={18} color={theme.text} />
                  <Text style={styles.actionText}>Forward</Text>
                </Pressable>
                <Pressable
                  style={styles.actionRow}
                  onPress={() => {
                    const t = actionTarget;
                    setActionTarget(null);
                    if (t) setReactTarget(t);
                  }}
                >
                  <Text style={styles.actionEmoji}>{"\u{1F642}"}</Text>
                  <Text style={styles.actionText}>React</Text>
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
          </View>
        </Pressable>
      </Modal>

      {/* Forward picker — choose a conversation to forward to */}
      <Modal
        visible={!!forwardTarget}
        transparent
        animationType="fade"
        onRequestClose={() => setForwardTarget(null)}
      >
        <Pressable
          style={styles.pickerOverlay}
          onPress={() => setForwardTarget(null)}
        >
          <View style={styles.forwardSheet}>
            <Text style={styles.forwardTitle}>Forward to…</Text>
            {conversations.length === 0 ? (
              <Text style={styles.forwardEmpty}>No conversations</Text>
            ) : (
              conversations.map((c) => (
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
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
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
  reactions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    marginTop: -6,
    marginHorizontal: 6,
  },
  reactionsMine: { justifyContent: "flex-end" },
  reactionsTheirs: { justifyContent: "flex-start" },
  reactExtraRow: { flexDirection: "row", gap: 8 },
  reactionChip: {
    backgroundColor: theme.bgElevated,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: 12,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  reactionText: { fontSize: 13, color: theme.text },
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
  picker: {
    flexDirection: "row",
    gap: 6,
    backgroundColor: theme.bgElevated,
    borderRadius: theme.radiusFull,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  pickerWrap: { alignItems: "center", gap: 8 },
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
  pickerEmoji: { padding: 6 },
  pickerEmojiText: { fontSize: 26 },
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
});