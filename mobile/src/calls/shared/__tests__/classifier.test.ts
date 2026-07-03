import {
  classifyIncomingCall,
  classifyPushCallData,
  classifyPendingRoute,
} from "../classifier";

describe("classifyIncomingCall", () => {
  it("returns null for missing identifiers", () => {
    expect(classifyIncomingCall(null)).toBeNull();
    expect(classifyIncomingCall({})).toBeNull();
    expect(classifyIncomingCall({ callId: 1 })).toBeNull();
    expect(classifyIncomingCall({ conversationId: 2 })).toBeNull();
  });

  it("classifies a plain 1:1 call as p2p", () => {
    const e = classifyIncomingCall({
      callId: 10,
      conversationId: 20,
      callType: "video",
      callerId: 5,
      callerName: "Alice",
      callerAvatar: "/a.png",
    });
    expect(e).toMatchObject({
      kind: "p2p",
      callId: "10",
      conversationId: "20",
      callType: "video",
      peerId: "5",
      peerName: "Alice",
      peerAvatar: "/a.png",
      isGroupConversation: false,
    });
  });

  it("a meetingCode ALWAYS classifies as group — never p2p", () => {
    const e = classifyIncomingCall({
      callId: 10,
      conversationId: 20,
      callType: "voice",
      meetingCode: "abc-123",
      meetingId: 77,
      groupName: "Team",
      callerName: "Bob",
    });
    expect(e?.kind).toBe("group");
    if (e?.kind === "group") {
      expect(e.meetingCode).toBe("abc-123");
      expect(e.meetingId).toBe("77");
      expect(e.groupName).toBe("Team");
    }
  });

  it("an empty meetingCode does NOT classify as group", () => {
    const e = classifyIncomingCall({
      callId: 1,
      conversationId: 2,
      meetingCode: "",
    });
    expect(e?.kind).toBe("p2p");
  });

  it("group event falls back meetingId to callId", () => {
    const e = classifyIncomingCall({
      callId: 42,
      conversationId: 2,
      meetingCode: "xyz",
    });
    expect(e?.kind).toBe("group");
    if (e?.kind === "group") expect(e.meetingId).toBe("42");
  });

  it("recognises group-conversation flags on p2p events", () => {
    for (const isGroup of [true, "1", "true"] as const) {
      const e = classifyIncomingCall({
        callId: 1,
        conversationId: 2,
        isGroup,
      });
      expect(e?.kind).toBe("p2p");
      if (e?.kind === "p2p") expect(e.isGroupConversation).toBe(true);
    }
  });
});

describe("classifyPushCallData", () => {
  it("returns null for non-call payloads", () => {
    expect(classifyPushCallData(null)).toBeNull();
    expect(classifyPushCallData({ messageId: "9" })).toBeNull();
  });

  it("maps senderId to peerId when callerId is absent", () => {
    const e = classifyPushCallData({
      callId: "1",
      conversationId: "2",
      senderId: "33",
    });
    expect(e?.kind).toBe("p2p");
    if (e?.kind === "p2p") expect(e.peerId).toBe("33");
  });

  it("classifies push group calls as group", () => {
    const e = classifyPushCallData({
      callId: "1",
      conversationId: "2",
      meetingCode: "m-1",
    });
    expect(e?.kind).toBe("group");
  });
});

describe("classifyPendingRoute", () => {
  it("routes with meetingCode are group", () => {
    const e = classifyPendingRoute({
      callId: "1",
      conversationId: "2",
      callType: "voice",
      meetingCode: "m-2",
    });
    expect(e.kind).toBe("group");
  });

  it("routes without meetingCode are p2p", () => {
    const e = classifyPendingRoute({
      callId: "1",
      conversationId: "2",
      callType: "video",
      peerId: "9",
      peerName: "Carol",
      isGroup: "1",
    });
    expect(e.kind).toBe("p2p");
    if (e.kind === "p2p") {
      expect(e.peerId).toBe("9");
      expect(e.isGroupConversation).toBe(true);
      expect(e.callType).toBe("video");
    }
  });
});