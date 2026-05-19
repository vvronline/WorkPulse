import { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAuth } from './AuthContext';
import { getUserStatus } from './api';
import useWebSocket from './hooks/useWebSocket';

const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes of inactivity → away
const VISIBILITY_AWAY_DELAY = 2 * 60 * 1000; // 2 minutes hidden before away

const StatusCtx = createContext({
  myStatus: 'available',
  myStatusText: null,
  manualStatus: null,
  setManualStatus: () => {},
  setAutoStatus: () => {},
  clearAutoStatus: () => {},
});

/** Compute the effective auto status from a Set of active auto statuses */
function resolveAutoStatus(set) {
  if (set.has('in_call')) return 'in_call';
  if (set.has('in_meeting')) return 'in_meeting';
  return null;
}

export function UserStatusProvider({ children }) {
  const { isAuthenticated } = useAuth();

  // Manual status set by the user (available/busy/dnd/offline/away)
  const [manualStatus, setManualStatusState] = useState(null);
  const [manualStatusText, setManualStatusText] = useState(null);

  // Auto statuses (calls and meetings can overlap) — stored as a ref + state pair
  // The ref is the source of truth for synchronous reads; state triggers re-renders.
  const autoSetRef = useRef(new Set());
  const [autoStatus, setAutoStatusDerived] = useState(null);

  // Idle tracking
  const idleTimerRef = useRef(null);
  const visibilityTimerRef = useRef(null);
  const wasIdleRef = useRef(false);
  const manualStatusRef = useRef(manualStatus);
  manualStatusRef.current = manualStatus;

  // Effective status: auto > manual > available
  const myStatus = autoStatus || manualStatus || 'available';
  const myStatusText = manualStatusText;

  const { sendMessage: wsSend } = useWebSocket(null);

  // Send status change via WS (persists to DB on server)
  const broadcastStatus = useCallback((status, statusText) => {
    wsSend('status_change', { status, statusText: statusText || null });
  }, [wsSend]);

  // Manual status setter (from StatusPicker)
  const setManualStatus = useCallback((status, statusText) => {
    setManualStatusState(status);
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

  // Fetch initial status on mount.
  //
  // We deliberately ignore the server values 'available', 'in_call',
  // 'in_meeting' AND 'offline' here:
  //   • 'available' is the implicit default, so there's no need to
  //     stamp it as a manual choice (which would prevent idle-away).
  //   • 'in_call' / 'in_meeting' are auto statuses driven by the
  //     active call/meeting on this device, not a manual selection.
  //   • 'offline' is persisted on logout / clock-out — but the very
  //     fact that we're loading the app means the user is back online,
  //     so we should NOT pin them as "Appear Offline". Without this
  //     guard the navbar profile would show "Offline" with a grey dot
  //     until the user manually changes status, while chat (driven by
  //     a fresh WS presence_change) correctly shows them as available.
  useEffect(() => {
    if (!isAuthenticated) return;
    getUserStatus().then(({ data }) => {
      const persisted = data.status;
      if (persisted && persisted !== 'available' && persisted !== 'in_call' && persisted !== 'in_meeting' && persisted !== 'offline') {
        setManualStatusState(persisted);
        setManualStatusText(data.statusText || null);
      }
    }).catch(() => {});
  }, [isAuthenticated]);

  // Idle detection: mark away after IDLE_TIMEOUT of no mouse/keyboard/touch activity
  useEffect(() => {
    if (!isAuthenticated) return;

    const resetIdle = () => {
      clearTimeout(idleTimerRef.current);
      clearTimeout(visibilityTimerRef.current);
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
        // Don't override any explicitly set manual status
        if (manualStatusRef.current) return;
        wasIdleRef.current = true;
        broadcastStatus('away', null);
      }, IDLE_TIMEOUT);
    };

    const events = ['mousemove', 'keydown', 'mousedown', 'touchstart', 'scroll'];
    events.forEach(e => document.addEventListener(e, resetIdle, { passive: true }));
    resetIdle(); // start timer

    // Visibility change: tab hidden → delayed away (not immediate)
    const onVisibility = () => {
      if (document.hidden) {
        if (autoSetRef.current.size > 0) return;
        if (manualStatusRef.current) return;
        // Don't go away instantly on tab switch — wait before marking away
        clearTimeout(visibilityTimerRef.current);
        visibilityTimerRef.current = setTimeout(() => {
          wasIdleRef.current = true;
          broadcastStatus('away', null);
        }, VISIBILITY_AWAY_DELAY);
      } else {
        clearTimeout(visibilityTimerRef.current);
        resetIdle();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearTimeout(idleTimerRef.current);
      clearTimeout(visibilityTimerRef.current);
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
  }), [myStatus, myStatusText, manualStatus, setManualStatus, setAutoStatus, clearAutoStatus]);

  return (
    <StatusCtx.Provider value={value}>
      {children}
    </StatusCtx.Provider>
  );
}

export function useUserStatus() {
  return useContext(StatusCtx);
}
