/**
 * Global chat-cache synchroniser.
 *
 * Keeps the on-device per-conversation message cache (storage/chatCache) CURRENT
 * as `chat_message` WS events arrive — regardless of which screen is mounted.
 *
 * WHY: the cache used to be written ONLY by the thread screen's own network
 * load. When a message arrived while the user was on the dashboard/chat list,
 * the cache stayed stale; opening the thread then painted the stale page first
 * and the new message only appeared after the background refresh round-trip —
 * the "opening a chat takes time to show the new message" complaint. Appending
 * live messages here means the thread's synchronous cache seed already contains
 * them, so the newest message is visible on the very first frame (Signal-style).
 *
 * Mounted once in app/_layout.tsx alongside the other realtime listeners.
 */

import { useEffect } from "react";
import { useAuth } from "../auth/AuthContext";
import { socket } from "./socket";
import { appendCachedMessage } from "../storage/chatCache";
import type { ChatMessage } from "../features";

export default function ChatCacheSync() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user) return;
    const off = socket.subscribe((msg) => {
      if (msg.type !== "chat_message") return;
      const d = msg.data || {};
      const convId = Number(d.conversationId);
      if (!convId || !d.id) return;
      // Map the WS camelCase payload → the snake_case ChatMessage shape the
      // thread renders (mirrors the mapping in useChatThread's WS handler).
      const message: ChatMessage = {
        id: d.id,
        sender_id: d.senderId,
        sender_name: d.senderName,
        sender_avatar: d.senderAvatar ?? null,
        content: d.content ?? "",
        created_at: d.createdAt,
        file_url: d.fileUrl ?? null,
        file_name: d.fileName ?? null,
        file_type: d.fileType ?? null,
        file_size: d.fileSize ?? null,
        reply_to_id: d.replyToId ?? null,
        reply_to_content: d.replyContent ?? null,
        reply_to_sender_name: d.replySenderName ?? null,
        reply_to_file_url: d.replyFileUrl ?? null,
        reply_to_file_type: d.replyFileType ?? null,
        reply_to_file_name: d.replyFileName ?? null,
        format_type: d.formatType ?? d.format_type ?? null,
        metadata: d.metadata ?? null,
        clientMsgId: d.clientMsgId ?? null,
        media_job_id: d.mediaJobId ?? null,
        media_state: d.mediaState ?? null,
        reactions: [],
      };
      appendCachedMessage(convId, message);
    });
    return off;
  }, [user]);

  return null;
}