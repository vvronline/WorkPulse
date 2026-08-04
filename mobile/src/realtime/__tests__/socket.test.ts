/**
 * Regression tests for the RealtimeSocket open() race.
 *
 * `open()` awaits `getToken()` (a native keychain read) before constructing the
 * WebSocket, so the `isSocketLive()` guard at the top of the old implementation
 * was STALE by the time `this.ws = ws` ran. Concurrent callers — connect(), the
 * AppState "active" handler, waitUntilConnected(), and the two un-awaited
 * `this.open()` calls inside sendWithBackoff() — could therefore each build
 * their own socket. The loser was overwritten without being closed and leaked
 * (its onclose hits the `this.ws !== ws` guard, so it never reconnects either),
 * while both remained subscribed => duplicate realtime messages.
 *
 * These tests pin the fix: N concurrent connects must create exactly ONE socket.
 */

jest.mock("../../auth/tokenStore", () => ({
  // Resolve on a later microtask tick so concurrent callers are guaranteed to
  // interleave across the await — this is what reproduced the original bug.
  getToken: jest.fn(
    () => new Promise((resolve) => setTimeout(() => resolve("test-jwt"), 5)),
  ),
}));

jest.mock("../../config", () => ({
  wsUrl: (token: string) => `wss://example.test/ws?token=${token}`,
}));

jest.mock("react-native", () => ({
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));

/** Minimal WebSocket double that records every instance constructed. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;

  readyState = 0; // CONNECTING
  closed = false;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  /** Simulate the server completing the handshake. */
  flushOpen() {
    this.readyState = 1;
    this.onopen?.();
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }
}

describe("RealtimeSocket open() race", () => {
  let socket: typeof import("../socket").socket;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    FakeWebSocket.instances = [];
    (global as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    socket = require("../socket").socket;
  });

  afterEach(() => {
    socket.disconnect();
    jest.useRealTimers();
  });

  it("creates exactly one WebSocket when connect() is called concurrently", async () => {
    // Five callers race through the `await getToken()` window simultaneously.
    const pending = Promise.all([
      socket.connect(),
      socket.connect(),
      socket.connect(),
      socket.connect(),
      socket.connect(),
    ]);

    await jest.advanceTimersByTimeAsync(20);
    await pending;

    // Pre-fix this was 5 sockets (4 of them leaked + double-delivering).
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("does not open a second socket once one is already live", async () => {
    const first = socket.connect();
    await jest.advanceTimersByTimeAsync(20);
    await first;

    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.instances[0].flushOpen();

    const second = socket.connect();
    await jest.advanceTimersByTimeAsync(20);
    await second;

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("delivers each message to a subscriber exactly once", async () => {
    const received: unknown[] = [];
    socket.subscribe((msg) => received.push(msg));

    // Concurrent connects: with the pre-fix duplicate sockets, BOTH would have
    // been wired to the same listener set and each inbound frame counted twice.
    const pending = Promise.all([socket.connect(), socket.connect()]);
    await jest.advanceTimersByTimeAsync(20);
    await pending;

    const live = FakeWebSocket.instances[0];
    live.flushOpen();
    live.onmessage?.({ data: JSON.stringify({ type: "chat", data: { id: 1 } }) });

    expect(received).toEqual([{ type: "chat", data: { id: 1 } }]);
  });

  it("closes the socket and stops reconnecting on disconnect()", async () => {
    const pending = socket.connect();
    await jest.advanceTimersByTimeAsync(20);
    await pending;

    const live = FakeWebSocket.instances[0];
    live.flushOpen();

    socket.disconnect();

    expect(live.closed).toBe(true);
    // A reconnect must NOT be scheduled after an explicit disconnect (logout).
    await jest.advanceTimersByTimeAsync(30_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("ignores an in-flight open that resolves after disconnect()", async () => {
    // Start connecting, then log out DURING the keychain read.
    void socket.connect();
    socket.disconnect();

    await jest.advanceTimersByTimeAsync(50);

    // The pending doOpen() must bail on its post-await shouldRun re-check
    // rather than resurrecting a socket for a signed-out user.
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});
