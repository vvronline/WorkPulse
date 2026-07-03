import {
  meetingHrefForGroupCall,
  groupRingParams,
  GROUP_RING_PATHNAME,
} from "../navigation";
import type { GroupCallEvent } from "../../shared/classifier";

describe("group-call navigation builders", () => {
  it("builds the huddle auto-join meeting href", () => {
    expect(
      meetingHrefForGroupCall({ meetingCode: "abc-123", callType: "voice" }),
    ).toBe("/meeting/abc-123?huddle=1&callType=voice");
    expect(
      meetingHrefForGroupCall({ meetingCode: "xyz", callType: "video" }),
    ).toBe("/meeting/xyz?huddle=1&callType=video");
  });

  it("builds the full ring-screen params from a GroupCallEvent", () => {
    const event: GroupCallEvent = {
      kind: "group",
      callId: "10",
      conversationId: "20",
      callType: "video",
      meetingCode: "m-1",
      meetingId: "77",
      callerName: "Bob",
      callerAvatar: "/b.png",
      groupName: "Team",
    };
    expect(groupRingParams(event)).toEqual({
      meetingCode: "m-1",
      callId: "10",
      meetingId: "77",
      conversationId: "20",
      callType: "video",
      callerName: "Bob",
      callerAvatar: "/b.png",
      groupName: "Team",
    });
  });

  it("exposes the ring screen pathname", () => {
    expect(GROUP_RING_PATHNAME).toBe("/group-call/ring");
  });
});