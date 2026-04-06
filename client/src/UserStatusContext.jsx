import { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAuth } from './AuthContext';
import { getUserStatus } from './api';
import useWebSocket from './hooks/useWebSocket';

const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes of inactivity → away

const StatusCtx = createContext({
  myStatus: 'available',
  myStatusText: null,
  manualStatus: null,
  setManualStatus: () => {},
  setAutoStatus: () => {},
  clearAutoStatus: () => {},
  otherStatuses: {},
});

/** Compute the effective auto status from a Set of active auto statuses */
function resolveAutoStatus(set) {
  if (set.has('in_call')) return 'in_call';
  if (set.has('in_meeting')) return 'in_meeting';
  return null;
}

export function UserStatusProvider({ children }) {
  const { isAuthenticated, user } = useAuth();

  // Manual status set by the user (available/busy/dnd/offline/away)
  const [manualStatus, setManualStatusState] = useState(null);
  const [manualStatusText, setManualStatusText] = useState(null);

  // Auto statuses (calls and meetings can overlap) — stored as a ref + state pair
  // The ref is the source of truth for synchronous reads; state triggers re-renders.
  const autoSetRef = useRef(new Set());
  const [autoStatus, setAutoStatusDerived] = useState(null);

  // Other users' statuses: { [userId]: 'available' | 'busy' | ... }
  const [otherStatuses, setOtherStatuses] = useState({});

  // Idle tracking
  const idleTimerRef = useRef(null);
  const wasIdleRef = useRef(false);
  const manualStatusRef = useRef(manualStatus);
  manualStatusRef.current = manualStatus;

  // Effective status: auto > manual > available
  const myStatus = autoStatus || manualStatus || 'available';
  const myStatusText = manualStatusText;

  // WS handler for receiving other users' status changes
  const onWsMessage = useCallback((msg) => {
    if (msg.type === 'status_change') {
      const { userId, userStatus } = msg.data;
      // Ignore own status echoes
      if (userId === user?.id) return;
      setOtherStatuses(prev => ({ ...prev, [userId]: userStatus }));
    } else if (msg.type === 'presence_change') {
      const { userId, status, userStatus } = msg.data;
      if (userId === user?.id) return;
      if (status === 'offline') {
        setOtherStatuses(prev => ({ ...prev, [userId]: 'offline' }));
      } else if (userStatus) {
        setOtherStatuses(prev => ({ ...prev, [userId]: userStatus }));
      }
    }
  }, [user?.id]);

  const { sendMessage: wsSend } = useWebSocket(isAuthenticated ? onWsMessage : null);

  // Send status change via WS (persists to DB on server)
  const broadcastStatus = useCallback((status, statusText) => {
    wsSend('status_change', { status, statusText: statusText || null });
  }, [wsSend]);

  // Manual status setter (from StatusPicker)
  const setManualStatus = useCallback((status, statusText) => {
    setManualStatusState(status === 'available' ? null : status);
    setManualStatusText(statusText || null);
    // If no auto-status is active, broadcast immediately
    if (autoSetRef.current.size === 0) {
      broadcastStatus(status, statusText);
    }
  }, [broadcastStatus]);

  // Auto status setter (from call/meeting contexts)
  const setAutoStatus = useCallback((status) => {
    autoSetRef.current.add(status);
    const effective = resolveAutoStatus(autoSetRef.current);
    setAutoStatusDerived(effective);
    broadcastStatus(effective, null);
  }, [broadcastStatus]);

  // Clear a specific auto status (call/meeting ended) → revert to manual or available
  const clearAutoStatus = useCallback((status) => {
    if (status) {
      autoSetRef.current.delete(status);
    } else {
      autoSetRef.current.clear();
    }
    const effective = resolveAutoStatus(autoSetRef.current);
    setAutoStatusDerived(effective);
    if (effective) {
      broadcastStatus(effective, null);
    } else {
      broadcastStatus(manualStatusRef.current || 'available', null);
    }
  }, [broadcastStatus]);

  // Fetch initial status on mount
  useEffect(() => {
    if (!isAuthenticated) return;
    getUserStatus().then(({ data }) => {
      if (data.status && data.status !== 'available' && data.status !== 'in_call' && data.status !== 'in_meeting' && data.status !== 'away') {
        setManualStatusState(data.status);
        setManualStatusText(data.statusText || null);
      }
    }).catch(() => {});
  }, [isAuthenticated]);

  // Idle detection: mark away after IDLE_TIMEOUT of no mouse/keyboard/touch activity
  useEffect(() => {
    if (!isAuthenticated) return;

    const resetIdle = () => {
      clearTimeout(idleTimerRef.current);
      // If we were idle-away, revert now that user is active
      if (wasIdleRef.current) {
        wasIdleRef.current = false;
        if (autoSetRef.current.size === 0) {
          broadcastStatus(manualStatusRef.current || 'available', null);
        }
      }
      idleTimerRef.current = setTimeout(() => {
        // Don't override in_call/in_meeting with away
        if (autoSetRef.current.size > 0) return;
        // Don't override manual offline/dnd/busy
        if (manualStatusRef.current === 'offline' || manualStatusRef.current === 'dnd' || manualStatusRef.current === 'busy') return;
        wasIdleRef.current = true;
        broadcastStatus('away', null);
      }, IDLE_TIMEOUT);
    };

    const events = ['mousemove', 'keydown', 'mousedown', 'touchstart', 'scroll'];
    events.forEach(e => document.addEventListener(e, resetIdle, { passive: true }));
    resetIdle(); // start timer

    // Visibility change: tab hidden = away
    const onVisibility = () => {
      if (document.hidden) {
        if (autoSetRef.current.size > 0) return;
        if (manualStatusRef.current === 'offline' || manualStatusRef.current === 'dnd' || manualStatusRef.current === 'busy') return;
        wasIdleRef.current = true;
        broadcastStatus('away', null);
      } else {
        resetIdle();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearTimeout(idleTimerRef.current);
      events.forEach(e => document.removeEventListener(e, resetIdle));
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [isAuthenticated, broadcastStatus]);

  const value = useMemo(() => ({
    myStatus,
    myStatusText,
    manualStatus,
    setManualStatus,
    setAutoStatus,
    clearAutoStatus,
    otherStatuses,
  }), [myStatus, myStatusText, manualStatus, setManualStatus, setAutoStatus, clearAutoStatus, otherStatuses]);

  return (
    <StatusCtx.Provider value={value}>
      {children}
    </StatusCtx.Provider>
  );
}

export function useUserStatus() {
  return useContext(StatusCtx);
}
