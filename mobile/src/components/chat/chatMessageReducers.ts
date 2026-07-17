import type { ChatMessage } from "../../features";

type RealtimeData = Record<string, any>;

export function mapRealtimeChatMessage(data: RealtimeData): ChatMessage {
  return {
    id: data.id,
    sender_id: data.senderId,
    sender_name: data.senderName,
    sender_avatar: data.senderAvatar ?? null,
    content: data.content ?? "",
    created_at: data.createdAt,
    file_url: data.fileUrl ?? null,
    file_name: data.fileName ?? null,
    file_type: data.fileType ?? null,
    file_size: data.fileSize ?? null,
    reply_to_id: data.replyToId ?? null,
    reply_to_content: data.replyContent ?? null,
    reply_to_sender_name: data.replySenderName ?? null,
    reply_to_file_url: data.replyFileUrl ?? null,
    reply_to_file_type: data.replyFileType ?? null,
    reply_to_file_name:
      data.replyFileName ?? data.reply_to_file_name ?? null,
    format_type: data.formatType ?? data.format_type ?? null,
    metadata: data.metadata ?? null,
    clientMsgId: data.clientMsgId ?? null,
    media_job_id: data.mediaJobId ?? null,
    media_state: data.mediaState ?? null,
    media_stage: data.mediaStage ?? null,
    media_progress: data.mediaProgress ?? null,
    _mediaState: data.mediaState ?? null,
    _mediaProgress:
      typeof data.mediaProgress === "number" ? data.mediaProgress : 0,
    _failureReason: data.failureReason ?? null,
    reactions: [],
  } as ChatMessage;
}

export function applyMessageEdit(
  message: ChatMessage,
  data: RealtimeData,
): ChatMessage {
  return {
    ...message,
    content: data.content ?? message.content,
    edited_at: data.editedAt ?? message.edited_at,
  };
}

export function applyMessageDelete(message: ChatMessage): ChatMessage {
  return {
    ...message,
    deleted_at: new Date().toISOString(),
    content: "",
    file_url: null,
    file_name: null,
    file_type: null,
    file_size: null,
    reactions: [],
  };
}

export function applyMessagePin(
  message: ChatMessage,
  data: RealtimeData,
): ChatMessage {
  return {
    ...message,
    pinned_at: data.pinned ? new Date().toISOString() : null,
    pinned_by: data.pinned ? data.pinnedBy : null,
  };
}

export function applyMessageReaction(
  message: ChatMessage,
  data: RealtimeData,
): ChatMessage {
  if (message.deleted_at) return { ...message, reactions: [] };

  const reactions = [...(message.reactions || [])];
  if (data.action === "added") {
    if (
      reactions.some(
        (reaction) =>
          reaction.userId === data.userId &&
          reaction.emoji === data.emoji,
      )
    ) {
      return message;
    }
    return {
      ...message,
      reactions: [
        ...reactions,
        {
          userId: data.userId,
          fullName: data.fullName,
          emoji: data.emoji,
        },
      ],
    };
  }

  return {
    ...message,
    reactions: reactions.filter(
      (reaction) =>
        !(
          reaction.userId === data.userId &&
          reaction.emoji === data.emoji
        ),
    ),
  };
}

export function applyMediaJobUpdate(
  message: ChatMessage,
  data: RealtimeData,
  preserveCompletedUpload = false,
): ChatMessage {
  const httpUploadDone =
    preserveCompletedUpload &&
    Number(message.id) > 0 &&
    !!message.file_url &&
    !/^(file|content|data):/i.test(String(message.file_url));

  if (httpUploadDone) {
    if (data.status === "failed") {
      return {
        ...message,
        media_state: "failed",
        media_failure_reason: data.failureReason ?? null,
        _mediaState: "failed",
        _failed: true,
        _failureReason:
          data.failureReason ?? message._failureReason ?? null,
      };
    }

    return {
      ...message,
      media_job_id: data.mediaJobId ?? message.media_job_id ?? null,
      media_state: "completed",
      _mediaState: undefined,
      _mediaProgress: 100,
      _failed: false,
    };
  }

  return {
    ...message,
    media_job_id: data.mediaJobId ?? message.media_job_id ?? null,
    media_state: data.status ?? message.media_state ?? null,
    media_stage: data.stage ?? message.media_stage ?? null,
    media_progress:
      typeof data.progress === "number"
        ? data.progress
        : (message.media_progress ?? null),
    media_failure_reason: data.failureReason ?? null,
    _mediaState:
      data.status === "processing"
        ? "uploading"
        : (data.status ?? message._mediaState),
    _mediaProgress:
      typeof data.progress === "number"
        ? data.progress
        : (message._mediaProgress ?? 0),
    _failed: data.status === "failed" || data.status === "cancelled",
    _failureReason:
      data.failureReason ??
      (data.status === "cancelled"
        ? "Upload cancelled"
        : message._failureReason),
  };
}

export function normalizeUploadedMessage(data: any): ChatMessage {
  if (!data || typeof data !== "object") return data;
  const camelCase =
    "fileUrl" in data || "mediaState" in data || "senderId" in data;
  if (!camelCase) return data as ChatMessage;

  return {
    id: data.id,
    sender_id: data.senderId ?? data.sender_id,
    sender_name: data.senderName ?? data.sender_name,
    sender_avatar: data.senderAvatar ?? data.sender_avatar ?? null,
    content: data.content ?? "",
    created_at: data.createdAt ?? data.created_at,
    file_url: data.fileUrl ?? data.file_url ?? null,
    file_name: data.fileName ?? data.file_name ?? null,
    file_type: data.fileType ?? data.file_type ?? null,
    file_size: data.fileSize ?? data.file_size ?? null,
    reply_to_id: data.replyToId ?? data.reply_to_id ?? null,
    reply_to_content: data.replyContent ?? data.reply_to_content ?? null,
    reply_to_sender_name:
      data.replySenderName ?? data.reply_to_sender_name ?? null,
    reply_to_file_url:
      data.replyFileUrl ?? data.reply_to_file_url ?? null,
    reply_to_file_type:
      data.replyFileType ?? data.reply_to_file_type ?? null,
    reply_to_file_name:
      data.replyFileName ?? data.reply_to_file_name ?? null,
    metadata: data.metadata ?? null,
    reactions: data.reactions ?? [],
    clientMsgId: data.clientMsgId ?? null,
    media_job_id: data.mediaJobId ?? data.media_job_id ?? null,
    media_state: data.mediaState ?? data.media_state ?? null,
    media_stage: data.mediaStage ?? data.media_stage ?? null,
    media_progress: data.mediaProgress ?? data.media_progress ?? null,
    media_pipeline_meta:
      data.mediaPipelineMeta ?? data.media_pipeline_meta ?? null,
  } as ChatMessage;
}

export function replaceUploadedMessage(
  messages: ChatMessage[],
  temporaryId: number,
  uploaded: ChatMessage,
): ChatMessage[] {
  const replaced = messages.map((message) =>
    message.id === temporaryId
      ? {
          ...uploaded,
          metadata: {
            ...(message.metadata || {}),
            ...(uploaded.metadata || {}),
          },
          _pending: false,
          _failed: false,
        }
      : message,
  );

  const seen = new Set<number>();
  return replaced.filter((message) => {
    const id = Number(message.id);
    if (!Number.isFinite(id)) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function updateMessageById(
  messages: ChatMessage[],
  messageId: number | string,
  update: (message: ChatMessage) => ChatMessage,
): ChatMessage[] {
  return messages.map((message) =>
    String(message.id) === String(messageId)
      ? update(message)
      : message,
  );
}