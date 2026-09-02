import { useEffect, useRef } from "react";
import {
  uploadChatFile,
  cancelChatMediaJob,
  retryChatMediaJob,
  toggleReaction,
  editMessage,
  deleteMessage,
  togglePin,
  toggleStar,
  createPoll,
} from "../../api";
import type useChatState from "./useChatState";
import type { AnyRecord } from "../../types";
import { createPendingMessageId } from "./messageDelivery";

type ChatState = ReturnType<typeof useChatState>;
type Msg = AnyRecord & { id: number | string };
type PendingMedia = { blob: Blob; name: string; type?: string | null };

/**
 * Merge the server's upload response into the optimistic media message.
 *
 * The HTTP file-upload route now returns snake_case (matching GET /messages),
 * but we still defensively preserve the optimistic `created_at` / `file_url`
 * if the server ever omits them — this prevents the "Invalid date" footer and
 * the disappearing-image-until-reopen bug. We also clear the local upload
 * progress flags so the "Queued"/"Uploading" chip disappears the moment the
 * HTTP 201 lands and delivery ticks take over.
 */
function finalizeUploadedMessage(optimistic: Msg, data: AnyRecord): Msg {
  return {
    ...optimistic,
    ...data,
    created_at: (data.created_at as string) || optimistic.created_at,
    file_url: (data.file_url as string) || optimistic.file_url,
    file_name: (data.file_name as string) || optimistic.file_name,
    file_type: (data.file_type as string) || optimistic.file_type,
    file_size: (data.file_size as number) ?? optimistic.file_size,
    reactions: (data.reactions as AnyRecord[]) || [],
    delivered_to: (data.delivered_to as (number | string)[]) || [],
    // Upload is complete — drop the local progress UI so we never show
    // "Queued" on a delivered message.
    _pending: false,
    _failed: false,
    _mediaState: undefined,
    _mediaProgress: undefined,
    _failureReason: null,
  };
}

export default function useMessageActions(state: ChatState) {
  const {
    user,
    wsSend,
    activeConv,
    setMessages,
    input,
    setInput,
    replyTo,
    setReplyTo,
    editingMsg,
    setEditingMsg,
    setForwardMsg,
    setRecording,
    setDragOver,
    setShowEmojiPicker,
    setShowPollCreator,
    mentionInputRef,
    pendingCounter,
  } = state;
  const uploadControllersRef = useRef<Map<string, AbortController>>(new Map());
  const pendingMediaRef = useRef<Map<string, PendingMedia>>(new Map());
  const mediaPreviewUrlsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    return () => {
      uploadControllersRef.current.forEach((c) => c.abort());
      uploadControllersRef.current.clear();
      pendingMediaRef.current.clear();
      mediaPreviewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      mediaPreviewUrlsRef.current.clear();
    };
  }, []);

  const handleSend = (
    e: React.FormEvent,
    extras?: { linkPreview?: unknown | null },
  ) => {
    e?.preventDefault?.();
    if (!input.trim() || !activeConv) return;
    const content = input.trim();
    if (editingMsg) {
      editMessage(editingMsg.id, content)
        .then(() => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === editingMsg.id
                ? {
                    ...m,
                    content,
                    edited_at: new Date().toISOString(),
                  }
                : m,
            ),
          );
        })
        .catch(() => {});
      setEditingMsg(null);
      setInput("");
      return;
    }
    const mentionApi = mentionInputRef.current as unknown as {
      getMentionedIds?: () => (number | string)[];
      resetMentionedIds?: () => void;
    } | null;
    const mentions = mentionApi?.getMentionedIds?.() || [];
    mentionApi?.resetMentionedIds?.();

    const clientMsgId = createPendingMessageId();
    setMessages((prev) => [
      ...prev,
      {
        id: clientMsgId,
        sender_id: user?.id,
        sender_name: user?.full_name,
        content,
        created_at: new Date().toISOString(),
        reply_to_id: replyTo?.id || null,
        link_preview: extras?.linkPreview || null,
        reactions: [],
      },
    ]);
    wsSend("chat_message", {
      conversationId: activeConv.id,
      content,
      clientMsgId,
      ...(replyTo ? { replyToId: replyTo.id } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(extras?.linkPreview ? { linkPreview: extras.linkPreview } : {}),
    });
    setInput("");
    setReplyTo(null);
  };

  const handleRetryMessage = (msg: Msg) => {
    if (!activeConv) return;
    const clientMsgId = String(msg.id || "");
    const mediaJobId = Number(msg.media_job_id || 0);
    const serverMediaState = String(msg.media_state || "");
    if (
      mediaJobId > 0 &&
      (serverMediaState === "failed" || serverMediaState === "cancelled")
    ) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id
            ? {
                ...m,
                _failed: false,
                _pending: true,
                _mediaState: "queued",
                _mediaProgress: 0,
                _failureReason: null,
              }
            : m,
        ),
      );
      retryChatMediaJob(mediaJobId).catch((e: any) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msg.id
              ? {
                  ...m,
                  _pending: false,
                  _failed: true,
                  _mediaState: "failed",
                  _failureReason: e?.response?.data?.error || "Retry failed",
                }
              : m,
          ),
        );
      });
      return;
    }
    if (clientMsgId.startsWith("pending_media_")) {
      const media = pendingMediaRef.current.get(clientMsgId);
      if (!media) return;
      const form = new FormData();
      form.append("file", media.blob, media.name);
      const controller = new AbortController();
      uploadControllersRef.current.set(clientMsgId, controller);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === clientMsgId
            ? {
                ...m,
                _pending: true,
                _failed: false,
                _mediaState: "queued",
                _mediaProgress: 0,
                _failureReason: null,
                created_at: new Date().toISOString(),
              }
            : m,
        ),
      );
      uploadChatFile(activeConv.id, form, {
        signal: controller.signal,
        onUploadProgress: (evt) => {
          const total = evt.total || 0;
          const pct =
            total > 0
              ? Math.max(
                  0,
                  Math.min(100, Math.round((evt.loaded / total) * 100)),
                )
              : 0;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === clientMsgId
                ? { ...m, _mediaState: "uploading", _mediaProgress: pct }
                : m,
            ),
          );
        },
      })
        .then(({ data }) => {
          const localUrl = String(msg.file_url || "");
          if (localUrl.startsWith("blob:")) URL.revokeObjectURL(localUrl);
          mediaPreviewUrlsRef.current.delete(clientMsgId);
          setMessages((prev) => {
            const replaced = prev.map((m) =>
              m.id === clientMsgId ? finalizeUploadedMessage(m, data) : m,
            );
            const seen = new Set<string>();
            return replaced.filter((m) => {
              const k = String(m.id);
              if (seen.has(k)) return false;
              seen.add(k);
              return true;
            });
          });
          pendingMediaRef.current.delete(clientMsgId);
          uploadControllersRef.current.delete(clientMsgId);
        })
        .catch((e: any) => {
          uploadControllersRef.current.delete(clientMsgId);
          const cancelled =
            e?.name === "CanceledError" || e?.code === "ERR_CANCELED";
          setMessages((prev) =>
            prev.map((m) =>
              m.id === clientMsgId
                ? {
                    ...m,
                    _pending: false,
                    _failed: true,
                    _mediaState: "failed",
                    _failureReason: cancelled
                      ? "Upload cancelled"
                      : e?.response?.data?.error || "Upload failed",
                  }
                : m,
            ),
          );
        });
      return;
    }
    if (!clientMsgId.startsWith("pending_")) return;
    const content = String(msg.content || "").trim();
    if (!content) return;

    setMessages((prev) =>
      prev.map((m) =>
        m.id === clientMsgId
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

    wsSend("chat_message", {
      conversationId: activeConv.id,
      content,
      clientMsgId,
      ...(msg.reply_to_id ? { replyToId: msg.reply_to_id } : {}),
    });
  };

  const handleCancelMediaUpload = (msg: Msg) => {
    const id = String(msg.id || "");
    const mediaJobId = Number(msg.media_job_id || 0);
    if (mediaJobId > 0) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id
            ? {
                ...m,
                _mediaState: "failed",
                _failed: true,
                _failureReason: "Upload cancelled",
              }
            : m,
        ),
      );
      cancelChatMediaJob(mediaJobId).catch(() => {});
      return;
    }
    if (!id.startsWith("pending_media_")) return;
    const controller = uploadControllersRef.current.get(id);
    controller?.abort();
  };

  const handleFileUpload = async (
    file: File,
    opts?: { viewOnce?: boolean; caption?: string },
  ) => {
    if (!activeConv || !file) return;
    const tempId = `pending_media_${++pendingCounter.current}`;
    const localUrl = URL.createObjectURL(file);
    const viewOnce = !!opts?.viewOnce;
    const caption = opts?.caption?.trim() || "";
    pendingMediaRef.current.set(tempId, {
      blob: file,
      name: file.name || "file",
      type: file.type || undefined,
    });
    mediaPreviewUrlsRef.current.set(tempId, localUrl);
    setMessages((prev) => [
      ...prev,
      {
        id: tempId,
        sender_id: user?.id,
        sender_name: user?.full_name,
        content: caption,
        created_at: new Date().toISOString(),
        file_url: localUrl,
        file_name: file.name || "File",
        file_type: file.type || null,
        file_size: file.size,
        metadata: viewOnce ? { viewOnce: true, viewedBy: [] } : null,
        reactions: [],
        _pending: true,
        _failed: false,
        _mediaState: "queued",
        _mediaProgress: 0,
        _failureReason: null,
      },
    ]);
    const formData = new FormData();
    formData.append("file", file);
    if (viewOnce) formData.append("viewOnce", "true");
    if (caption) formData.append("content", caption);
    try {
      const controller = new AbortController();
      uploadControllersRef.current.set(tempId, controller);
      const { data } = await uploadChatFile(activeConv.id, formData, {
        signal: controller.signal,
        onUploadProgress: (evt) => {
          const total = evt.total || file.size || 0;
          const pct =
            total > 0
              ? Math.max(
                  0,
                  Math.min(100, Math.round((evt.loaded / total) * 100)),
                )
              : 0;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === tempId
                ? { ...m, _mediaState: "uploading", _mediaProgress: pct }
                : m,
            ),
          );
        },
      });
      URL.revokeObjectURL(localUrl);
      mediaPreviewUrlsRef.current.delete(tempId);
      setMessages((prev) => {
        const replaced = prev.map((m) =>
          m.id === tempId ? finalizeUploadedMessage(m, data) : m,
        );
        const seen = new Set<string>();
        return replaced.filter((m) => {
          const k = String(m.id);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      });
      pendingMediaRef.current.delete(tempId);
      uploadControllersRef.current.delete(tempId);
    } catch (e: any) {
      uploadControllersRef.current.delete(tempId);
      const cancelled =
        e?.name === "CanceledError" || e?.code === "ERR_CANCELED";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === tempId
            ? {
                ...m,
                _pending: false,
                _failed: true,
                _mediaState: "failed",
                _failureReason: cancelled
                  ? "Upload cancelled"
                  : e?.response?.data?.error || "Upload failed",
              }
            : m,
        ),
      );
    }
  };

  const handleVoiceSend = (blob: Blob, _duration?: number, ext = "webm") => {
    if (!activeConv) return;
    const tempId = `pending_media_${++pendingCounter.current}`;
    const mime = blob.type || `audio/${ext}`;
    const fileName = `voice.${ext}`;
    const localUrl = URL.createObjectURL(blob);
    pendingMediaRef.current.set(tempId, {
      blob,
      name: fileName,
      type: mime,
    });
    mediaPreviewUrlsRef.current.set(tempId, localUrl);
    setMessages((prev) => [
      ...prev,
      {
        id: tempId,
        sender_id: user?.id,
        sender_name: user?.full_name,
        content: "",
        created_at: new Date().toISOString(),
        file_url: localUrl,
        file_name: fileName,
        file_type: mime,
        file_size: 0,
        reactions: [],
        _pending: true,
        _failed: false,
        _mediaState: "queued",
        _mediaProgress: 0,
        _failureReason: null,
      },
    ]);
    const formData = new FormData();
    formData.append("file", blob, fileName);
    const controller = new AbortController();
    uploadControllersRef.current.set(tempId, controller);
    uploadChatFile(activeConv.id, formData, {
      signal: controller.signal,
      onUploadProgress: (evt) => {
        const total = evt.total || 0;
        const pct =
          total > 0
            ? Math.max(0, Math.min(100, Math.round((evt.loaded / total) * 100)))
            : 0;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === tempId
              ? { ...m, _mediaState: "uploading", _mediaProgress: pct }
              : m,
          ),
        );
      },
    })
      .then(({ data }) => {
        URL.revokeObjectURL(localUrl);
        mediaPreviewUrlsRef.current.delete(tempId);
        setMessages((prev) => {
          const replaced = prev.map((m) =>
            m.id === tempId ? finalizeUploadedMessage(m, data) : m,
          );
          const seen = new Set<string>();
          return replaced.filter((m) => {
            const k = String(m.id);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        });
        pendingMediaRef.current.delete(tempId);
        uploadControllersRef.current.delete(tempId);
      })
      .catch((e: any) => {
        uploadControllersRef.current.delete(tempId);
        const cancelled =
          e?.name === "CanceledError" || e?.code === "ERR_CANCELED";
        setMessages((prev) =>
          prev.map((m) =>
            m.id === tempId
              ? {
                  ...m,
                  _pending: false,
                  _failed: true,
                  _mediaState: "failed",
                  _failureReason: cancelled
                    ? "Upload cancelled"
                    : e?.response?.data?.error || "Upload failed",
                }
              : m,
          ),
        );
      });
    setRecording(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFileUpload(file);
  };

  const handleReply = (msg: Msg) => {
    setReplyTo(msg);
    setEditingMsg(null);
  };
  const handleEdit = (msg: Msg) => {
    if (String(msg.id).startsWith("pending_")) return;
    setEditingMsg(msg);
    setInput((msg.content as string) || "");
    setReplyTo(null);
  };

  const handleDelete = async (msg: Msg) => {
    if (String(msg.id).startsWith("pending_")) return;
    try {
      await deleteMessage(msg.id);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id
            ? {
                ...m,
                deleted_at: new Date().toISOString(),
                content: "",
                file_url: null,
                file_name: null,
                file_type: null,
                file_size: null,
                reactions: [],
              }
            : m,
        ),
      );
    } catch {
      /* ignore */
    }
  };

  const handlePin = async (msg: Msg) => {
    if (String(msg.id).startsWith("pending_")) return;
    try {
      await togglePin(msg.id);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id
            ? {
                ...m,
                pinned_at: m.pinned_at ? null : new Date().toISOString(),
                pinned_by: m.pinned_at ? null : user?.id,
              }
            : m,
        ),
      );
    } catch {
      /* ignore */
    }
  };

  const handleReact = async (msgId: number | string, emoji: string) => {
    if (String(msgId).startsWith("pending_")) return;
    // Optimistic toggle: update UI immediately, the WS echo reconciles.
    const toggle = (prev: Msg[]) =>
      prev.map((m) => {
        if (m.id !== msgId) return m;
        if (m.deleted_at) return { ...m, reactions: [] };
        const reactions = (m.reactions as AnyRecord[]) || [];
        const mine = reactions.some(
          (r) => r.userId === user?.id && r.emoji === emoji,
        );
        return {
          ...m,
          reactions: mine
            ? reactions.filter(
                (r) => !(r.userId === user?.id && r.emoji === emoji),
              )
            : [
                ...reactions,
                {
                  userId: user?.id,
                  fullName: user?.full_name,
                  emoji,
                },
              ],
        };
      });
    setMessages(toggle);
    try {
      await toggleReaction(msgId, emoji);
    } catch {
      // Revert on failure (toggle is its own inverse).
      setMessages(toggle);
    }
  };

  const handleForward = (msg: Msg) => {
    if (String(msg.id).startsWith("pending_")) return;
    setForwardMsg(msg);
  };

  const handleStar = async (msg: Msg) => {
    if (String(msg.id).startsWith("pending_")) return;
    try {
      const { data } = await toggleStar(msg.id);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id
            ? {
                ...m,
                starred: (data as { starred?: boolean }).starred,
              }
            : m,
        ),
      );
    } catch {
      /* ignore */
    }
  };

  const handleCreatePoll = async (pollData: AnyRecord) => {
    if (!activeConv) return;
    try {
      await createPoll(activeConv.id, pollData);
      setShowPollCreator(false);
    } catch {
      /* ignore */
    }
  };

  const handleEmojiInsert = (emoji: string) => {
    setInput((prev) => prev + emoji);
    setShowEmojiPicker(false);
  };

  const handleJumpTo = (msgId: number | string, highlightClass?: string) => {
    const el = document.getElementById(`msg-${msgId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      if (highlightClass) {
        el.classList.add(highlightClass);
        setTimeout(() => el.classList.remove(highlightClass), 2000);
      }
    }
  };

  const handleUnpin = async (msgId: number | string) => {
    try {
      await togglePin(msgId);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId ? { ...m, pinned_at: null, pinned_by: null } : m,
        ),
      );
    } catch {
      /* ignore */
    }
  };

  return {
    handleSend,
    handleFileUpload,
    handleVoiceSend,
    handleDrop,
    handleReply,
    handleEdit,
    handleDelete,
    handlePin,
    handleReact,
    handleForward,
    handleStar,
    handleCreatePoll,
    handleEmojiInsert,
    handleJumpTo,
    handleUnpin,
    handleRetryMessage,
    handleCancelMediaUpload,
  };
}
