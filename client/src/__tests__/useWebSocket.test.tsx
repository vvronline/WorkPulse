import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import useWebSocket from "../hooks/useWebSocket";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  receive(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  close(code = 1006) {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }

  send(value: string) {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error("socket is not open");
    }
    this.sent.push(value);
  }
}

describe("useWebSocket reliable chat delivery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("sends immediately when the socket is available", () => {
    const { result, unmount } = renderHook(() => useWebSocket(vi.fn()));
    const socket = MockWebSocket.instances[0];

    act(() => socket.open());
    act(() =>
      result.current.sendMessage("chat_message", {
        conversationId: 1,
        content: "hello",
        clientMsgId: "pending_one",
      }),
    );

    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0])).toMatchObject({
      type: "chat_message",
      data: { clientMsgId: "pending_one" },
    });
    unmount();
  });

  test("waits offline and flushes as soon as the connection opens", () => {
    const { result, unmount } = renderHook(() => useWebSocket(vi.fn()));
    const socket = MockWebSocket.instances[0];

    act(() =>
      result.current.sendMessage("chat_message", {
        conversationId: 1,
        content: "queued",
        clientMsgId: "pending_offline",
      }),
    );
    expect(socket.sent).toHaveLength(0);

    act(() => socket.open());

    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]).data.clientMsgId).toBe("pending_offline");
    unmount();
  });

  test("retries an unacknowledged message after reconnect and stops after its echo", () => {
    const onMessage = vi.fn();
    const { result, unmount } = renderHook(() => useWebSocket(onMessage));
    const first = MockWebSocket.instances[0];

    act(() => first.open());
    act(() =>
      result.current.sendMessage("chat_message", {
        conversationId: 1,
        content: "retry me",
        clientMsgId: "pending_retry",
      }),
    );
    expect(first.sent).toHaveLength(1);

    act(() => first.close());
    act(() => vi.runOnlyPendingTimers());
    const second = MockWebSocket.instances[1];
    act(() => second.open());

    expect(second.sent).toHaveLength(1);
    expect(JSON.parse(second.sent[0]).data.clientMsgId).toBe("pending_retry");

    act(() =>
      second.receive({
        type: "chat_message",
        data: {
          id: 9,
          conversationId: 1,
          senderId: 2,
          clientMsgId: "pending_retry",
        },
      }),
    );
    act(() => second.close());
    act(() => vi.runOnlyPendingTimers());
    const third = MockWebSocket.instances[2];
    act(() => third.open());

    expect(third.sent).toHaveLength(0);
    expect(onMessage).toHaveBeenCalledTimes(1);
    unmount();
  });
});
