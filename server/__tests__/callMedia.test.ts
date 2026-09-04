export {};

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  fatal: jest.fn(),
};
jest.mock("../utils/logger", () => ({ logger: mockLogger }));

const {
  cleanupCallMediaRoom,
  getCallMediaBackend,
  getCallMediaSession,
  liveKitApiUrl,
  liveKitRoomName,
  validateCallMediaEnvironment,
} = require("../services/callMedia");
const { TokenVerifier } = require("livekit-server-sdk");
const jwt = require("jsonwebtoken");

describe("call media configuration and sessions", () => {
  const oldEnv = process.env;

  beforeEach(() => {
    process.env = { ...oldEnv };
    delete process.env.CALL_MEDIA_BACKEND;
    delete process.env.LIVEKIT_URL;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = oldEnv;
  });

  test("defaults to p2p without LiveKit configuration", () => {
    expect(getCallMediaBackend()).toBe("p2p");
    expect(validateCallMediaEnvironment()).toBe("p2p");
  });

  test("fails explicitly when LiveKit is selected without required variables", () => {
    process.env.CALL_MEDIA_BACKEND = "livekit";
    expect(() => validateCallMediaEnvironment()).toThrow(
      /LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET/,
    );
  });

  test("rejects an empty API key and a secret shorter than 32 characters", () => {
    process.env.CALL_MEDIA_BACKEND = "livekit";
    process.env.LIVEKIT_URL = "wss://calls.example.test";
    process.env.LIVEKIT_API_KEY = " ";
    process.env.LIVEKIT_API_SECRET = "test-secret-at-least-32-characters";
    expect(() => validateCallMediaEnvironment()).toThrow(
      /requires LIVEKIT_API_KEY/,
    );

    process.env.LIVEKIT_API_KEY = "test-key";
    process.env.LIVEKIT_API_SECRET = "short-secret";
    expect(() => validateCallMediaEnvironment()).toThrow(
      /LIVEKIT_API_SECRET must be at least 32 characters/,
    );
  });

  test("rejects invalid backend values", () => {
    process.env.CALL_MEDIA_BACKEND = "other";
    expect(() => validateCallMediaEnvironment()).toThrow(
      /CALL_MEDIA_BACKEND must be either p2p or livekit/,
    );
  });

  test("keeps the client URL on wss and derives the HTTPS RoomService URL", () => {
    process.env.CALL_MEDIA_BACKEND = "livekit";
    process.env.LIVEKIT_URL = "https://calls.example.test";
    process.env.LIVEKIT_API_KEY = "test-key";
    process.env.LIVEKIT_API_SECRET = "test-secret-at-least-32-characters";
    expect(() => validateCallMediaEnvironment()).toThrow(
      /LIVEKIT_URL must be a public wss:\/\/ URL/,
    );
    expect(liveKitApiUrl("wss://calls.example.test")).toBe(
      "https://calls.example.test",
    );
  });

  test("returns least-privilege tokens with a stable identity for one user's devices", async () => {
    process.env.LIVEKIT_URL = "wss://calls.example.test";
    process.env.LIVEKIT_API_KEY = "test-key";
    process.env.LIVEKIT_API_SECRET = "test-secret-at-least-32-characters";
    const query = jest.fn().mockResolvedValue({
      rows: [
        {
          id: 44,
          conversation_id: 9,
          call_type: "voice",
          status: "answered",
          media_backend: "livekit",
        },
      ],
    });
    const createRoom = jest.fn().mockResolvedValue({ name: "room" });
    const deleteRoom = jest.fn();

    const result = await getCallMediaSession(
      { query },
      { callId: 44, conversationId: 9, userId: 3, tenantId: 2 },
      { createRoom, deleteRoom },
    );

    expect(result.kind).toBe("ok");
    const session = result.session;
    expect(session).toMatchObject({
      backend: "livekit",
      callId: 44,
      conversationId: 9,
      livekit: {
        serverUrl: "wss://calls.example.test",
        roomName: liveKitRoomName(
          2,
          44,
          "test-secret-at-least-32-characters",
        ),
      },
    });
    expect(query.mock.calls[0][0]).toContain(
      "JOIN conversation_participants",
    );
    expect(query.mock.calls[0][1]).toEqual([44, 9, 3]);
    expect(createRoom).toHaveBeenCalledWith({
      name: session.livekit.roomName,
      maxParticipants: 2,
    });

    const claims = await new TokenVerifier(
      "test-key",
      "test-secret-at-least-32-characters",
    ).verify(session.livekit.token);
    expect(claims.sub).toMatch(/^participant_/);
    expect(claims.video).toMatchObject({
      roomJoin: true,
      room: session.livekit.roomName,
      canSubscribe: true,
      canPublishData: false,
      canPublishSources: ["microphone"],
    });
    const rawClaims = jwt.decode(session.livekit.token);
    expect(Number(rawClaims.exp) - Number(rawClaims.nbf)).toBe(5 * 60);
    expect(claims.video.roomAdmin).not.toBe(true);
    expect(claims.video.roomCreate).not.toBe(true);

    const second = await getCallMediaSession(
      { query },
      { callId: 44, conversationId: 9, userId: 3, tenantId: 2 },
      { createRoom, deleteRoom },
    );
    const secondClaims = await new TokenVerifier(
      "test-key",
      "test-secret-at-least-32-characters",
    ).verify(second.session.livekit.token);
    expect(second.session.livekit.roomName).toBe(session.livekit.roomName);
    expect(secondClaims.sub).toBe(claims.sub);
    expect(createRoom).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(4);
  });

  test("does not mint a session for unauthorized or terminal calls", async () => {
    const roomService = {
      createRoom: jest.fn(),
      deleteRoom: jest.fn(),
    };
    const unauthorized = await getCallMediaSession(
      { query: jest.fn().mockResolvedValue({ rows: [] }) },
      { callId: 44, conversationId: 9, userId: 99, tenantId: 2 },
      roomService,
    );
    const terminal = await getCallMediaSession(
      {
        query: jest.fn().mockResolvedValue({
          rows: [
            {
              id: 44,
              conversation_id: 9,
              status: "ended",
              media_backend: "livekit",
            },
          ],
        }),
      },
      { callId: 44, conversationId: 9, userId: 3, tenantId: 2 },
      roomService,
    );

    expect(unauthorized).toEqual({ kind: "not_found" });
    expect(terminal).toEqual({
      kind: "not_joinable",
      status: "ended",
      phase: "initial",
    });
    expect(roomService.createRoom).not.toHaveBeenCalled();
    expect(roomService.deleteRoom).not.toHaveBeenCalled();
  });

  test("p2p sessions never require or expose LiveKit credentials", async () => {
    const createRoom = jest.fn();
    const deleteRoom = jest.fn();
    const result = await getCallMediaSession(
      {
        query: jest.fn().mockResolvedValue({
          rows: [
            {
              id: 45,
              conversation_id: 9,
              call_type: "voice",
              status: "ringing",
              media_backend: "p2p",
            },
          ],
        }),
      },
      { callId: 45, conversationId: 9, userId: 3, tenantId: 2 },
      { createRoom, deleteRoom },
    );

    expect(result).toEqual({
      kind: "ok",
      session: { backend: "p2p", callId: 45, conversationId: 9 },
    });
    expect(createRoom).not.toHaveBeenCalled();
  });

  test("deletes a room created while the call transitions terminal", async () => {
    process.env.LIVEKIT_URL = "wss://calls.example.test";
    process.env.LIVEKIT_API_KEY = "test-key";
    process.env.LIVEKIT_API_SECRET = "test-secret-at-least-32-characters";
    let status = "ringing";
    let finishCreate!: () => void;
    const createRoom = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCreate = resolve;
        }),
    );
    const deleteRoom = jest.fn().mockResolvedValue(undefined);
    const query = jest.fn().mockImplementation(() =>
      Promise.resolve({
        rows: [
          {
            id: 46,
            conversation_id: 9,
            call_type: "voice",
            status,
            media_backend: "livekit",
          },
        ],
      }),
    );

    const pending = getCallMediaSession(
      { query },
      { callId: 46, conversationId: 9, userId: 3, tenantId: 2 },
      { createRoom, deleteRoom },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(createRoom).toHaveBeenCalledTimes(1);

    status = "ended";
    finishCreate();

    await expect(pending).resolves.toEqual({
      kind: "not_joinable",
      status: "ended",
      phase: "after_create",
    });
    expect(deleteRoom).toHaveBeenCalledWith(
      liveKitRoomName(2, 46, "test-secret-at-least-32-characters"),
    );
  });

  test("terminal cleanup after the final recheck deletes the issued room", async () => {
    process.env.LIVEKIT_URL = "wss://calls.example.test";
    process.env.LIVEKIT_API_KEY = "test-key";
    process.env.LIVEKIT_API_SECRET = "test-secret-at-least-32-characters";
    const roomService = {
      createRoom: jest.fn().mockResolvedValue({ name: "room" }),
      deleteRoom: jest.fn().mockResolvedValue(undefined),
    };
    const call = {
      id: 47,
      conversation_id: 9,
      call_type: "voice",
      status: "answered",
      media_backend: "livekit",
    };

    await expect(
      getCallMediaSession(
        { query: jest.fn().mockResolvedValue({ rows: [call] }) },
        { callId: 47, conversationId: 9, userId: 3, tenantId: 2 },
        roomService,
      ),
    ).resolves.toMatchObject({ kind: "ok" });
    await cleanupCallMediaRoom(
      { callId: 47, tenantId: 2, mediaBackend: "livekit" },
      roomService,
    );

    expect(roomService.createRoom).toHaveBeenCalledTimes(1);
    expect(roomService.deleteRoom).toHaveBeenCalledWith(
      liveKitRoomName(2, 47, "test-secret-at-least-32-characters"),
    );
  });

  test("room cleanup is attempted once and failures are contained", async () => {
    process.env.LIVEKIT_URL = "wss://calls.example.test";
    process.env.LIVEKIT_API_KEY = "test-key";
    process.env.LIVEKIT_API_SECRET = "test-secret-at-least-32-characters";
    const deleteRoom = jest.fn().mockRejectedValue(new Error("offline"));

    await expect(
      cleanupCallMediaRoom(
        { callId: 44, tenantId: 2, mediaBackend: "livekit" },
        { deleteRoom },
      ),
    ).resolves.toEqual({ attempted: true, ok: false });
    expect(deleteRoom).toHaveBeenCalledWith(
      liveKitRoomName(2, 44, "test-secret-at-least-32-characters"),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 44, tenantId: 2, err: "offline" }),
      "LiveKit call room cleanup failed",
    );
  });

  test("room cleanup treats an already-absent room as idempotent success", async () => {
    process.env.LIVEKIT_URL = "wss://calls.example.test";
    process.env.LIVEKIT_API_KEY = "test-key";
    process.env.LIVEKIT_API_SECRET = "test-secret-at-least-32-characters";
    const deleteRoom = jest
      .fn()
      .mockRejectedValue({ status: 404, code: "not_found" });

    await expect(
      cleanupCallMediaRoom(
        { callId: 48, tenantId: 2, mediaBackend: "livekit" },
        { deleteRoom },
      ),
    ).resolves.toEqual({ attempted: true, ok: true });
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      { callId: 48, tenantId: 2 },
      "LiveKit call room already absent",
    );
  });
});
