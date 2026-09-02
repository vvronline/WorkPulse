import { describe, expect, test, vi } from "vitest";
import {
  createPendingMessageId,
  reconcileOwnMessage,
  type ChatMessage,
} from "../pages/chat/messageDelivery";

describe("chat message delivery helpers", () => {
  test("creates collision-safe pending ids", () => {
    const randomUUID = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002");

    const first = createPendingMessageId();
    const second = createPendingMessageId();

    expect(first).toBe("pending_00000000-0000-4000-8000-000000000001");
    expect(second).toBe("pending_00000000-0000-4000-8000-000000000002");
    expect(first).not.toBe(second);
    randomUUID.mockRestore();
  });

  test("replaces the matching optimistic bubble with its server echo", () => {
    const pending: ChatMessage = {
      id: "pending_message-1",
      content: "hello",
    };
    const mapped: ChatMessage = { id: 42, content: "hello" };

    expect(
      reconcileOwnMessage(
        [pending],
        { id: 42, clientMsgId: pending.id, content: "hello" },
        mapped,
      ),
    ).toEqual([mapped]);
  });

  test("removes a pending bubble when the canonical row is already loaded", () => {
    const canonical: ChatMessage = { id: 42, content: "hello" };
    const pending: ChatMessage = {
      id: "pending_message-1",
      content: "hello",
    };

    expect(
      reconcileOwnMessage(
        [canonical, pending],
        { id: 42, clientMsgId: pending.id, content: "hello" },
        canonical,
      ),
    ).toEqual([canonical]);
  });

  test("does not append a duplicate server echo", () => {
    const canonical: ChatMessage = { id: 42, content: "hello" };

    const result = reconcileOwnMessage(
      [canonical],
      { id: 42, clientMsgId: "pending_missing", content: "hello" },
      canonical,
    );

    expect(result).toEqual([canonical]);
  });
});
