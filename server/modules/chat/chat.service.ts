/** Chat business rules for the reactions/pin/star slice. */
import type {
    ChatDb,
    ToggleReactionResult,
    TogglePinResult,
    ToggleStarResult,
} from "./chat.types";
import { ChatError } from "./chat.types";
import * as repository from "./chat.repository";

export function createChatService() {
    return {
        async toggleReaction(
            db: ChatDb,
            userId: number,
            messageId: number,
            emoji: string,
        ): Promise<ToggleReactionResult> {
            const msg = await repository.getMessage(db, messageId);
            if (!msg) throw new ChatError("Message not found", 404);
            if (msg.deleted_at) throw new ChatError("Message is deleted", 400);
            if (!(await repository.verifyParticipant(db, msg.conversation_id, userId))) {
                throw new ChatError("Not a participant", 403);
            }

            const existing = await repository.findExistingReaction(db, messageId, userId, emoji);
            let action: "added" | "removed";
            if (existing) {
                await repository.deleteReaction(db, existing.id);
                action = "removed";
            } else {
                await repository.insertReaction(db, messageId, userId, emoji);
                action = "added";
            }

            const senderName = await repository.getUserDisplayName(db, userId);
            const participantIds = await repository.getConversationParticipantIds(db, msg.conversation_id);

            return { action, conversationId: msg.conversation_id, senderName, participantIds };
        },

        async togglePin(db: ChatDb, userId: number, messageId: number): Promise<TogglePinResult> {
            const msg = await repository.getMessage(db, messageId);
            if (!msg) throw new ChatError("Message not found", 404);
            if (!(await repository.verifyParticipant(db, msg.conversation_id, userId))) {
                throw new ChatError("Not a participant", 403);
            }

            const isPinned = !!msg.pinned_at;
            await repository.setPinned(db, messageId, isPinned ? null : userId);

            const pinnedByName = await repository.getUserDisplayName(db, userId);
            const participantIds = await repository.getConversationParticipantIds(db, msg.conversation_id);

            return { pinned: !isPinned, conversationId: msg.conversation_id, pinnedByName, participantIds };
        },

        async listPinned(db: ChatDb, userId: number, conversationId: number) {
            if (!(await repository.verifyParticipant(db, conversationId, userId))) {
                throw new ChatError("Not a participant", 403);
            }
            return repository.listPinnedMessages(db, conversationId);
        },

        async toggleStar(db: ChatDb, userId: number, messageId: number): Promise<ToggleStarResult> {
            const msg = await repository.getMessage(db, messageId);
            if (!msg) throw new ChatError("Message not found", 404);
            if (!(await repository.verifyParticipant(db, msg.conversation_id, userId))) {
                throw new ChatError("Not a participant", 403);
            }

            const isStarred = await repository.findStarred(db, userId, messageId);
            if (isStarred) {
                await repository.deleteStar(db, userId, messageId);
                return { starred: false };
            }
            await repository.insertStar(db, userId, messageId);
            return { starred: true };
        },

        async listStarred(db: ChatDb, userId: number) {
            return repository.listStarredMessages(db, userId);
        },
    };
}
