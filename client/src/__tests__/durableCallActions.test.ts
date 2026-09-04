import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  sendDurableCallAction,
  resetDurableCallActions,
} from "../components/chat/call/media/durableCallActions";

vi.mock("../api", () => ({
  getCallMediaSession: vi.fn(),
  rejectCallHttp: vi.fn(),
  endCallHttp: vi.fn(),
}));

const noSleep = () => Promise.resolve();

describe("sendDurableCallAction", () => {
  beforeEach(() => {
    resetDurableCallActions();
  });

  it("emits the websocket frame with a clientMsgId and confirms over HTTP", async () => {
    const wsSend = vi.fn();
    const httpConfirm = vi.fn().mockResolvedValue({ ok: true });

    const result = await sendDurableCallAction({
      action: "reject",
      callId: 7,
      conversationId: 3,
      wsSend,
      httpConfirm,
      sleep: noSleep,
    });

    expect(wsSend).toHaveBeenCalledTimes(1);
    const [type, payload] = wsSend.mock.calls[0];
    expect(type).toBe("call_reject");
    expect(payload).toMatchObject({ callId: 7, conversationId: 3 });
    expect((payload as any).clientMsgId).toBe(result.clientMsgId);
    expect(result.socketDelivered).toBe(true);
    expect(result.httpConfirmed).toBe(true);
    expect(httpConfirm).toHaveBeenCalledWith("reject", 7, 3);
  });

  it("retries the websocket emit with backoff until the transport accepts it", async () => {
    let live = false;
    const wsSend = vi.fn();
    const httpConfirm = vi.fn().mockResolvedValue({ ok: true });
    const sleeps: number[] = [];

    const result = await sendDurableCallAction({
      action: "end",
      callId: 7,
      conversationId: 3,
      wsSend,
      isSocketLive: () => live,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 3) live = true;
      },
      httpConfirm,
    });

    expect(sleeps.length).toBe(3);
    // Exponential-ish: each wait is at least as long as the previous minus jitter.
    expect(sleeps[1]).toBeGreaterThan(sleeps[0] * 1.5);
    expect(result.socketDelivered).toBe(true);
    expect(wsSend).toHaveBeenCalledTimes(1);
    expect(result.httpConfirmed).toBe(true);
  });

  it("still confirms over HTTP when the socket never accepts the frame", async () => {
    const wsSend = vi.fn(() => {
      throw new Error("socket closed");
    });
    const httpConfirm = vi.fn().mockResolvedValue({ ok: true });

    const result = await sendDurableCallAction({
      action: "reject",
      callId: 7,
      conversationId: 3,
      wsSend,
      sleep: noSleep,
      maxAttempts: 3,
      httpConfirm,
    });

    expect(result.socketDelivered).toBe(false);
    expect(result.httpConfirmed).toBe(true);
    expect(httpConfirm).toHaveBeenCalledTimes(1);
  });

  it("treats a 404 confirmation as confirmed and never throws", async () => {
    const httpConfirm = vi.fn().mockRejectedValue({ response: { status: 404 } });
    const result = await sendDurableCallAction({
      action: "end",
      callId: 7,
      conversationId: 3,
      wsSend: vi.fn(),
      sleep: noSleep,
      httpConfirm,
    });
    expect(result.httpConfirmed).toBe(true);
  });

  it("does not throw when the confirmation fails outright", async () => {
    const httpConfirm = vi.fn().mockRejectedValue(new Error("500"));
    const result = await sendDurableCallAction({
      action: "end",
      callId: 7,
      conversationId: 3,
      wsSend: vi.fn(),
      sleep: noSleep,
      httpConfirm,
    });
    expect(result.httpConfirmed).toBe(false);
    expect(result.socketDelivered).toBe(true);
  });

  it("collapses duplicate presses of the same button", async () => {
    const wsSend = vi.fn();
    let resolveHttp: (v: unknown) => void = () => {};
    const httpConfirm = vi.fn(
      () => new Promise((resolve) => (resolveHttp = resolve)),
    );

    const first = sendDurableCallAction({
      action: "reject",
      callId: 7,
      conversationId: 3,
      wsSend,
      sleep: noSleep,
      httpConfirm,
    });
    const second = sendDurableCallAction({
      action: "reject",
      callId: 7,
      conversationId: 3,
      wsSend,
      sleep: noSleep,
      httpConfirm,
    });

    resolveHttp({ ok: true });
    const [a, b] = await Promise.all([first, second]);

    expect(wsSend).toHaveBeenCalledTimes(1);
    expect(httpConfirm).toHaveBeenCalledTimes(1);
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    expect(b.clientMsgId).toBe(a.clientMsgId);
  });

  it("runs HTTP-only for the p2p path, which already emitted the frame", async () => {
    const wsSend = vi.fn();
    const httpConfirm = vi.fn().mockResolvedValue({ ok: true });

    const result = await sendDurableCallAction({
      action: "end",
      callId: 7,
      conversationId: 3,
      wsSend,
      emitSocket: false,
      sleep: noSleep,
      httpConfirm,
    });

    expect(wsSend).not.toHaveBeenCalled();
    expect(result.socketDelivered).toBe(false);
    expect(result.httpConfirmed).toBe(true);
    expect(httpConfirm).toHaveBeenCalledWith("end", 7, 3);
  });

  it("skips the confirmation when there is no callId to confirm", async () => {
    const wsSend = vi.fn();
    const httpConfirm = vi.fn();
    const result = await sendDurableCallAction({
      action: "end",
      callId: null,
      conversationId: 3,
      wsSend,
      httpConfirm,
    });
    expect(httpConfirm).not.toHaveBeenCalled();
    expect(wsSend).toHaveBeenCalledTimes(1);
    expect(result.httpConfirmed).toBe(false);
  });
});
