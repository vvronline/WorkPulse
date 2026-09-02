/** Public types for the chat module boundary. */

export interface ChatDb {
    query: (
        sql: string,
        params?: unknown[],
    ) => Promise<{ rows: any[]; rowCount: number }>;
    transaction?: <T>(fn: (client: ChatDb) => Promise<T>) => Promise<T>;
}

export interface ChatActor {
    userId: number;
    tenantId: number | null;
}

export class ChatError extends Error {
    constructor(
        message: string,
        readonly statusCode = 400,
    ) {
        super(message);
        this.name = "ChatError";
    }
}

export interface ToggleReactionInput {
    messageId: number;
    emoji: string;
}

export interface ToggleReactionResult {
    action: "added" | "removed";
    conversationId: number;
    senderName: string;
    participantIds: number[];
}

export interface TogglePinResult {
    pinned: boolean;
    conversationId: number;
    pinnedByName: string;
    participantIds: number[];
}

export interface ToggleStarResult {
    starred: boolean;
}

export interface BlockedUserRow {
    id: number;
    username: string;
    full_name: string;
    avatar: string | null;
    blocked_at: string;
}

export interface BlockUserResult {
    blocked: boolean;
}
