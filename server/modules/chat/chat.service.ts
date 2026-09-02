/** Chat workflows and the route-to-repository boundary. */
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
        query(
            db: Pick<ChatDb, "query">,
            statement: keyof typeof repository.sql,
            params?: unknown[],
        ) {
            return repository.query(db, repository.sql[statement], params);
        },

        listMessages(
            db: Pick<ChatDb, "query">,
            userId: number,
            conversationId: number,
            before: number | null,
            limit: number,
        ) {
            const params: unknown[] = [userId, conversationId];
            let statement = repository.sql.q084;
            if (before) {
                statement += `${repository.sql.q087}${params.length + 1}`;
                params.push(before);
            }
            statement += `${repository.sql.q088}${params.length + 1}`;
            params.push(limit);
            return repository.query(db, statement, params);
        },

        searchMessages(
            db: Pick<ChatDb, "query">,
            userId: number,
            conversationId: number | null,
            searchPattern: string,
        ) {
            return repository.query(
                db,
                conversationId === null ? repository.sql.q086 : repository.sql.q085,
                conversationId === null ? [userId, searchPattern] : [conversationId, searchPattern],
            );
        },

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

        async listBlocked(db: ChatDb, userId: number) {
            return repository.listBlockedUsers(db, userId);
        },

        async blockUser(db: ChatDb, blockerId: number, targetId: number) {
            if (targetId === blockerId) throw new ChatError("Invalid user", 400);
            const orgId = await repository.getUserOrgId(db, blockerId);
            const target = await repository.getUserInOrg(db, targetId, orgId);
            if (!target) throw new ChatError("User not found", 404);
            await repository.insertBlock(db, blockerId, targetId);
        },

        async unblockUser(db: ChatDb, blockerId: number, targetId: number) {
            await repository.deleteBlock(db, blockerId, targetId);
        },

        async findOrCreateDirectConversation(db: ChatDb, userId: number, otherUserId: number) {
            if (userId === otherUserId) {
                const user = await repository.getActiveUser(db, userId);
                if (!user) throw new ChatError("User not found", 400);
                return repository.findOrCreateSelfConversation(db, userId, user.org_id);
            }

            const users = await repository.getActiveUsers(db, [userId, otherUserId]);
            if (users.length !== 2) throw new ChatError("User not found", 400);
            if (users[0].org_id !== users[1].org_id || !users[0].org_id) {
                throw new ChatError("Users must be in the same organization", 403);
            }
            return repository.findOrCreateDirectConversation(db, userId, otherUserId, users[0].org_id);
        },

        async createGroupConversation(
            db: ChatDb,
            creatorId: number,
            name: string,
            userIds: unknown[],
        ) {
            const allIds = [...new Set([creatorId, ...userIds.map(Number)])];
            const orgId = await repository.getUserOrgId(db, creatorId);
            if (!orgId) throw new ChatError("No organization", 400);

            const inOrg = await repository.getUsersInOrg(db, allIds, orgId);
            if (inOrg.length !== allIds.length) {
                throw new ChatError("Some users not found in your organization", 400);
            }

            return {
                conversation: await repository.createGroupConversation(
                    db,
                    orgId,
                    name.trim().slice(0, 100),
                    creatorId,
                    allIds,
                ),
                participantIds: allIds.filter((id) => id !== creatorId),
            };
        },

        async listConversationMembers(db: ChatDb, userId: number, conversationId: number) {
            if (!(await repository.verifyParticipant(db, conversationId, userId))) {
                throw new ChatError("Not a participant", 403);
            }
            return repository.listConversationMembers(db, conversationId);
        },

        async toggleConversationPin(db: ChatDb, userId: number, conversationId: number) {
            if (!(await repository.verifyParticipant(db, conversationId, userId))) {
                throw new ChatError("Not a participant", 403);
            }
            return repository.toggleConversationPin(db, conversationId, userId);
        },

        async toggleConversationFavourite(db: ChatDb, userId: number, conversationId: number) {
            if (!(await repository.verifyParticipant(db, conversationId, userId))) {
                throw new ChatError("Not a participant", 403);
            }
            return repository.toggleConversationFavourite(db, conversationId, userId);
        },

        async setConversationMute(
            db: ChatDb,
            userId: number,
            conversationId: number,
            duration: unknown,
        ) {
            if (!(await repository.verifyParticipant(db, conversationId, userId))) {
                throw new ChatError("Not a participant", 403);
            }
            if (duration === undefined) {
                return repository.setConversationMute(db, conversationId, userId, "toggle");
            }
            if (duration === null || duration === "") {
                return repository.setConversationMute(db, conversationId, userId, "unmute");
            }
            if (duration === "always") {
                return repository.setConversationMute(db, conversationId, userId, "always");
            }
            const durationMs: Record<string, number> = {
                "1h": 60 * 60 * 1000,
                "8h": 8 * 60 * 60 * 1000,
                "1d": 24 * 60 * 60 * 1000,
                "1w": 7 * 24 * 60 * 60 * 1000,
            };
            const milliseconds = durationMs[String(duration)];
            if (!milliseconds) {
                throw new ChatError("Invalid duration (expected 1h | 8h | 1d | 1w | always | null)");
            }
            return repository.setConversationMute(
                db,
                conversationId,
                userId,
                "until",
                new Date(Date.now() + milliseconds).toISOString(),
            );
        },

        async toggleConversationArchive(db: ChatDb, userId: number, conversationId: number) {
            if (!(await repository.verifyParticipant(db, conversationId, userId))) {
                throw new ChatError("Not a participant", 403);
            }
            return repository.toggleConversationArchive(db, conversationId, userId);
        },
    };
}
