import { beforeEach, describe, expect, it } from "vitest";
import {
  getHiddenMessageIds,
  hideMessagesForMe,
  isBeforeClearedAt,
  isMessageHiddenForMe,
  setClearedAt,
} from "../pages/chat/chatLocalDeletes";

describe("chat local deletion state", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("persists individual messages hidden only for the current device", () => {
    hideMessagesForMe(12, [4, "5"]);
    hideMessagesForMe(12, [5, 6]);

    expect([...getHiddenMessageIds(12)]).toEqual(["4", "5", "6"]);
    expect(isMessageHiddenForMe(12, 4)).toBe(true);
    expect(isMessageHiddenForMe(12, "5")).toBe(true);
    expect(isMessageHiddenForMe(12, 7)).toBe(false);
    expect(isMessageHiddenForMe(13, 4)).toBe(false);
  });

  it("keeps clear-chat cutoff behavior independent from hidden IDs", () => {
    setClearedAt(8, "2026-09-02T10:00:00.000Z");
    hideMessagesForMe(8, [99]);

    expect(isBeforeClearedAt(8, "2026-09-02T09:59:59.000Z")).toBe(true);
    expect(isBeforeClearedAt(8, "2026-09-02T10:00:01.000Z")).toBe(false);
    expect(isMessageHiddenForMe(8, 99)).toBe(true);
  });

  it("recovers safely from malformed storage", () => {
    localStorage.setItem("chat:hidden-messages:3", "{broken");

    expect(getHiddenMessageIds(3).size).toBe(0);
    expect(isMessageHiddenForMe(3, 1)).toBe(false);
  });
});
