import { api } from "../../../api";
import {
  getCallMediaSession,
  MediaSessionSelection,
} from "../mediaSession";

const mockGet = jest.spyOn(api, "get");

describe("call media selection", () => {
  beforeEach(() => mockGet.mockReset());

  it("loads and validates the server-selected backend", async () => {
    mockGet.mockResolvedValue({
      data: {
        backend: "livekit",
        callId: 41,
        conversationId: 9,
        livekit: {
          serverUrl: "wss://live.example.test",
          token: "token",
          roomName: "call-41",
        },
      },
    } as never);

    await expect(getCallMediaSession(41, 9)).resolves.toMatchObject({
      backend: "livekit",
      callId: 41,
    });
    expect(mockGet).toHaveBeenCalledWith("/chat/calls/41/media-session", {
      params: { conversationId: 9 },
    });
  });

  it("retries a rejected prewarm request", async () => {
    const selection = new MediaSessionSelection();
    const failure = new Error("LiveKit unavailable");
    const livekitLoad = jest.fn().mockRejectedValue(failure);
    const retry = jest.fn().mockResolvedValue({
      backend: "p2p" as const,
      callId: 41,
      conversationId: 9,
    });

    await expect(selection.resolve(livekitLoad)).rejects.toBe(failure);
    await expect(selection.resolve(retry)).resolves.toMatchObject({
      backend: "p2p",
    });
    expect(livekitLoad).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("selects once and never falls back mid-call", async () => {
    const selection = new MediaSessionSelection();
    const livekitLoad = jest.fn().mockResolvedValue({
      backend: "livekit" as const,
      callId: 41,
      conversationId: 9,
      livekit: {
        serverUrl: "wss://live.example.test",
        token: "token",
        roomName: "call-41",
      },
    });
    const p2pFallback = jest.fn().mockResolvedValue({
      backend: "p2p" as const,
      callId: 41,
      conversationId: 9,
    });

    await expect(selection.resolve(livekitLoad)).resolves.toMatchObject({
      backend: "livekit",
    });
    await expect(selection.resolve(p2pFallback)).resolves.toMatchObject({
      backend: "livekit",
    });
    expect(selection.peek()).toMatchObject({ backend: "livekit" });
    expect(p2pFallback).not.toHaveBeenCalled();
  });

  it("shares an in-flight request", async () => {
    const selection = new MediaSessionSelection();
    let release!: (value: {
      backend: "p2p";
      callId: number;
      conversationId: number;
    }) => void;
    const load = jest.fn(
      () =>
        new Promise<{
          backend: "p2p";
          callId: number;
          conversationId: number;
        }>((resolve) => {
          release = resolve;
        }),
    );

    const first = selection.resolve(load);
    const second = selection.resolve(load);
    release({ backend: "p2p", callId: 41, conversationId: 9 });

    await expect(first).resolves.toMatchObject({ backend: "p2p" });
    await expect(second).resolves.toMatchObject({ backend: "p2p" });
    expect(load).toHaveBeenCalledTimes(1);
  });
});
