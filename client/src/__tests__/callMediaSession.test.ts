import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  fetchCallMediaSession,
  forgetCallMediaSession,
  parseCallMediaSession,
  MEDIA_SESSION_ATTEMPTS,
} from "../components/chat/call/media/mediaSessionClient";

vi.mock("../api", () => ({
  getCallMediaSession: vi.fn(),
  rejectCallHttp: vi.fn(),
  endCallHttp: vi.fn(),
}));

const livekitBody = {
  backend: "livekit",
  callId: 7,
  conversationId: 3,
  livekit: {
    serverUrl: "wss://sfu.example.com",
    token: "jwt-token",
    roomName: "call-7",
  },
};

const opts = (request: unknown, extra: Record<string, unknown> = {}) => ({
  request: request as never,
  retryDelayMs: 0,
  ...extra,
});

describe("parseCallMediaSession", () => {
  it("selects livekit when the server returns complete credentials", () => {
    const session = parseCallMediaSession(livekitBody, 7, 3);
    expect(session?.backend).toBe("livekit");
    expect(session?.livekit?.serverUrl).toBe("wss://sfu.example.com");
    expect(session?.livekit?.token).toBe("jwt-token");
    expect(session?.livekit?.roomName).toBe("call-7");
  });

  it("selects p2p ONLY on an explicit server p2p verdict", () => {
    const session = parseCallMediaSession({ backend: "p2p", callId: 7, conversationId: 3 }, 7, 3);
    expect(session?.backend).toBe("p2p");
    expect(session?.livekit).toBeUndefined();
  });

  it("rejects a livekit verdict with missing credentials instead of degrading", () => {
    for (const livekit of [
      undefined,
      {},
      { serverUrl: "wss://x", token: "t" },
      { serverUrl: "wss://x", token: "", roomName: "r" },
      { serverUrl: " ", token: "t", roomName: "r" },
    ]) {
      expect(parseCallMediaSession({ backend: "livekit", livekit }, 7, 3)).toBeNull();
    }
  });

  it("rejects garbage bodies instead of degrading to p2p", () => {
    expect(parseCallMediaSession(null, 7, 3)).toBeNull();
    expect(parseCallMediaSession("nope", 7, 3)).toBeNull();
    expect(parseCallMediaSession({}, 7, 3)).toBeNull();
    expect(parseCallMediaSession({ backend: "webrtc" }, 7, 3)).toBeNull();
  });
});

describe("fetchCallMediaSession", () => {
  beforeEach(() => {
    forgetCallMediaSession();
    vi.useRealTimers();
  });

  it("resolves the backend from the media-session route", async () => {
    const request = vi.fn().mockResolvedValue({ data: livekitBody });
    const result = await fetchCallMediaSession(7, 3, opts(request));
    expect(result.ok).toBe(true);
    expect(result.ok && result.session.backend).toBe("livekit");
    expect(request).toHaveBeenCalledWith(7, 3, expect.anything());
  });

  it("decides ONCE per call — a second answer cannot flip a live call", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: livekitBody })
      .mockResolvedValueOnce({ data: { backend: "p2p" } });

    const first = await fetchCallMediaSession(7, 3, opts(request));
    const second = await fetchCallMediaSession(7, 3, opts(request));

    expect(first.ok && first.session.backend).toBe("livekit");
    expect(second.ok && second.session.backend).toBe("livekit");
    expect(second.ok && first.ok && second.session).toBe(first.ok && first.session);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("collapses concurrent negotiations for the same call", async () => {
    const request = vi.fn().mockResolvedValue({ data: livekitBody });
    const [a, b] = await Promise.all([
      fetchCallMediaSession(7, 3, opts(request)),
      fetchCallMediaSession(7, 3, opts(request)),
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(a.ok && a.session).toBe(b.ok && b.session);
  });

  /*
   * The whole point of the rewrite: NOTHING below is allowed to answer "p2p".
   * A client that picks a transport on its own can land on a different plane
   * than the peer, which produces a connected-looking call with no media.
   */
  it.each([
    ["404 unknown call", { response: { status: 404 } }],
    ["405 route not allowed", { response: { status: 405 } }],
    ["409 not joinable", { response: { status: 409 } }],
    ["501 route missing", { response: { status: 501 } }],
    ["503 backend down", { response: { status: 503 } }],
  ])("fails call setup on %s and never chooses a transport locally", async (_label, err) => {
    const request = vi.fn().mockRejectedValue(err);
    const result = await fetchCallMediaSession(7, 3, opts(request));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.failure.reason).toBe("http");
    expect(!result.ok && result.failure.status).toBe(
      (err as { response: { status: number } }).response.status,
    );
    expect(request).toHaveBeenCalledTimes(MEDIA_SESSION_ATTEMPTS);
  });

  it("fails call setup on a transport error", async () => {
    const request = vi.fn().mockRejectedValue(new Error("network down"));
    const result = await fetchCallMediaSession(11, 3, opts(request));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.failure.reason).toBe("network");
  });

  it("fails call setup when the negotiation keeps timing out", async () => {
    const request = vi.fn().mockImplementation(() => new Promise(() => {}));
    const result = await fetchCallMediaSession(9, 3, opts(request, { timeoutMs: 5 }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.failure.reason).toBe("timeout");
    expect(request).toHaveBeenCalledTimes(MEDIA_SESSION_ATTEMPTS);
  });

  it("fails call setup on a malformed livekit body rather than running p2p", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ data: { backend: "livekit", callId: 7, conversationId: 3 } });
    const result = await fetchCallMediaSession(13, 3, opts(request));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.failure.reason).toBe("malformed");
    expect(request).toHaveBeenCalledTimes(MEDIA_SESSION_ATTEMPTS);
  });

  it("retries boundedly and honours a late success", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce({ data: livekitBody });
    const result = await fetchCallMediaSession(21, 3, opts(request));
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.ok && result.session.backend).toBe("livekit");
  });

  it("does not let a failed call poison the next one", async () => {
    const failing = vi.fn().mockRejectedValue({ response: { status: 501 } });
    expect((await fetchCallMediaSession(7, 3, opts(failing))).ok).toBe(false);
    const ok = vi.fn().mockResolvedValue({ data: livekitBody });
    const next = await fetchCallMediaSession(8, 3, opts(ok));
    expect(next.ok && next.session.backend).toBe("livekit");
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
