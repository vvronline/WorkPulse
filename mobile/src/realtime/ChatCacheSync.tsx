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
import {
  appendCachedMessage,
  clearCachedMessages,
  getCachedReadStatus,
  setCachedReadStatus,
  updateCachedMessage,
} from "../storage/chatCache";
import {
  applyMediaJobUpdate,
  applyMessageDelete,
  applyMessageEdit,
  applyMessagePin,
  applyMessageReaction,
  mapRealtimeChatMessage,
} from "../components/chat/chatMessageReducers";

export default function ChatCacheSync() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user) return;
    const off = socket.subscribe((msg) => {
      const d = msg.data || {};
      const convId = Number(d.conversationId);
      if (!convId) return;

      if (msg.type === "chat_message") {
        if (!d.id) return;
        appendCachedMessage(convId, mapRealtimeChatMessage(d));
        return;
      }

      if (msg.type === "chat_cleared") {
        clearCachedMessages(convId);
        return;
      }

      if (msg.type === "chat_read_receipt" && d.userId && d.readAt) {
        setCachedReadStatus(convId, {
          ...(getCachedReadStatus(convId) || {}),
          [Number(d.userId)]: String(d.readAt),
        });
        return;
      }

      const messageId = d.messageId;
      if (messageId == null) return;

      if (msg.type === "chat_edit") {
        updateCachedMessage(convId, messageId, (message) =>
          applyMessageEdit(message, d),
        );
        return;
      }

      if (msg.type === "chat_delete") {
        updateCachedMessage(convId, messageId, applyMessageDelete);
        return;
      }

      if (msg.type === "chat_pin") {
        updateCachedMessage(convId, messageId, (message) =>
          applyMessagePin(message, d),
        );
        return;
      }

      if (msg.type === "chat_reaction") {
        updateCachedMessage(convId, messageId, (message) =>
          applyMessageReaction(message, d),
        );
        return;
      }

      if (msg.type === "chat_media_job") {
        updateCachedMessage(convId, messageId, (message) =>
          applyMediaJobUpdate(message, d),
        );
      }
    });
    return off;
  }, [user]);

  return null;
}