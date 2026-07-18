import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import * as SecureStore from "expo-secure-store";
import type { ChatMessage } from "../../features";

export type PendingMediaSource = {
  uri: string;
  fileName: string;
  mimeType?: string;
  viewOnce?: boolean;
  caption?: string;
  width?: number;
  height?: number;
  quality?: "standard" | "hd";
};

type ConversationDraft = {
  text: string;
  replyTo?: {
    id: number;
    content?: string | null;
    sender_name?: string | null;
  } | null;
  editing?: { id: number; text?: string | null } | null;
  mediaDrafts: PendingMediaSource[];
};

type DraftUser = {
  id: number;
  full_name?: string | null;
  tenant_id?: number | null;
};

type UseMobileConversationDraftOptions = {
  conversationId: number;
  user: DraftUser | null;
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  replyTo: ChatMessage | null;
  setReplyTo: Dispatch<SetStateAction<ChatMessage | null>>;
  editingId: number | null;
  setEditingId: Dispatch<SetStateAction<number | null>>;
  mediaUploadSources: MutableRefObject<Map<number, PendingMediaSource>>;
};

export function buildMobileDraftStorageKey(
  user: Pick<DraftUser, "id" | "tenant_id"> | null,
  conversationId: number,
): string | null {
  if (!user?.id) return null;
  return `wp:v2:chat:draft:${user.tenant_id ?? "platform"}:${user.id}:${conversationId}`;
}

/**
 * Owns tenant-safe SecureStore draft persistence for a mobile chat thread.
 *
 * Empty-text reply/edit/media drafts restore deterministically because
 * hydration completion is represented by state, not only mutable refs.
 * Persisted media is restored as explicit-retry UI and is never auto-sent.
 */
export default function useMobileConversationDraft({
  conversationId,
  user,
  messages,
  setMessages,
  text,
  setText,
  replyTo,
  setReplyTo,
  editingId,
  setEditingId,
  mediaUploadSources,
}: UseMobileConversationDraftOptions): void {
  const [hydrationVersion, setHydrationVersion] = useState(0);
  const hydratedRef = useRef(false);
  const pendingReplyRef = useRef<ConversationDraft["replyTo"]>(null);
  const pendingEditingRef = useRef<ConversationDraft["editing"]>(null);
  const pendingMediaRef = useRef<PendingMediaSource[]>([]);
  const skipNextPersistenceKeyRef = useRef<string | null>(null);

  const storageKey = useMemo(
    () => buildMobileDraftStorageKey(user, conversationId),
    [conversationId, user?.id, user?.tenant_id],
  );

  useEffect(() => {
    let cancelled = false;
    hydratedRef.current = false;
    pendingReplyRef.current = null;
    pendingEditingRef.current = null;
    pendingMediaRef.current = [];
    skipNextPersistenceKeyRef.current = storageKey;

    // Prevent a new identity/conversation from inheriting transient composer
    // state while its own SecureStore value is loading.
    setText("");
    setReplyTo(null);
    setEditingId(null);

    const finish = () => {
      if (cancelled) return;
      hydratedRef.current = true;
      setHydrationVersion((version) => version + 1);
    };

    if (!storageKey) {
      finish();
      return () => {
        cancelled = true;
      };
    }

    SecureStore.getItemAsync(storageKey)
      .then((raw) => {
        if (cancelled || !raw) {
          finish();
          return;
        }

        let parsed: ConversationDraft | null;
        try {
          parsed = JSON.parse(raw) as ConversationDraft;
        } catch {
          parsed = null;
        }

        if (!parsed) {
          finish();
          return;
        }

        if (typeof parsed.text === "string") setText(parsed.text);
        pendingReplyRef.current = parsed.replyTo || null;
        pendingEditingRef.current = parsed.editing || null;
        pendingMediaRef.current = Array.isArray(parsed.mediaDrafts)
          ? parsed.mediaDrafts
          : [];
        finish();
      })
      .catch(finish);

    return () => {
      cancelled = true;
    };
  }, [setEditingId, setReplyTo, setText, storageKey]);

  useEffect(() => {
    if (!hydratedRef.current || pendingMediaRef.current.length === 0) return;

    const drafts = [...pendingMediaRef.current];
    pendingMediaRef.current = [];
    const restoredAt = Date.now();

    const restoredMessages = drafts.map((source, index) => {
      const id = -(restoredAt + index + 1);
      mediaUploadSources.current.set(id, source);
      return {
        id,
        sender_id: user?.id || 0,
        sender_name: user?.full_name || "You",
        content: source.caption || "",
        created_at: new Date().toISOString(),
        file_url: source.uri,
        file_name: source.fileName,
        file_type: source.mimeType || null,
        file_size: null,
        metadata: source.viewOnce ? { viewOnce: true, viewedBy: [] } : null,
        reactions: [],
        _pending: false,
        _failed: true,
        _mediaState: "failed",
        _failureReason: "Attachment draft restored. Tap retry to send.",
      } as ChatMessage;
    });

    setMessages((current) => [...current, ...restoredMessages]);
  }, [
    hydrationVersion,
    mediaUploadSources,
    setMessages,
    user?.full_name,
    user?.id,
  ]);

  useEffect(() => {
    if (!hydratedRef.current) return;

    const pendingReply = pendingReplyRef.current;
    if (pendingReply?.id) {
      const target = messages.find(
        (message) => Number(message.id) === Number(pendingReply.id),
      );
      if (target) {
        setReplyTo(target);
        pendingReplyRef.current = null;
      }
    }

    const pendingEditing = pendingEditingRef.current;
    if (pendingEditing?.id) {
      const target = messages.find(
        (message) => Number(message.id) === Number(pendingEditing.id),
      );
      if (target) {
        setEditingId(Number(target.id));
        setText(
          typeof pendingEditing.text === "string"
            ? pendingEditing.text
            : target.content || "",
        );
        pendingEditingRef.current = null;
      }
    }
  }, [
    hydrationVersion,
    messages,
    setEditingId,
    setReplyTo,
    setText,
  ]);

  useEffect(() => {
    if (!hydratedRef.current || !storageKey) return;
    if (skipNextPersistenceKeyRef.current === storageKey) {
      skipNextPersistenceKeyRef.current = null;
      return;
    }

    const mediaDrafts: PendingMediaSource[] = messages
      .filter((message) => Number(message.id) < 0 && !!message.file_url)
      .map((message) => ({
        uri: String(message.file_url),
        fileName: String(
          message.file_name || `draft-${Math.abs(Number(message.id))}`,
        ),
        mimeType: message.file_type || undefined,
      }));

    const payload: ConversationDraft = {
      text,
      replyTo: replyTo
        ? {
            id: Number(replyTo.id),
            content: replyTo.content || null,
            sender_name: replyTo.sender_name || null,
          }
        : null,
      editing: editingId ? { id: editingId, text } : null,
      mediaDrafts,
    };

    if (
      !payload.text.trim() &&
      !payload.replyTo &&
      !payload.editing &&
      payload.mediaDrafts.length === 0
    ) {
      SecureStore.deleteItemAsync(storageKey).catch(() => {});
      return;
    }

    SecureStore.setItemAsync(storageKey, JSON.stringify(payload)).catch(
      () => {},
    );
  }, [editingId, hydrationVersion, messages, replyTo, storageKey, text]);
}