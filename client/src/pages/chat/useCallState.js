import { useState, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useGlobalCall } from '../../CallContext';
import { getActiveCall } from '../../api';
import { useUserStatus } from '../../UserStatusContext';

export default function useCallState(wsSendRef) {
    const { setChatPageActive, pendingAcceptedCall, consumePendingCall } = useGlobalCall();
    const { setAutoStatus, clearAutoStatus } = useUserStatus();
    const { pathname } = useLocation();
    const isChatPage = pathname === '/chat';
    const statusSetRef = useRef(false);

    const [callState, setCallState] = useState(null);
    const callSignalRef = useRef(null);
    const callEndRef = useRef(null);
    const callActiveRef = useRef(false);
    const pendingCallSignalsRef = useRef([]);

    callSignalRef.pendingSignalsRef = pendingCallSignalsRef;

    // Persist active call metadata in sessionStorage + manage auto-status
    useEffect(() => {
        callActiveRef.current = !!callState;
        if (callState && callState.callId) {
            // Set auto-status to "in_call" when call is accepted or outgoing (only once)
            if ((callState.accepted || !callState.isIncoming) && !statusSetRef.current) {
                statusSetRef.current = true;
                setAutoStatus('in_call');
            }
            try {
                sessionStorage.setItem('wp_active_call', JSON.stringify({
                    callId: callState.callId,
                    conversationId: callState.conversationId,
                    callType: callState.callType,
                    remoteName: callState.remoteName,
                    remoteAvatar: callState.remoteAvatar,
                    isGroup: callState.isGroup,
                    callerId: callState.callerId,
                    isIncoming: callState.isIncoming,
                }));
            } catch { /* ignore */ }
        } else if (!callState) {
            if (statusSetRef.current) {
                statusSetRef.current = false;
                clearAutoStatus('in_call');
            }
            pendingCallSignalsRef.current = [];
            try { sessionStorage.removeItem('wp_active_call'); } catch { /* ignore */ }
        }
    }, [callState]);

    // Register chat page as active for CallContext only when actually visible
    useEffect(() => {
        setChatPageActive(isChatPage);
    }, [isChatPage, setChatPageActive]);

    // Pick up a pending accepted call from global notification
    useEffect(() => {
        if (pendingAcceptedCall) {
            const call = consumePendingCall();
            if (call && !callActiveRef.current) {
                setCallState({
                    callId: call.callId,
                    conversationId: call.conversationId,
                    callType: call.callType,
                    isIncoming: true,
                    callerId: call.callerId,
                    remoteName: call.callerName,
                    remoteAvatar: call.callerAvatar,
                    isGroup: call.isGroup,
                    accepted: false,
                    acceptedBy: null,
                    onSignal: callSignalRef,
                    onEndExternal: callEndRef
                });
            }
        }
    }, [pendingAcceptedCall]); // eslint-disable-line react-hooks/exhaustive-deps

    // Restore active call after page refresh
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const saved = sessionStorage.getItem('wp_active_call');
                if (!saved) return;
                const callData = JSON.parse(saved);
                if (!callData?.callId) return;
                const { data: activeCall } = await getActiveCall();
                if (cancelled || !activeCall || activeCall.id !== callData.callId) {
                    sessionStorage.removeItem('wp_active_call');
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
                    onSignal: callSignalRef,
                    onEndExternal: callEndRef,
                    isReconnect: true,
                });
                if (wsSendRef.current) {
                    wsSendRef.current('call_reconnect', { callId: callData.callId, conversationId: callData.conversationId });
                }
            } catch { /* ignore — no active call */ }
        })();
        return () => { cancelled = true; };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Handle WS call events
    const handleCallWsEvent = (type, data) => {
        switch (type) {
            case 'call_incoming': {
                if (!callActiveRef.current) {
                    setCallState({
                        callId: data.callId,
                        conversationId: data.conversationId,
                        callType: data.callType,
                        isIncoming: true,
                        callerId: data.callerId,
                        remoteName: data.callerName,
                        remoteAvatar: data.callerAvatar,
                        isGroup: data.isGroup,
                        accepted: false,
                        acceptedBy: null,
                        onSignal: callSignalRef,
                        onEndExternal: callEndRef
                    });
                    // Desktop: flash taskbar + bring to front
                    if (window.electronAPI?.isElectron) {
                        window.electronAPI.flashFrame(true);
                        window.electronAPI.showAndFocus();
                    }
                    // Web: browser notification when not focused
                    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && !document.hasFocus()) {
                        try {
                            const callLabel = data.callType === 'video' ? 'Video Call' : 'Voice Call';
                            const displayName = data.callerName || 'Unknown';
                            const n = new Notification(`Incoming ${callLabel}`, {
                                body: `${displayName} is calling...`,
                                tag: 'workpulse-incoming-call',
                                icon: '/icon-192.svg',
                                requireInteraction: true,
                            });
                            n.onclick = () => { window.focus(); n.close(); };
                        } catch { /* ignore */ }
                    }
                }
                break;
            }
            case 'call_started': {
                setCallState(prev => prev ? { ...prev, callId: data.callId } : prev);
                break;
            }
            case 'call_accepted': {
                console.log('[call-state] call_accepted by:', data.userId);
                if (window.electronAPI?.flashFrame) window.electronAPI.flashFrame(false);
                setCallState(prev => prev ? { ...prev, accepted: true, acceptedBy: data.userId } : prev);
                break;
            }
            case 'call_rejected': {
                if (window.electronAPI?.flashFrame) window.electronAPI.flashFrame(false);
                if (callEndRef.current) callEndRef.current();
                else setCallState(null);
                break;
            }
            case 'call_ended': {
                if (window.electronAPI?.flashFrame) window.electronAPI.flashFrame(false);
                if (callEndRef.current) callEndRef.current();
                else setCallState(null);
                break;
            }
            case 'call_signal': {
                console.log('[call-state] received call_signal, type:', data.signal?.type, 'from:', data.fromUserId, 'hasHandler:', !!callSignalRef.current);
                if (callSignalRef.current) {
                    callSignalRef.current(data.signal, data.fromUserId);
                } else {
                    console.log('[call-state] queuing signal (no handler yet)');
                    pendingCallSignalsRef.current.push({ signal: data.signal, fromUserId: data.fromUserId });
                }
                break;
            }
            case 'call_reconnect': {
                setCallState(prev => prev ? { ...prev, reconnectTo: data.userId } : prev);
                break;
            }
            default: break;
        }
    };

    return {
        callState, setCallState,
        callSignalRef, callEndRef, callActiveRef,
        handleCallWsEvent,
    };
}
