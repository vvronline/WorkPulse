import { createContext, useContext, useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useAuth } from './AuthContext';
import useWebSocket from './hooks/useWebSocket';

const CallCtx = createContext({
  globalIncomingCall: null,
  acceptGlobalCall: () => {},
  rejectGlobalCall: () => {},
  setChatPageActive: () => {},
  pendingAcceptedCall: null,
  consumePendingCall: () => {},
});

export function CallProvider({ children }) {
  const { isAuthenticated } = useAuth();
  const [globalIncomingCall, setGlobalIncomingCall] = useState(null);
  const [pendingAcceptedCall, setPendingAcceptedCall] = useState(null);
  const chatPageActiveRef = useRef(false);
  const callActiveRef = useRef(false);

  useEffect(() => { callActiveRef.current = !!globalIncomingCall; }, [globalIncomingCall]);

  const setChatPageActive = useCallback((active) => {
    chatPageActiveRef.current = active;
    // If chat page becomes active and there's a global incoming call that hasn't been accepted,
    // clear it — the chat page's own WS will handle it
    if (active && globalIncomingCall && !pendingAcceptedCall) {
      setGlobalIncomingCall(null);
    }
  }, [globalIncomingCall, pendingAcceptedCall]);

  const onWsMessage = useCallback((msg) => {
    // Relay meeting_started to GlobalMeetingNotification via DOM event.
    // This provides a reliable delivery path since CallContext's WS is
    // always connected when the user is authenticated.
    if (msg.type === 'meeting_started' && msg.data) {
      window.dispatchEvent(new CustomEvent('meeting_started', { detail: msg.data }));
    }

    // Only handle call events when NOT on the chat page
    if (chatPageActiveRef.current) return;
    const d = msg.data;
    switch (msg.type) {
      case 'call_incoming': {
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
      case 'call_rejected':
      case 'call_ended': {
        setGlobalIncomingCall(null);
        break;
      }
      default: break;
    }
  }, []);

  const { sendMessage: wsSend } = useWebSocket(isAuthenticated ? onWsMessage : null);

  const rejectGlobalCall = useCallback(() => {
    if (globalIncomingCall) {
      wsSend('call_reject', {
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

  const value = useMemo(() => ({
    globalIncomingCall,
    acceptGlobalCall,
    rejectGlobalCall,
    setChatPageActive,
    pendingAcceptedCall,
    consumePendingCall,
  }), [globalIncomingCall, acceptGlobalCall, rejectGlobalCall, setChatPageActive, pendingAcceptedCall, consumePendingCall]);

  return (
    <CallCtx.Provider value={value}>
      {children}
    </CallCtx.Provider>
  );
}

export const useGlobalCall = () => useContext(CallCtx);
