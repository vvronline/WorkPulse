export {};

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
  },
}));

const { applyCallAction, createRingingCall } = require("../services/callActions");

describe("shared call actions", () => {
  const originalBackend = process.env.CALL_MEDIA_BACKEND;

  afterEach(() => {
    if (originalBackend === undefined) {
      delete process.env.CALL_MEDIA_BACKEND;
    } else {
      process.env.CALL_MEDIA_BACKEND = originalBackend;
    }
  });

  test("new calls persist the configured backend without an update path", async () => {
    process.env.CALL_MEDIA_BACKEND = "livekit";
    const query = jest.fn().mockResolvedValue({
      rows: [{ id: 12, media_backend: "livekit" }],
    });

    const row = await createRingingCall(
      { query },
      { conversationId: 4, callerId: 7, callType: "video" },
    );

    expect(row.media_backend).toBe("livekit");
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("media_backend"),
      [4, 7, "video", "livekit"],
    );
  });

  test("duplicate accept is unchanged and performs one authoritative update", async () => {
    let status = "ringing";
    const queries: string[] = [];
    const query = jest.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("conversation_participants")) {
        return { rows: [{ "?column?": 1 }] };
      }
      if (sql.startsWith("SELECT * FROM call_logs")) {
        return {
          rows: [
            {
              id: 12,
              conversation_id: 4,
              caller_id: 7,
              call_type: "video",
              status,
              media_backend: "livekit",
            },
          ],
        };
      }
      if (sql.includes("SET status = 'answered'")) {
        status = "answered";
        return { rows: [{ status }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const input = {
      callId: 12,
      conversationId: 4,
      userId: 8,
      action: "accept",
    };
    expect((await applyCallAction({ query }, input)).outcome).toBe("applied");
    const duplicate = await applyCallAction({ query }, input);

    expect(duplicate).toMatchObject({
      outcome: "unchanged",
      status: "answered",
    });
    expect(queries.filter((sql) => sql.startsWith("UPDATE call_logs"))).toHaveLength(
      1,
    );
    expect(queries.join("\n")).not.toMatch(/SET[\s\S]*media_backend/);
  });

  test("terminal end is idempotent and does not update again", async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("conversation_participants")) {
        return { rows: [{ "?column?": 1 }] };
      }
      if (sql.startsWith("SELECT * FROM call_logs")) {
        return {
          rows: [
            {
              id: 13,
              conversation_id: 4,
              caller_id: 7,
              call_type: "voice",
              status: "ended",
              media_backend: "p2p",
            },
          ],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const result = await applyCallAction(
      { query },
      { callId: 13, conversationId: 4, userId: 8, action: "end" },
    );

    expect(result).toMatchObject({ outcome: "unchanged", status: "ended" });
    expect(query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(
      false,
    );
  });

  test("non-participants cannot mutate a call", async () => {
    const query = jest.fn(async (sql: string) =>
      sql.includes("conversation_participants")
        ? { rows: [] }
        : {
            rows: [
              {
                id: 12,
                conversation_id: 4,
                caller_id: 7,
                status: "ringing",
              },
            ],
          },
    );

    await expect(
      applyCallAction(
        { query },
        { callId: 12, conversationId: 4, userId: 99, action: "reject" },
      ),
    ).resolves.toEqual({ outcome: "forbidden" });
    expect(query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(
      false,
    );
  });
});
