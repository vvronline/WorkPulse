import { useCallback, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { TextInput } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useAuth } from "../../auth/AuthContext";
import { socket } from "../../realtime/socket";
import {
  editMessage,
  uploadChatFile,
  type ChatMessage,
} from "../../features";
import {
  enqueueOutboxMessage,
  markOutboxRetrying,
} from "../../storage/chatOutbox";
import { replaceUploadedMessage } from "./chatMessageReducers";
import { normalizeUploadedMessage } from "./chatThreadMessageUtils";
import type { ReactionAnchor } from "./useChatMessageContextMenu";
import type { PendingMediaSource } from "./useMobileConversationDraft";

type ThreadUser = ReturnType<typeof useAuth>["user"];

type UseChatComposerActionsOptions = {
  convId: number;
  user: ThreadUser;
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  inputRef: RefObject<TextInput | null>;
  requestTailScroll: (animated?: boolean) => void;
  scrollToEnd: (animated?: boolean) => void;
  setReactTarget: Dispatch<SetStateAction<ChatMessage | null>>;
  setReactAnchor: Dispatch<SetStateAction<ReactionAnchor | null>>;
  setActionTarget: Dispatch<SetStateAction<ChatMessage | null>>;
  selectedMessages: ChatMessage[];
  clearSelection: () => void;
  mediaUploadControllers: RefObject<Map<number, AbortController>>;
  mediaUploadSources: RefObject<Map<number, PendingMediaSource>>;
  setUploading: Dispatch<SetStateAction<boolean>>;
};

/**
 * Composer-driven message actions: reply targeting, send (durable outbox +
 * optimistic bubble), retry of a failed text/media send, typing pings, and the
 * edit lifecycle (start / save / cancel).
 */
export default function useChatComposerActions({
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
}: UseChatComposerActionsOptions) {
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const typingSentAt = useRef(0);

  const send = useCallback(() => {
    const content = text.trim();
    if (!content || !user) return;
    const clientMsgId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const replyToId = replyTo?.id;
    const createdAt = new Date().toISOString();
    // Persist to the durable OUTBOX first (Signal-Android model: write the
    // message locally before attempting delivery). If the socket is down
    // (offline) the message is NOT lost — it survives leaving the screen and
    // app restarts, and ChatOutboxSync auto-delivers it (same clientMsgId, so
    // no duplicates) the moment the socket reconnects.
    enqueueOutboxMessage({
      clientMsgId,
      conversationId: convId,
      content,
      replyToId: replyToId ?? null,
      replyToContent: replyTo?.content ?? null,
      replyToSenderName: replyTo?.sender_name ?? null,
      replyToFileUrl: replyTo?.file_url ?? null,
      replyToFileType: replyTo?.file_type ?? null,
      replyToFileName: replyTo?.file_name ?? null,
      createdAt,
      attempts: 0,
    });
    // Optimistic append. Keep the loaded history intact; sending and scrolling
    // must never swap the list's data window underneath FlashList.
    setMessages((prev) => [
      ...prev,
      {
        id: -Date.now(),
        sender_id: user.id,
        sender_name: user.full_name,
        content,
        created_at: createdAt,
        reply_to_id: replyToId ?? null,
        reply_to_content: replyTo?.content ?? null,
        reply_to_sender_name: replyTo?.sender_name ?? null,
        reply_to_file_url: replyTo?.file_url ?? null,
        reply_to_file_type: replyTo?.file_type ?? null,
        reply_to_file_name: replyTo?.file_name ?? null,
        _pending: true,
        clientMsgId,
      },
    ]);
    const sentNow = socket.send("chat_message", {
      conversationId: convId,
      content,
      clientMsgId,
      ...(replyToId ? { replyToId } : {}),
    });
    if (!sentNow) {
      // Socket is down (offline / reconnecting). Kick a reconnect attempt —
      // the outbox flush on the next OPEN transition will deliver the message.
      // The bubble stays in the "pending" (clock) state meanwhile.
      void socket.connect();
    }
    setText("");
    setReplyTo(null);
    requestTailScroll(true);
  }, [text, user, convId, replyTo, requestTailScroll, setMessages, setText]);

  const retryFailedMessage = useCallback(
    (message: ChatMessage) => {
      if (Number(message.id) < 0 && message.file_url) {
        const id = Number(message.id);
        const source = mediaUploadSources.current?.get(id);
        if (!source) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === id
              ? {
                  ...m,
                  _pending: true,
                  _failed: false,
                  _mediaState: "queued",
                  _mediaProgress: 0,
                  _failureReason: null,
                }
              : m,
          ),
        );
        const controller = new AbortController();
        mediaUploadControllers.current?.set(id, controller);
        setUploading(true);
        uploadChatFile(convId, source.uri, source.fileName, source.mimeType, {
          signal: controller.signal,
          viewOnce: source.viewOnce,
          caption: source.caption,
          width: source.width,
          height: source.height,
          quality: source.quality,
          onUploadProgress: (evt) => {
            const total = evt.total || 0;
            const progress =
              total > 0
                ? Math.max(
                    0,
                    Math.min(100, Math.round((evt.loaded / total) * 100)),
                  )
                : 0;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === id
                  ? { ...m, _mediaState: "uploading", _mediaProgress: progress }
                  : m,
              ),
            );
          },
        })
          .then(({ data }) => {
            const normalized = normalizeUploadedMessage(data);
            setMessages((prev) =>
              replaceUploadedMessage(prev, id, normalized),
            );
            mediaUploadControllers.current?.delete(id);
            mediaUploadSources.current?.delete(id);
            if (mediaUploadControllers.current?.size === 0) setUploading(false);
          })
          .catch((e: any) => {
            mediaUploadControllers.current?.delete(id);
            if (mediaUploadControllers.current?.size === 0) setUploading(false);
            const cancelled =
              e?.name === "CanceledError" ||
              e?.code === "ERR_CANCELED" ||
              e?.message === "canceled";
            setMessages((prev) =>
              prev.map((m) =>
                m.id === id
                  ? {
                      ...m,
                      _pending: false,
                      _failed: true,
                      _mediaState: "failed",
                      _failureReason: cancelled
                        ? "Upload cancelled"
                        : e?.response?.data?.error ||
                          "Could not send this media.",
                    }
                  : m,
              ),
            );
          });
        return;
      }
      if (!user) return;
      const content = (message.content || "").trim();
      const clientMsgId = message.clientMsgId || null;
      if (!content || !clientMsgId) return;
      const replyToId = message.reply_to_id || null;

      // Refresh / re-arm the durable outbox entry so the retry also benefits
      // from the reconnect auto-flush (and survives leaving the screen).
      markOutboxRetrying(clientMsgId);
      enqueueOutboxMessage({
        clientMsgId,
        conversationId: convId,
        content,
        replyToId,
        replyToContent: message.reply_to_content ?? null,
        replyToSenderName: message.reply_to_sender_name ?? null,
        replyToFileUrl: message.reply_to_file_url ?? null,
        replyToFileType: message.reply_to_file_type ?? null,
        replyToFileName: message.reply_to_file_name ?? null,
        createdAt: new Date().toISOString(),
        attempts: 0,
      });

      setMessages((prev) =>
        prev.map((m) =>
          m.clientMsgId === clientMsgId
            ? {
                ...m,
                _failed: false,
                _pending: true,
                _failureReason: null,
                created_at: new Date().toISOString(),
              }
            : m,
        ),
      );

      const sentNow = socket.send("chat_message", {
        conversationId: convId,
        content,
        clientMsgId,
        ...(replyToId ? { replyToId } : {}),
      });
      if (!sentNow) {
        void socket.connect();
      }
    },
    [convId, scrollToEnd, user],
  );

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
    [convId, setText],
  );

  function startReply(message: ChatMessage) {
    setActionTarget(null);
    setReactTarget(null);
    setReactAnchor(null);
    setReplyTo(message);
    // Signal opens the keyboard with the cursor in the composer the moment you
    // swipe-to-reply (or tap Reply). Focus after the reply strip + any
    // dismissing overlay have settled so the keyboard reliably raises on
    // Android (focusing while a modal is up, or before the reply strip mounts,
    // is dropped).
    setTimeout(() => inputRef.current?.focus(), 120);
  }

  // Copy a message's text to the clipboard (overlay "Copy" action).
  function copyMessage(message: ChatMessage) {
    setReactTarget(null);
    setReactAnchor(null);
    if (message.content) {
      Clipboard.setStringAsync(message.content).catch(() => {});
    }
  }

  // Copy the text of every selected message to the clipboard, joined by
  // newlines (header copy icon).
  function copySelected() {
    const text = selectedMessages
      .map((m) => m.content || "")
      .filter((s) => s.trim().length > 0)
      .join("\n");
    clearSelection();
    if (text) Clipboard.setStringAsync(text).catch(() => {});
  }

  // Cancel an in-progress edit (Signal-style "X" on the editing strip). Clears
  // the editing target and the prefilled draft text.
  function cancelEdit() {
    setEditingId(null);
    setText("");
  }

  function startEdit(message: ChatMessage) {
    // Tear down BOTH long-press surfaces. Editing can be triggered from the
    // long-press reaction overlay (driven by reactTarget/reactAnchor) OR the
    // action sheet (actionTarget). Previously startEdit only cleared
    // actionTarget, so when reached via the long-press overlay the dimmed
    // ReactionOverlay modal stayed ON TOP of the screen and the edit never
    // appeared to take. Clear all three, load the draft, then focus the
    // composer so the system keyboard opens ready to edit.
    setReactTarget(null);
    setReactAnchor(null);
    setActionTarget(null);
    setEditingId(message.id);
    setText(message.content);
    // Focus after the overlay/sheet modals have dismissed so the keyboard
    // reliably opens (focusing while a modal is still up is dropped on Android).
    setTimeout(() => inputRef.current?.focus(), 150);
  }

  async function saveEdit() {
    if (editingId == null) return;
    const content = text.trim();
    if (!content) return;
    try {
      // The server's PUT /chat/messages/:id returns only { ok: true } — it does
      // NOT echo the edited content. Relying on `data.content` therefore blanked
      // the message body (leaving just the "edited" label) until the chat was
      // reopened. Apply the edit OPTIMISTICALLY from the text we just sent and
      // stamp `edited_at` so the "edited" label + new content show immediately
      // (Signal applies edits locally, never waiting for a content echo).
      await editMessage(editingId, content);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === editingId
            ? { ...m, content, edited_at: new Date().toISOString() }
            : m,
        ),
      );
    } catch {
      /* ignore */
    } finally {
      setEditingId(null);
      setText("");
    }
  }

  return {
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
  };
}
