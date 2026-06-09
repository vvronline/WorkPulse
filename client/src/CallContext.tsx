import {
    createContext,
    useContext,
    useState,
    useRef,
    useCallback,
    useEffect,
    useMemo,
    type ReactNode,
} from "react";
import { useAuth } from "./AuthContext";
import useWebSocket, { type WebSocketMessage } from "./hooks/useWebSocket";

interface IncomingCall {
    callId: string | number;
    conversationId: string | number;
    callType?: string;
    callerId?: string | number;
    callerName?: string;
    callerAvatar?: string;
    isGroup?: boolean;
    groupName?: string;
    [key: string]: unknown;
}

interface CallContextValue {
    globalIncomingCall: IncomingCall | null;
    acceptGlobalCall: () => void;
    rejectGlobalCall: () => void;
    setChatPageActive: (active: boolean) => void;
    pendingAcceptedCall: IncomingCall | null;
    consumePendingCall: () => IncomingCall | null;
}

const CallCtx = createContext<CallContextValue>({
    globalIncomingCall: null,
    acceptGlobalCall: () => {},
    rejectGlobalCall: () => {},
    setChatPageActive: () => {},
    pendingAcceptedCall: null,
    consumePendingCall: () => null,
});

export function CallProvider({ children }: { children: ReactNode }) {
    const { isAuthenticated } = useAuth();
    const [globalIncomingCall, setGlobalIncomingCall] =
        useState<IncomingCall | null>(null);
    const [pendingAcceptedCall, setPendingAcceptedCall] =
        useState<IncomingCall | null>(null);
    const chatPageActiveRef = useRef(false);
    const callActiveRef = useRef(false);

    useEffect(() => {
        callActiveRef.current = !!globalIncomingCall;
    }, [globalIncomingCall]);

    const setChatPageActive = useCallback((active: boolean) => {
        chatPageActiveRef.current = active;
        // NOTE: previously we cleared `globalIncomingCall` whenever the user
        // landed on /chat because Chat.jsx had its own incoming-call UI. That
        // behaviour caused the bug where the floating PiP disappeared the moment
        // the chat page mounted, and Chat.jsx then re-rendered a *second*
        // incoming screen. We now keep the PiP visible everywhere (including
        // /chat) and Chat.jsx no longer shows an incoming overlay of its own.
    }, []);

    const onWsMessage = useCallback((msg: WebSocketMessage) => {
        // Relay meeting_started to GlobalMeetingNotification via DOM event.
        // This provides a reliable delivery path since CallContext's WS is
        // always connected when the user is authenticated.
        if (msg.type === "meeting_started" && msg.data) {
            window.dispatchEvent(
                new CustomEvent("meeting_started", { detail: msg.data }),
            );
        }

        // Always handle incoming-call events through the global PiP — even when
        // the user is already on /chat. This avoids the previous situation where
        // both the floating PiP AND the full-screen CallOverlay's "incoming"
        // screen appeared at once, and where accepting in the PiP then dropped
        // the user into another "incoming" screen requiring a second tap.
        const d = (msg.data || {}) as IncomingCall;
        switch (msg.type) {
            case "call_incoming": {
                if (!callActiveRef.current) {
                    setGlobalIncomingCall({
                        callId: d.callId,
                        conversationId: d.conversationId,
                        callType: d.callType,
                        callerId: d.callerId,
                        callerName: d.callerName,
                        callerAvatar: d.callerAvatar,
                        isGroup: d.isGroup,
                        groupName: d.groupName,
                    });
                }
                break;
            }
            case "call_rejected":
            case "call_ended": {
                setGlobalIncomingCall(null);
                break;
            }
            case "call_handled_elsewhere": {
                // Server tells *every* session belonging to the current user that an
                // incoming call has been accepted or rejected on one of their
                // devices. Dismiss the floating PiP here so the other devices stop
                // ringing. The session that actually accepted/rejected has already
                // cleared its own PiP locally before sending; receiving this echo
                // is harmless (setGlobalIncomingCall(null) is idempotent) and
                // ensures multi-device users don't see duplicate ring UIs.
                setGlobalIncomingCall((prev) => {
                    if (!prev) return prev;
                    // Only dismiss if it matches the same callId — defensive against
                    // races where a new incoming call arrives just after this echo.
                    if (d?.callId && prev.callId !== d.callId) return prev;
                    return null;
                });
                // Drop any pending-accepted call too, in case the user tapped
                // "accept" on device A while device B was mid-navigation: device B
                // must NOT then try to join the call.
                setPendingAcceptedCall((prev) => {
                    if (!prev) return prev;
                    if (d?.callId && prev.callId !== d.callId) return prev;
                    return null;
                });
                break;
            }
            default:
                break;
        }
    }, []);

    const { sendMessage: wsSend } = useWebSocket(
        isAuthenticated ? onWsMessage : null,
    );

    const rejectGlobalCall = useCallback(() => {
        if (globalIncomingCall) {
            wsSend("call_reject", {
                callId: globalIncomingCall.callId,
                conversationId: globalIncomingCall.conversationId,
            });
            setGlobalIncomingCall(null);
        }
    }, [globalIncomingCall, wsSend]);

    const acceptGlobalCall = useCallback(() => {
        if (globalIncomingCall) {
            // Store the call data so the Chat page can pick it up after navigation
            setPendingAcceptedCall({ ...globalIncomingCall });
            setGlobalIncomingCall(null);
        }
    }, [globalIncomingCall]);

    const consumePendingCall = useCallback(() => {
        const call = pendingAcceptedCall;
        setPendingAcceptedCall(null);
        return call;
    }, [pendingAcceptedCall]);

    const value = useMemo(
        () => ({
            globalIncomingCall,
            acceptGlobalCall,
            rejectGlobalCall,
            setChatPageActive,
            pendingAcceptedCall,
            consumePendingCall,
        }),
        [
            globalIncomingCall,
            acceptGlobalCall,
            rejectGlobalCall,
            setChatPageActive,
            pendingAcceptedCall,
            consumePendingCall,
        ],
    );

    return <CallCtx.Provider value={value}>{children}</CallCtx.Provider>;
}

export const useGlobalCall = () => useContext(CallCtx);