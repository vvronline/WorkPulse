import { renderHook, act, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

const mockGetActiveCall = vi.fn();
const mockSetChatPageActive = vi.fn();
const mockConsumePendingCall = vi.fn();

const mockGetIceConfig = vi.fn().mockResolvedValue({ data: { iceServers: [] } });

vi.mock("../api", () => ({
    getActiveCall: (...args: any[]) => mockGetActiveCall(...args),
    getIceConfig: (...args: any[]) => mockGetIceConfig(...args),
}));

vi.mock("../CallContext", () => ({
    useGlobalCall: () => ({
        setChatPageActive: mockSetChatPageActive,
        pendingAcceptedCall: null,
        consumePendingCall: mockConsumePendingCall,
    }),
}));

// NOTE (status v2): useCallState no longer imports UserStatusContext.
// Server handles per-session in_call activity automatically.

import useCallState from "../pages/chat/useCallState";
import useWebRTC from "../components/chat/call/useWebRTC";
import { ToastProvider } from "../components/common/Toast";

// useCallState now surfaces a toast (e.g. the P0.3 "‹name› is on another call"
// busy notice) via useToast(), which throws unless a ToastProvider is mounted.
// Wrap every render in both the router and the toast provider so the hook has
// the context it needs.
const routerWrapper = ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter>
        <ToastProvider>{children}</ToastProvider>
    </MemoryRouter>
);

describe("call signaling races", () => {
    beforeEach(() => {
        mockGetActiveCall.mockReset();
        mockGetActiveCall.mockResolvedValue({ data: null });
        mockSetChatPageActive.mockReset();
        mockConsumePendingCall.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete (globalThis as any).RTCPeerConnection;
        delete (globalThis as any).RTCSessionDescription;
        delete (globalThis as any).RTCIceCandidate;
    });

    test("queues call signals until the chat call handler is attached", () => {
        const wsSendRef = { current: vi.fn() };
        const { result } = renderHook(() => useCallState(wsSendRef as any), { wrapper: routerWrapper });

        const queuedSignal = { type: "offer", sdp: "queued-offer" };

        act(() => {
            (result.current as any).handleCallWsEvent("call_signal", {
                signal: queuedSignal,
                fromUserId: 17,
            });
        });

        expect((result.current as any).callSignalRef.pendingSignalsRef.current).toEqual([
            { signal: queuedSignal, fromUserId: 17 },
        ]);
    });

    test("buffers ICE candidates that arrive before remote description is set", async () => {
        const addIceCandidate = vi.fn().mockResolvedValue(undefined);
        const setRemoteDescription = vi.fn(async (desc: any) => {
            fakePc.remoteDescription = desc;
            fakePc.signalingState = "stable";
        });
        const setLocalDescription = vi.fn(async (desc: any) => {
            fakePc.localDescription = desc;
        });

        const fakePc: any = {
            remoteDescription: null,
            localDescription: null,
            signalingState: "stable",
            addTrack: vi.fn(),
            getTransceivers: vi.fn().mockReturnValue([]),
            createOffer: vi.fn().mockResolvedValue({ type: "offer", sdp: "offer-sdp" }),
            createAnswer: vi.fn().mockResolvedValue({ type: "answer", sdp: "answer-sdp" }),
            setLocalDescription,
            setRemoteDescription,
            addIceCandidate,
            close: vi.fn(),
        };

        (globalThis as any).RTCPeerConnection = function RTCPeerConnection() {
            return fakePc;
        };
        (globalThis as any).RTCSessionDescription = function RTCSessionDescription(this: any, desc: any) {
            Object.assign(this, desc);
        };
        (globalThis as any).RTCIceCandidate = function RTCIceCandidate(this: any, candidate: any) {
            Object.assign(this, candidate);
        };

        const wsSend = vi.fn();
        const onSignal: { current: any } = { current: null };
        const localStream = { getTracks: () => [] };

        renderHook(() =>
            useWebRTC({
                callState: {
                    callId: 1,
                    conversationId: 55,
                    isIncoming: false,
                    callerId: 2,
                    acceptedBy: null,
                    accepted: false,
                    onSignal,
                    onEndExternal: { current: null },
                    localStream,
                    isReconnect: false,
                    reconnectTo: null,
                },
                callType: "voice",
                wsSend,
                onEnd: vi.fn(),
                onStatusChange: vi.fn(),
            } as any)
        );

        await waitFor(() => {
            expect(onSignal.current).toEqual(expect.any(Function));
        });

        act(() => {
            onSignal.current({ type: "ice-candidate", candidate: { candidate: "early-candidate" } }, 9);
            onSignal.current({ type: "offer", sdp: "offer-sdp", signalId: "offer-1" }, 9);
            onSignal.current({ type: "offer", sdp: "offer-sdp", signalId: "offer-1" }, 9);
        });

        await waitFor(() => {
            expect(addIceCandidate).toHaveBeenCalledWith({ candidate: "early-candidate" });
        });

        expect(wsSend).toHaveBeenCalledWith("call_signal", {
            callId: 1,
            conversationId: 55,
            targetUserId: 9,
            signal: { type: "answer", sdp: "answer-sdp" },
        });
        expect(fakePc.createAnswer).toHaveBeenCalledTimes(1);
    });
});