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

function makeTransactionalDb(responses: Array<{ rows: any[]; rowCount?: number }>): ChatDb {
    const db = makeDb(responses);
    db.transaction = async (fn) => fn(db);
    return db;
}

describe("chat.service toggleReaction", () => {
    test("rejects reactions on deleted messages", async () => {
        const db = makeDb([
            { rows: [{ id: 12, conversation_id: 10, deleted_at: new Date().toISOString() }] },
        ]);
        const service = createChatService();

        await expect(service.toggleReaction(db, 1, 12, "👍")).rejects.toThrow(/deleted/i);
    });

    describe("chat.service toggleConversationArchive", () => {
        test("toggles a participating user's archived state", async () => {
            const db = makeDb([{ rows: [{ user_id: 1 }] }, { rows: [{ is_archived: true }] }]);

            await expect(createChatService().toggleConversationArchive(db, 1, 12)).resolves.toBe(true);
        });

        test("rejects a non-participant", async () => {
            const db = makeDb([{ rows: [] }]);

            await expect(createChatService().toggleConversationArchive(db, 1, 12)).rejects.toThrow(
                /participant/i,
            );
        });
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

    describe("chat.service listConversationMembers", () => {
        test("rejects a non-participant", async () => {
            const db = makeDb([{ rows: [] }]);

            await expect(createChatService().listConversationMembers(db, 1, 12)).rejects.toThrow(
                /participant/i,
            );
        });

        describe("chat.service toggleConversationPin", () => {
            test("toggles a participating user's pin state", async () => {
                const db = makeDb([{ rows: [{ user_id: 1 }] }, { rows: [{ is_pinned: true }] }]);

                await expect(createChatService().toggleConversationPin(db, 1, 12)).resolves.toBe(true);
            });

            describe("chat.service toggleConversationFavourite", () => {
                test("toggles a participating user's favourite state", async () => {
                    const db = makeDb([{ rows: [{ user_id: 1 }] }, { rows: [{ is_favourite: true }] }]);

                    await expect(createChatService().toggleConversationFavourite(db, 1, 12)).resolves.toBe(true);
                });

                describe("chat.service setConversationMute", () => {
                    test("sets a permanent mute for a participant", async () => {
                        const db = makeDb([{ rows: [{ user_id: 1 }] }, { rows: [{ is_muted: true, muted_until: null }] }]);

                        await expect(createChatService().setConversationMute(db, 1, 12, "always")).resolves.toEqual({
                            is_muted: true,
                            muted_until: null,
                        });

                    });

                    test("rejects an invalid duration", async () => {
                        const db = makeDb([{ rows: [{ user_id: 1 }] }]);

                        await expect(createChatService().setConversationMute(db, 1, 12, "2h")).rejects.toThrow(
                            /invalid duration/i,
                        );
                    });
                });

                test("rejects a non-participant", async () => {
                    const db = makeDb([{ rows: [] }]);

                    await expect(createChatService().toggleConversationFavourite(db, 1, 12)).rejects.toThrow(
                        /participant/i,
                    );
                });
            });

            test("rejects a non-participant", async () => {
                const db = makeDb([{ rows: [] }]);

                await expect(createChatService().toggleConversationPin(db, 1, 12)).rejects.toThrow(
                    /participant/i,
                );
            });
        });

        test("returns members for a participant", async () => {
            const members = [{ id: 1, role: "owner" }, { id: 2, role: "member" }];
            const db = makeDb([{ rows: [{ user_id: 1 }] }, { rows: members }]);

            await expect(createChatService().listConversationMembers(db, 1, 12)).resolves.toEqual(members);
        });
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

    describe("chat.service findOrCreateDirectConversation", () => {
        test("creates a self conversation when one does not exist", async () => {
            const db = makeTransactionalDb([
                { rows: [{ id: 1, org_id: 5 }] },
                { rows: [] },
                { rows: [{ id: 12 }] },
                { rows: [] },
            ]);

            await expect(createChatService().findOrCreateDirectConversation(db, 1, 1)).resolves.toEqual({
                id: 12,
            });

        });

        test("rejects direct conversations across organizations", async () => {
            const db = makeDb([{ rows: [{ id: 1, org_id: 5 }, { id: 2, org_id: 6 }] }]);

            await expect(createChatService().findOrCreateDirectConversation(db, 1, 2)).rejects.toThrow(
                /same organization/i,
            );
        });
    });

    describe("chat.service repository delegation", () => {
        test("builds a paginated message query with the original parameter positions", async () => {
            const db = makeDb([{ rows: [] }]);

            await createChatService().listMessages(db, 7, 12, 99, 50);

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining("m.id < $3 ORDER BY m.created_at DESC LIMIT $4"),
                [7, 12, 99, 50],
            );
        });

        test("uses the scoped message search statement for a conversation", async () => {
            const db = makeDb([{ rows: [] }]);

            await createChatService().searchMessages(db, 7, 12, "%hello%");

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining("WHERE m.conversation_id = $1"),
                [12, "%hello%"],
            );
        });
    });

    describe("chat.service createGroupConversation", () => {
        test("creates a group with the creator as owner", async () => {
            const db = makeTransactionalDb([
                { rows: [{ org_id: 5 }] },
                { rows: [{ id: 1 }, { id: 2 }] },
                { rows: [{ id: 12 }] },
                { rows: [] },
                { rows: [] },
            ]);

            const result = await createChatService().createGroupConversation(db, 1, " Team ", [2]);

            expect(result).toEqual({ conversation: { id: 12 }, participantIds: [2] });
            expect(db.query).toHaveBeenLastCalledWith(
                expect.stringContaining("INSERT INTO conversation_participants"),
                [12, 2, "member"],
            );
        });

        test("rejects members outside the creator organization", async () => {
            const db = makeDb([
                { rows: [{ org_id: 5 }] },
                { rows: [{ id: 1 }] },
            ]);

            await expect(createChatService().createGroupConversation(db, 1, "Team", [2])).rejects.toThrow(
                /not found/i,
            );
        });
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
