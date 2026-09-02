import { ChatError } from "./chat.types";

/** Validate the HTTP body/params before they reach service code. */
export function parseMessageId(value: unknown): number {
    const id = parseInt(String(value), 10);
    if (isNaN(id)) throw new ChatError("Invalid message");
    return id;
}

export function parseConversationId(value: unknown): number {
    const id = parseInt(String(value), 10);
    if (isNaN(id)) throw new ChatError("Invalid conversation");
    return id;
}

export function parseEmoji(body: unknown): string {
    const emoji = (body as { emoji?: unknown } | null)?.emoji;
    if (!emoji || typeof emoji !== "string" || emoji.length > 20) {
        throw new ChatError("Invalid emoji");
    }
    return emoji;
}

export function parseUserId(value: unknown): number {
    const id = parseInt(String(value), 10);
    if (isNaN(id)) throw new ChatError("Invalid user");
    return id;
}
