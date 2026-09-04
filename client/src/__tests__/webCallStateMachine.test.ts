import { describe, it, expect, vi } from "vitest";
import {
  createCallStateMachine,
  createSerialQueue,
  initialWebCallPhase,
  isTerminalPhase,
  webCallReducer,
  type WebCallEvent,
  type WebCallPhase,
} from "../components/chat/call/media/callStateMachine";

const drive = (start: WebCallPhase, events: WebCallEvent[]) =>
  events.reduce(webCallReducer, start);

describe("initialWebCallPhase", () => {
  it("maps the overlay's entry conditions", () => {
    expect(initialWebCallPhase({ isReconnect: true, isIncoming: true })).toBe(
      "reconnecting",
    );
    expect(initialWebCallPhase({ isPreAccepted: true, isIncoming: true })).toBe(
      "connecting",
    );
    expect(initialWebCallPhase({ isIncoming: true })).toBe("incoming");
    expect(initialWebCallPhase({})).toBe("ringing");
  });
});

describe("webCallReducer", () => {
  it("walks the happy path", () => {
    expect(
      drive("incoming", [{ type: "LOCAL_ACCEPT" }, { type: "MEDIA_CONNECTED" }]),
    ).toBe("connected");
    expect(
      drive("ringing", [{ type: "PEER_ACCEPTED" }, { type: "MEDIA_CONNECTED" }]),
    ).toBe("connected");
  });

  it("treats a media drop as reconnecting, never as ended", () => {
    expect(drive("connected", [{ type: "MEDIA_DISCONNECTED" }])).toBe("reconnecting");
    expect(drive("connected", [{ type: "MEDIA_RECONNECTING" }])).toBe("reconnecting");
    expect(
      drive("connected", [{ type: "MEDIA_DISCONNECTED" }, { type: "MEDIA_CONNECTED" }]),
    ).toBe("connected");
  });

  it("does not invent a reconnect for a call that never had media", () => {
    expect(drive("ringing", [{ type: "MEDIA_DISCONNECTED" }])).toBe("ringing");
    expect(drive("connecting", [{ type: "MEDIA_RECONNECTING" }])).toBe("connecting");
  });

  it("absorbs every event once terminal", () => {
    const terminals: WebCallEvent[] = [
      { type: "LOCAL_END" },
      { type: "LOCAL_REJECT" },
      { type: "REMOTE_ENDED" },
      { type: "REMOTE_REJECTED" },
      { type: "REMOTE_BUSY" },
      { type: "RING_TIMEOUT" },
    ];
    const revivals: WebCallEvent[] = [
      { type: "MEDIA_CONNECTED" },
      { type: "MEDIA_RECONNECTING" },
      { type: "MEDIA_DISCONNECTED" },
      { type: "PEER_ACCEPTED" },
      { type: "LOCAL_ACCEPT" },
      { type: "PEER_RECONNECT" },
    ];
    for (const terminal of terminals) {
      const dead = webCallReducer("connected", terminal);
      expect(isTerminalPhase(dead)).toBe(true);
      for (const revival of revivals) {
        expect(webCallReducer(dead, revival)).toBe(dead);
      }
    }
  });

  it("keeps reject and end distinguishable", () => {
    expect(webCallReducer("incoming", { type: "LOCAL_REJECT" })).toBe("rejected");
    expect(webCallReducer("incoming", { type: "REMOTE_REJECTED" })).toBe("rejected");
    expect(webCallReducer("connected", { type: "REMOTE_ENDED" })).toBe("ended");
  });
});

describe("createCallStateMachine", () => {
  it("notifies subscribers only on real transitions", () => {
    const machine = createCallStateMachine("ringing");
    const seen: WebCallPhase[] = [];
    machine.subscribe((phase) => seen.push(phase));

    machine.dispatch({ type: "MEDIA_DISCONNECTED" }); // no-op while ringing
    machine.dispatch({ type: "PEER_ACCEPTED" });
    machine.dispatch({ type: "PEER_ACCEPTED" }); // already connecting
    machine.dispatch({ type: "MEDIA_CONNECTED" });

    expect(seen).toEqual(["connecting", "connected"]);
    expect(machine.isTerminal()).toBe(false);
  });

  it("cannot be revived by a late Room callback after a local hang-up", () => {
    const machine = createCallStateMachine("connected");
    machine.dispatch({ type: "LOCAL_END" });
    expect(machine.getPhase()).toBe("ended");
    expect(machine.isTerminal()).toBe(true);

    // Late `RoomEvent.Connected` / `Reconnected` arriving after teardown.
    machine.dispatch({ type: "MEDIA_CONNECTED" });
    machine.dispatch({ type: "MEDIA_RECONNECTING" });
    expect(machine.getPhase()).toBe("ended");
  });

  it("survives a throwing subscriber", () => {
    const machine = createCallStateMachine("ringing");
    machine.subscribe(() => {
      throw new Error("bad subscriber");
    });
    expect(() => machine.dispatch({ type: "PEER_ACCEPTED" })).not.toThrow();
    expect(machine.getPhase()).toBe("connecting");
  });
});

describe("createSerialQueue", () => {
  it("runs tasks strictly in order even when they await", async () => {
    const queue = createSerialQueue();
    const order: string[] = [];

    void queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("slow-media-event");
    });
    void queue.enqueue(() => {
      order.push("call_ended");
    });
    await queue.enqueue(() => {
      order.push("teardown");
    });

    expect(order).toEqual(["slow-media-event", "call_ended", "teardown"]);
  });

  it("keeps draining after a task throws", async () => {
    const onError = vi.fn();
    const queue = createSerialQueue(onError);
    void queue.enqueue(() => {
      throw new Error("boom");
    });
    const after = vi.fn();
    await queue.enqueue(after);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("serializes a media event racing the terminal transition", async () => {
    const machine = createCallStateMachine("connected");
    const queue = createSerialQueue();

    void queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 5));
      machine.dispatch({ type: "REMOTE_ENDED" });
    });
    await queue.enqueue(() => {
      machine.dispatch({ type: "MEDIA_CONNECTED" });
    });

    expect(machine.getPhase()).toBe("ended");
  });
});
