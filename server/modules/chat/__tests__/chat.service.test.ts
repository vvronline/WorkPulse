import { createChatService } from "../chat.service";
import { ChatError } from "../chat.types";
import type { ChatDb } from "../chat.types";

function makeDb(responses: Array<{ rows: any[]; rowCount?: number }>): ChatDb {
    let call = 0;
    return {
        query: jest.fn(async () => {
            const r = responses[call] ?? { rows: [], rowCount: 0 };
            call += 1;
            return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
        }),
    };
}

describe("chat.service toggleReaction", () => {
    test("rejects reactions on deleted messages", async () => {
        const db = makeDb([
            { rows: [{ id: 12, conversation_id: 10, deleted_at: new Date().toISOString() }] },
        ]);
        const service = createChatService();

        await expect(service.toggleReaction(db, 1, 12, "👍")).rejects.toThrow(/deleted/i);
    });

    test("rejects reactions from non-participants", async () => {
        const db = makeDb([
            { rows: [{ id: 12, conversation_id: 10, deleted_at: null }] },
            { rows: [] }, // verifyParticipant miss
        ]);
        const service = createChatService();

        await expect(service.toggleReaction(db, 1, 12, "👍")).rejects.toThrow(/participant/i);
    });

    test("adds a reaction when none exists yet", async () => {
        const db = makeDb([
            { rows: [{ id: 12, conversation_id: 10, deleted_at: null }] }, // getMessage
            { rows: [{ user_id: 1 }] }, // verifyParticipant hit
            { rows: [] }, // findExistingReaction miss
            { rows: [] }, // insertReaction
            { rows: [{ full_name: "Alice" }] }, // getUserDisplayName
            { rows: [{ user_id: 1 }, { user_id: 2 }] }, // getConversationParticipantIds
        ]);
        const service = createChatService();

        const result = await service.toggleReaction(db, 1, 12, "👍");
        expect(result.action).toBe("added");
        expect(result.participantIds).toEqual([1, 2]);
    });
});

describe("chat.service togglePin", () => {
    test("rejects pin from non-participants", async () => {
        const db = makeDb([
            { rows: [{ id: 12, conversation_id: 10, deleted_at: null, pinned_at: null }] },
            { rows: [] },
        ]);
        const service = createChatService();

        await expect(service.togglePin(db, 1, 12)).rejects.toThrow(/participant/i);
    });
});

describe("chat.service toggleStar", () => {
    test("stars an unstarred message", async () => {
        const db = makeDb([
            { rows: [{ id: 12, conversation_id: 10, deleted_at: null }] }, // getMessage
            { rows: [{ user_id: 1 }] }, // verifyParticipant hit
            { rows: [] }, // findStarred miss
            { rows: [] }, // insertStar
        ]);
        const service = createChatService();

        const result = await service.toggleStar(db, 1, 12);
        expect(result.starred).toBe(true);
    });
});

describe("chat.service blockUser/unblockUser", () => {
    test("rejects blocking yourself", async () => {
        const db = makeDb([]);
        const service = createChatService();

        await expect(service.blockUser(db, 1, 1)).rejects.toThrow(/invalid user/i);
    });

    test("rejects blocking a user outside the org", async () => {
        const db = makeDb([
            { rows: [{ org_id: 5 }] }, // getUserOrgId
            { rows: [] }, // getUserInOrg miss
        ]);
        const service = createChatService();

        await expect(service.blockUser(db, 1, 2)).rejects.toThrow(/not found/i);
    });

    test("blocks a valid same-org user", async () => {
        const db = makeDb([
            { rows: [{ org_id: 5 }] }, // getUserOrgId
            { rows: [{ id: 2 }] }, // getUserInOrg hit
            { rows: [] }, // insertBlock
        ]);
        const service = createChatService();

        await expect(service.blockUser(db, 1, 2)).resolves.toBeUndefined();
    });

    test("unblocks a user (idempotent, no lookup required)", async () => {
        const db = makeDb([{ rows: [] }]); // deleteBlock
        const service = createChatService();

        await expect(service.unblockUser(db, 1, 2)).resolves.toBeUndefined();
    });
});
