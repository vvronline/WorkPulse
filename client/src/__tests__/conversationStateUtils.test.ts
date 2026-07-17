import { describe, expect, it } from "vitest";
import {
    isCurrentConversationRequest,
    mergeTimelineMessages,
} from "../pages/chat/conversationStateUtils";
import { buildDraftKey } from "../pages/chat/useConversationDraft";
import {
    applyRealtimeDelete,
    applyRealtimeEdit,
    applyRealtimeReaction,
    mapRealtimeMessage,
    updateRealtimeMessage,
} from "../pages/chat/chatRealtimeReducers";

describe("conversation state utilities", () => {
    it("rejects a stale response after switching from conversation A to B", () => {
        expect(isCurrentConversationRequest(1, 2, 10, 20)).toBe(false);
    });

    it("rejects a response whose conversation no longer matches", () => {
        expect(isCurrentConversationRequest(2, 2, 10, 20)).toBe(false);
    });

    it("accepts only the current generation for the active conversation", () => {
        expect(isCurrentConversationRequest(2, 2, 20, 20)).toBe(true);
    });

    it("preserves realtime and optimistic rows received during history loading", () => {
        const current = [
            {
                id: "pending-1",
                content: "optimistic",
                created_at: "2026-01-01T00:00:02.000Z",
            },
            {
                id: 3,
                content: "realtime",
                created_at: "2026-01-01T00:00:03.000Z",
            },
        ];
        const fetched = [
            {
                id: 1,
                content: "history",
                created_at: "2026-01-01T00:00:01.000Z",
            },
        ];

        expect(mergeTimelineMessages(current, fetched).map((m) => m.id)).toEqual([
            1,
            "pending-1",
            3,
        ]);
    });

    it("namespaces drafts by tenant, user, and conversation", () => {
        expect(
            buildDraftKey({ id: 7, tenantId: 2 }, 11),
        ).toBe("chat:v2:draft:2:7:11");
        expect(
            buildDraftKey({ id: 7, tenantId: 3 }, 11),
        ).not.toBe("chat:v2:draft:2:7:11");
        expect(buildDraftKey(null, 11)).toBeNull();
    });

    it("maps and targets realtime message updates without mutating other rows", () => {
        const mapped = mapRealtimeMessage({
            id: 9,
            senderId: 2,
            content: "hello",
            createdAt: "2026-01-01T00:00:00.000Z",
        });
        const untouched = {
            id: 8,
            content: "untouched",
            created_at: "2026-01-01T00:00:00.000Z",
        };

        const edited = updateRealtimeMessage(
            [untouched, mapped],
            9,
            (message) =>
                applyRealtimeEdit(message, {
                    content: "edited",
                    editedAt: "2026-01-01T00:01:00.000Z",
                }),
        );

        expect(edited[0]).toBe(untouched);
        expect(edited[1]).toMatchObject({
            id: 9,
            content: "edited",
            edited_at: "2026-01-01T00:01:00.000Z",
        });
    });

    it("keeps reactions idempotent and clears content on realtime delete", () => {
        const base = mapRealtimeMessage({
            id: 5,
            senderId: 2,
            content: "message",
            createdAt: "2026-01-01T00:00:00.000Z",
        });
        const event = {
            action: "added",
            userId: 3,
            fullName: "User Three",
            emoji: "👍",
        };

        const once = applyRealtimeReaction(base, event);
        const twice = applyRealtimeReaction(once, event);
        expect(twice.reactions).toHaveLength(1);

        const deleted = applyRealtimeDelete(twice);
        expect(deleted).toMatchObject({
            content: "",
            file_url: null,
            reactions: [],
        });
        expect(deleted.deleted_at).toBeTruthy();
    });

    it("deduplicates by id and lets canonical fetched rows replace local rows", () => {
        const result = mergeTimelineMessages(
            [
                {
                    id: 7,
                    content: "local",
                    created_at: "2026-01-01T00:00:02.000Z",
                    _pending: true,
                },
            ],
            [
                {
                    id: 7,
                    content: "canonical",
                    created_at: "2026-01-01T00:00:01.000Z",
                    _pending: false,
                },
            ],
        );

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            id: 7,
            content: "canonical",
            _pending: false,
        });
    });
});