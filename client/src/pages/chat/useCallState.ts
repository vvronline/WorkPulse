import { useState, useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { useGlobalCall } from "../../CallContext";
import { getActiveCall } from "../../api";
// NOTE (status v2): client no longer broadcasts auto-status for calls.
// The server sets/clears per-session `in_call` activity on
// `call_initiate` / `call_accept` / `call_end` (see server/utils/ws.js).

export interface CallState {
    callId?: number | string;
    conversationId?: number | string;
    callType?: string;
    isIncoming?: boolean;
    callerId?: number | string;
    remoteName?: string;
    remoteAvatar?: string | null;
    isGroup?: boolean;
    accepted?: boolean;
    acceptedBy?: number | string | null;
    preAccepted?: boolean;
    isReconnect?: boolean;
    reconnectTo?: number | string;
    onSignal?: React.MutableRefObject<unknown>;
    onEndExternal?: React.MutableRefObject<unknown>;
    [key: string]: unknown;
}

type WsSendRef = React.MutableRefObject<
    ((type: string, data?: unknown) => void) | null
>;

export default function useCallState(wsSendRef: WsSendRef) {
    const { setChatPageActive, pendingAcceptedCall, consumePendingCall } =
        useGlobalCall();
    const { pathname } = useLocation();
    const isChatPage = pathname === "/chat";

    const [callState, setCallState] = useState<CallState | null>(null);
    const callSignalRef = useRef<
        ((signal: unknown, fromUserId: number | string) => void) | null
    >(null);
    const callEndRef = useRef<(() => void) | null>(null);
    const callReactionRef = useRef<
        ((emoji: string, fromUserId: number | string) => void) | null
    >(null);
    const callActiveRef = useRef(false);
    const pendingCallSignalsRef = useRef<
        { signal: unknown; fromUserId: number | string }[]
    >([]);

    (callSignalRef as unknown as Record<string, unknown>).pendingSignalsRef =
        pendingCallSignalsRef;

    // Persist active call metadata in sessionStorage + manage auto-status
    useEffect(() => {
        callActiveRef.current = !!callState;
        if (callState && callState.callId) {
            try {
                sessionStorage.setItem(
                    "wp_active_call",
                    JSON.stringify({
                        callId: callState.callId,
                        conversationId: callState.conversationId,
                        callType: callState.callType,
                        remoteName: callState.remoteName,
                        remoteAvatar: callState.remoteAvatar,
                        isGroup: callState.isGroup,
                        callerId: callState.callerId,
                        isIncoming: callState.isIncoming,
                    }),
                );
            } catch {
                /* ignore */
            }
        } else if (!callState) {
            pendingCallSignalsRef.current = [];
            try {
                sessionStorage.removeItem("wp_active_call");
            } catch {
                /* ignore */
            }
        }
    }, [callState]);

    // Register chat page as active for CallContext only when actually visible
    useEffect(() => {
        setChatPageActive(isChatPage);
    }, [isChatPage, setChatPageActive]);

    // Pick up a pending accepted call from global notification
    useEffect(() => {
        if (pendingAcceptedCall) {
            const call = consumePendingCall() as Record<string, unknown> | null;
            if (call && !callActiveRef.current) {
                setCallState({
                    callId: call.callId as number | string,
                    conversationId: call.conversationId as number | string,
                    callType: call.callType as string,
                    isIncoming: true,
                    callerId: call.callerId as number | string,
                    remoteName: call.callerName as string,
                    remoteAvatar: call.callerAvatar as string | null,
                    isGroup: call.isGroup as boolean,
                    accepted: false,
                    acceptedBy: null,
                    preAccepted: true,
                    onSignal: callSignalRef as React.MutableRefObject<unknown>,
                    onEndExternal:
                        callEndRef as React.MutableRefObject<unknown>,
                });
            }
        }
    }, [pendingAcceptedCall]); // eslint-disable-line react-hooks/exhaustive-deps

    // Restore active call after page refresh
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const saved = sessionStorage.getItem("wp_active_call");
                if (!saved) return;
                const callData = JSON.parse(saved);
                if (!callData?.callId) return;
                const { data: activeCall } = await getActiveCall();
                if (
                    cancelled ||
                    !activeCall ||
                    (activeCall as { id?: number | string }).id !==
                        callData.callId
                ) {
                    sessionStorage.removeItem("wp_active_call");
                    return;
                }
                setCallState({
                    callId: callData.callId,
                    conversationId: callData.conversationId,
                    callType: callData.callType,
                    isIncoming: callData.isIncoming,
                    callerId: callData.callerId,
                    remoteName: callData.remoteName,
                    remoteAvatar: callData.remoteAvatar,
                    isGroup: callData.isGroup,
                    accepted: true,
                    acceptedBy: null,
                    onSignal: callSignalRef as React.MutableRefObject<unknown>,
                    onEndExternal:
                        callEndRef as React.MutableRefObject<unknown>,
                    isReconnect: true,
                });
                if (wsSendRef.current) {
                    wsSendRef.current("call_reconnect", {
                        callId: callData.callId,
                        conversationId: callData.conversationId,
                    });
                }
            } catch {
                /* ignore — no active call */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Handle WS call events
    const handleCallWsEvent = (type: string, data: AnyCallData) => {
        switch (type) {
            case "call_incoming": {
                // Intentionally ignored here. The global PiP notification
                // (GlobalIncomingCall) — driven by CallContext — is now the
                // single source of truth for incoming-call UI on every page,
                // including /chat. When the user clicks "Accept" in the PiP
                // we receive the call via `pendingAcceptedCall` (see effect
                // above) and create the local callState with `preAccepted`,
                // which lets CallOverlay skip its second "incoming" screen
                // and go straight to "connecting".
                break;
            }
            case "call_started": {
                setCallState((prev) =>
                    prev ? { ...prev, callId: data.callId } : prev,
                );
                break;
            }
            case "call_accepted": {
                console.log("[call-state] call_accepted by:", data.userId);
                if (window.electronAPI?.flashFrame)
                    window.electronAPI.flashFrame(false);
                setCallState((prev) =>
                    prev
                        ? { ...prev, accepted: true, acceptedBy: data.userId }
                        : prev,
                );
                break;
            }
            case "call_rejected": {
                if (window.electronAPI?.flashFrame)
                    window.electronAPI.flashFrame(false);
                if (callEndRef.current) callEndRef.current();
                else setCallState(null);
                break;
            }
            case "call_ended": {
                if (window.electronAPI?.flashFrame)
                    window.electronAPI.flashFrame(false);
                if (callEndRef.current) callEndRef.current();
                else setCallState(null);
                break;
            }
            case "call_signal": {
                console.log(
                    "[call-state] received call_signal, type:",
                    (data.signal as { type?: string })?.type,
                    "from:",
                    data.fromUserId,
                    "hasHandler:",
                    !!callSignalRef.current,
                );
                if (callSignalRef.current) {
                    callSignalRef.current(
                        data.signal,
                        data.fromUserId as number | string,
                    );
                } else {
                    console.log("[call-state] queuing signal (no handler yet)");
                    pendingCallSignalsRef.current.push({
                        signal: data.signal,
                        fromUserId: data.fromUserId as number | string,
                    });
                }
                break;
            }
            case "call_reconnect": {
                setCallState((prev) =>
                    prev ? { ...prev, reconnectTo: data.userId } : prev,
                );
                break;
            }
            case "call_reaction": {
                if (callReactionRef.current) {
                    callReactionRef.current(
                        data.emoji as string,
                        data.fromUserId as number | string,
                    );
                }
                break;
            }
            default:
                break;
        }
    };

    return {
        callState,
        setCallState,
        callSignalRef,
        callEndRef,
        callReactionRef,
        callActiveRef,
        handleCallWsEvent,
    };
}

interface AnyCallData {
    callId?: number | string;
    userId?: number | string;
    fromUserId?: number | string;
    signal?: unknown;
    emoji?: string;
    [key: string]: unknown;
}