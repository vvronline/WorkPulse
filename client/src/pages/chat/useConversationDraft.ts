import { useEffect, useMemo, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { AnyRecord } from "../../types";

type Message = AnyRecord & { id: number | string };

type StoredDraft = {
    input: string;
    replyTo?: {
        id: number | string;
        content?: string | null;
        sender_name?: string | null;
    } | null;
    editing?: {
        id: number | string;
        content?: string | null;
    } | null;
};

type DraftIdentity = {
    id: number | string;
    tenantId?: number | string | null;
};

type UseConversationDraftOptions = {
    identity: DraftIdentity | null;
    conversationId: number | string | null | undefined;
    messages: Message[];
    input: string;
    setInput: Dispatch<SetStateAction<string>>;
    replyTo: Message | null;
    setReplyTo: Dispatch<SetStateAction<Message | null>>;
    editingMessage: Message | null;
    setEditingMessage: Dispatch<SetStateAction<Message | null>>;
};

function buildDraftKey(
    identity: DraftIdentity | null,
    conversationId: number | string | null | undefined,
): string | null {
    if (!identity || conversationId == null) return null;
    return `chat:v2:draft:${String(identity.tenantId ?? "platform")}:${String(identity.id)}:${String(conversationId)}`;
}

/**
 * Owns tenant-safe web composer draft persistence and restoration.
 *
 * Keeping this out of the main chat coordinator isolates localStorage I/O and
 * guarantees that switching to a conversation without a draft clears the
 * previous conversation's composer state.
 */
export default function useConversationDraft({
    identity,
    conversationId,
    messages,
    input,
    setInput,
    replyTo,
    setReplyTo,
    editingMessage,
    setEditingMessage,
}: UseConversationDraftOptions): void {
    const pendingReplyRef = useRef<StoredDraft["replyTo"]>(null);
    const pendingEditRef = useRef<StoredDraft["editing"]>(null);
    // Prevent the persistence effect in the same commit from writing the
    // previous conversation's state under a newly-selected conversation key.
    const skipNextPersistenceKeyRef = useRef<string | null>(null);

    const draftKey = useMemo(
        () => buildDraftKey(identity, conversationId),
        [conversationId, identity?.id, identity?.tenantId],
    );

    useEffect(() => {
        pendingReplyRef.current = null;
        pendingEditRef.current = null;
        skipNextPersistenceKeyRef.current = draftKey;

        // Reset first so a conversation with no saved draft never inherits the
        // previous conversation's text/reply/edit state.
        setInput("");
        setReplyTo(null);
        setEditingMessage(null);

        if (!draftKey) return;

        try {
            const raw = localStorage.getItem(draftKey);
            if (!raw) return;
            const parsed = JSON.parse(raw) as StoredDraft;
            if (typeof parsed.input === "string") setInput(parsed.input);
            pendingReplyRef.current = parsed.replyTo || null;
            pendingEditRef.current = parsed.editing || null;
        } catch {
            // Ignore malformed or manually modified localStorage values.
        }
    }, [draftKey, setEditingMessage, setInput, setReplyTo]);

    useEffect(() => {
        if (messages.length === 0) return;

        const pendingReply = pendingReplyRef.current;
        if (pendingReply?.id != null) {
            const match = messages.find(
                (message) => String(message.id) === String(pendingReply.id),
            );
            if (match) {
                setReplyTo(match);
                pendingReplyRef.current = null;
            }
        }

        const pendingEdit = pendingEditRef.current;
        if (pendingEdit?.id != null) {
            const match = messages.find(
                (message) => String(message.id) === String(pendingEdit.id),
            );
            if (match) {
                setEditingMessage(match);
                setInput(
                    typeof pendingEdit.content === "string"
                        ? pendingEdit.content
                        : String(match.content || ""),
                );
                pendingEditRef.current = null;
            }
        }
    }, [messages, setEditingMessage, setInput, setReplyTo]);

    useEffect(() => {
        if (!draftKey) return;
        if (skipNextPersistenceKeyRef.current === draftKey) {
            skipNextPersistenceKeyRef.current = null;
            return;
        }

        const payload: StoredDraft = {
            input,
            replyTo: replyTo
                ? {
                      id: replyTo.id,
                      content: (replyTo.content as string) || null,
                      sender_name: (replyTo.sender_name as string) || null,
                  }
                : null,
            editing: editingMessage
                ? {
                      id: editingMessage.id,
                      content: (editingMessage.content as string) || null,
                  }
                : null,
        };

        if (!payload.input.trim() && !payload.replyTo && !payload.editing) {
            localStorage.removeItem(draftKey);
            return;
        }

        localStorage.setItem(draftKey, JSON.stringify(payload));
    }, [draftKey, editingMessage, input, replyTo]);
}

export { buildDraftKey };