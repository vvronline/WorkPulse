/// <reference types="jest" />
/**
 * Unit tests for NativeCallService action mapping, payload storage and the
 * CallKeep listener lifecycle (P1.3).
 *
 * NOTE: the mobile workspace has no jest runner wired up yet (see package.json
 * — there is no `test` script and jest/babel-jest/jest-expo are not installed).
 * These tests are written to be correct and runnable AS-IS the moment a runner
 * is configured (e.g. `jest-expo`). To make that drop-in, every module the
 * service imports is mocked here so requiring `../nativeCallService` never pulls
 * in real native/Expo modules, and each test re-requires a FRESH singleton via
 * `jest.resetModules()` so per-instance state (registered handlers, bound
 * listeners) can never leak between tests.
 */

// ── Mock the full dependency chain of nativeCallService ─────────────────────
// Variables referenced inside a jest.mock factory MUST be prefixed with `mock`
// (jest hoists the factory above imports and only allows such references).
const mockCallKeep = {
  setup: jest.fn().mockResolvedValue(undefined),
  setAvailable: jest.fn(),
  displayIncomingCall: jest.fn(),
  endCall: jest.fn(),
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
};

const mockSocket = {
  waitUntilConnected: jest.fn().mockResolvedValue(true),
  sendCallActionWithRetry: jest.fn().mockResolvedValue(true),
};

const mockBeginCallNavigation = jest.fn().mockReturnValue(true);
const mockIsCallActive = jest.fn().mockReturnValue(false);
const mockSetPendingCall = jest.fn();
const mockPendingCallFromData = jest.fn().mockReturnValue(null);
const mockRejectCallHttp = jest.fn().mockResolvedValue(undefined);
const mockEmitAnswerIntent = jest.fn();

// Force the iOS CallKeep path so resolveCallKeepModule() returns our mock
// (it returns null on Android by design).
jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));

jest.mock(
  "react-native-callkeep",
  () => ({ __esModule: true, default: mockCallKeep }),
  { virtual: true },
);

jest.mock("expo-linking", () => ({
  openURL: jest.fn().mockResolvedValue(undefined),
  createURL: jest.fn((path: string) => path),
}));

jest.mock("../../realtime/socket", () => ({ socket: mockSocket }));

jest.mock("../../realtime/pendingCall", () => ({
  setPendingCall: mockSetPendingCall,
  pendingCallFromData: mockPendingCallFromData,
}));

jest.mock("../../realtime/callRouting", () => ({
  beginCallNavigation: mockBeginCallNavigation,
  isCallActive: mockIsCallActive,
}));

jest.mock("../../features", () => ({ rejectCallHttp: mockRejectCallHttp }));

jest.mock("../../realtime/callAnswerIntent", () => ({
  emitAnswerIntent: mockEmitAnswerIntent,
}));

// Helper: load a FRESH service singleton (module state reset) per test.
type NativeCallServiceModule =
  typeof import("../nativeCallService");
function loadService(): NativeCallServiceModule["nativeCallService"] {
  let svc!: NativeCallServiceModule["nativeCallService"];
  jest.isolateModules(() => {
    svc = require("../nativeCallService").nativeCallService;
  });
  return svc;
}

const flush = () => new Promise<void>((resolve) => setImmediate(() => resolve()));

describe("NativeCallService — action mapping & payload handling", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("registers action handlers via onAction and returns an unsubscribe fn", () => {
    const nativeCallService = loadService();
    const handler = jest.fn();

    const unsubscribe = nativeCallService.onAction(handler);
    expect(typeof unsubscribe).toBe("function");

    unsubscribe();
  });

  test("stores incoming call payload without throwing", async () => {
    const nativeCallService = loadService();

    await expect(
      nativeCallService.reportIncomingCall({
        callId: "123",
        conversationId: "456",
        callType: "voice",
        callerName: "Alice",
      }),
    ).resolves.toBeUndefined();
  });

  test("same callId + conversationId report twice without throwing", async () => {
    const nativeCallService = loadService();

    await nativeCallService.reportIncomingCall({
      callId: "100",
      conversationId: "10",
      callType: "voice",
      callerName: "Bob",
    });
    await nativeCallService.reportIncomingCall({
      callId: "100",
      conversationId: "10",
      callType: "video",
      callerName: "Charlie",
    });
    // No assertion beyond "did not throw" — the deterministic UUID is internal.
  });

  test("converts native action to handler action", async () => {
    const nativeCallService = loadService();

    let capturedAction: string | null = null;
    const handler = jest.fn((params: { action: string }) => {
      capturedAction = params.action;
    });

    nativeCallService.onAction(handler);
    await nativeCallService.handleAction("answer", {
      callId: "200",
      conversationId: "20",
      callType: "voice",
      callerName: "Diana",
    });

    expect(capturedAction).toBe("answer");
  });

  test("handles reject action mapping", async () => {
    const nativeCallService = loadService();

    let capturedAction: string | null = null;
    const handler = jest.fn((params: { action: string }) => {
      capturedAction = params.action;
    });

    nativeCallService.onAction(handler);
    await nativeCallService.handleAction("reject", {
      callId: "300",
      conversationId: "30",
      callType: "voice",
      callerName: "Eve",
    });

    expect(capturedAction).toBe("reject");
  });

  test("passes through callId and conversationId as numbers", async () => {
    const nativeCallService = loadService();

    let capturedParams: { callId: number; conversationId: number } | null = null;
    const handler = jest.fn(
      (params: { callId: number; conversationId: number }) => {
        capturedParams = params;
      },
    );

    nativeCallService.onAction(handler);
    await nativeCallService.handleAction("answer", {
      callId: "400",
      conversationId: "40",
      callType: "voice",
      callerName: "Frank",
    });

    expect(capturedParams).not.toBeNull();
    expect(capturedParams!.callId).toBe(400);
    expect(capturedParams!.conversationId).toBe(40);
  });

  test("ignores invalid payload (missing required fields)", async () => {
    const nativeCallService = loadService();

    const handler = jest.fn();
    nativeCallService.onAction(handler);

    await nativeCallService.handleAction("answer", {
      // missing callId and conversationId
      callerName: "George",
    });

    expect(handler).not.toHaveBeenCalled();
  });

  test("multiple handlers all receive the same action", async () => {
    const nativeCallService = loadService();

    const handler1 = jest.fn();
    const handler2 = jest.fn();

    nativeCallService.onAction(handler1);
    nativeCallService.onAction(handler2);

    await nativeCallService.handleAction("answer", {
      callId: "500",
      conversationId: "50",
      callType: "voice",
      callerName: "Henry",
    });

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  test("unsubscribe removes handler from notifications", async () => {
    const nativeCallService = loadService();

    const handler = jest.fn();
    const unsubscribe = nativeCallService.onAction(handler);

    unsubscribe();
    await nativeCallService.handleAction("answer", {
      callId: "600",
      conversationId: "60",
      callType: "voice",
      callerName: "Iris",
    });

    expect(handler).not.toHaveBeenCalled();
  });

  test("teardown() is exposed and safe to call when never initialized", () => {
    const nativeCallService = loadService();
    expect(typeof nativeCallService.teardown).toBe("function");
    // No throw when called on a fresh / never-initialized service.
    expect(() => nativeCallService.teardown()).not.toThrow();
  });

  test("killed-app reject (no mounted handler) sends a socket action", async () => {
    const nativeCallService = loadService();

    // No onAction handlers registered → simulates the headless/killed state.
    await nativeCallService.handleAction("reject", {
      callId: "700",
      conversationId: "70",
      callType: "voice",
      callerName: "Jack",
    });

    expect(mockSocket.waitUntilConnected).toHaveBeenCalled();
    expect(mockSocket.sendCallActionWithRetry).toHaveBeenCalledWith(
      "reject",
      { callId: 700, conversationId: 70 },
      expect.any(Object),
    );
  });

  test("killed-app reject falls back to HTTP when the socket send fails", async () => {
    mockSocket.waitUntilConnected.mockResolvedValueOnce(true);
    mockSocket.sendCallActionWithRetry.mockResolvedValueOnce(false);
    const nativeCallService = loadService();

    await nativeCallService.handleAction("reject", {
      callId: "800",
      conversationId: "80",
      callType: "voice",
      callerName: "Kim",
    });

    expect(mockRejectCallHttp).toHaveBeenCalledWith(800, 80);
  });

  test("answer EMITS an answer intent (no navigation) when the call screen is already active", async () => {
    // The mounted call screen owns the accept; tapping Answer must NOT navigate
    // again (double-mount crash) — it must emit an intent the screen consumes.
    mockIsCallActive.mockReturnValueOnce(true);
    const nativeCallService = loadService();

    await nativeCallService.handleAction("answer", {
      callId: "900",
      conversationId: "90",
      callType: "voice",
      callerName: "Liam",
    });

    expect(mockEmitAnswerIntent).toHaveBeenCalledWith(900, 90);
    // Must not also claim navigation when the screen is already up.
    expect(mockBeginCallNavigation).not.toHaveBeenCalled();
  });

  test("answer CLAIMS navigation + deep-links when no call screen is active", async () => {
    mockIsCallActive.mockReturnValueOnce(false);
    const nativeCallService = loadService();

    await nativeCallService.handleAction("answer", {
      callId: "910",
      conversationId: "91",
      callType: "voice",
      callerName: "Mia",
    });

    // Warm-app path: claims navigation and does NOT emit a (screen-targeted)
    // answer intent — the freshly-navigated screen auto-answers via autoAnswer.
    expect(mockBeginCallNavigation).toHaveBeenCalledWith(910, 91);
    expect(mockEmitAnswerIntent).not.toHaveBeenCalled();
  });
});

/**
 * P1.3 — iOS CallKeep listener lifecycle. Asserts that re-initializing the
 * service (logout → teardown → login → initialize) does NOT leave two sets of
 * CallKeep event listeners bound, which previously made one native answer/end
 * tap fire the handler twice.
 */
describe("NativeCallService — CallKeep listener teardown (iOS)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("initialize binds answerCall + endCall listeners", async () => {
    const nativeCallService = loadService();

    nativeCallService.initialize();
    await flush();

    expect(mockCallKeep.setup).toHaveBeenCalledTimes(1);
    expect(mockCallKeep.addEventListener).toHaveBeenCalledTimes(2);
    expect(mockCallKeep.addEventListener).toHaveBeenCalledWith(
      "answerCall",
      expect.any(Function),
    );
    expect(mockCallKeep.addEventListener).toHaveBeenCalledWith(
      "endCall",
      expect.any(Function),
    );
  });

  test("teardown removes both bound listeners", async () => {
    const nativeCallService = loadService();

    nativeCallService.initialize();
    await flush();

    nativeCallService.teardown();

    expect(mockCallKeep.removeEventListener).toHaveBeenCalledTimes(2);
    expect(mockCallKeep.removeEventListener).toHaveBeenCalledWith("answerCall");
    expect(mockCallKeep.removeEventListener).toHaveBeenCalledWith("endCall");
    expect(mockCallKeep.setAvailable).toHaveBeenLastCalledWith(false);
  });

  test("re-init after teardown does not double-bind listeners", async () => {
    const nativeCallService = loadService();

    // First login: bind listeners.
    nativeCallService.initialize();
    await flush();
    expect(mockCallKeep.addEventListener).toHaveBeenCalledTimes(2);

    // Logout: teardown removes both listeners.
    nativeCallService.teardown();
    expect(mockCallKeep.removeEventListener).toHaveBeenCalledTimes(2);

    // Second login: re-init binds exactly one fresh set (not stacked).
    mockCallKeep.addEventListener.mockClear();
    nativeCallService.initialize();
    await flush();
    expect(mockCallKeep.addEventListener).toHaveBeenCalledTimes(2);
  });

  test("double initialize() is a no-op (single bind set)", async () => {
    const nativeCallService = loadService();

    nativeCallService.initialize();
    await flush();
    nativeCallService.initialize(); // guarded by `initialized` flag
    await flush();

    expect(mockCallKeep.setup).toHaveBeenCalledTimes(1);
    expect(mockCallKeep.addEventListener).toHaveBeenCalledTimes(2);
  });
});