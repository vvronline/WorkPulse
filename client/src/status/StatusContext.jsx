/**
 * StatusContext — single source of truth for v2 status state on the client.
 *
 * INVARIANTS:
 *   • Consumes the server-emitted `user_status` WS event verbatim. The
 *     client NEVER combines manualStatus + activity + idle on its own —
 *     that's the server resolver's job.
 *   • Maintains a `peers` map so the rest of the app can look up the
 *     effective state of any teammate without an extra fetch.
 *   • Idle / activity is reported via `sendActivityPing` (throttled), NOT
 *     by sending a synthetic 'away' status. The server's resolver decides
 *     whether the user is idle from `last_activity_at`.
 *   • (PR6) The legacy `UserStatusContext` has been deleted. This is the
 *     sole source of v2 status state on the client.
 */

import React, {
    createContext,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { useAuth } from '../AuthContext';
import useWebSocket from '../hooks/useWebSocket';
import {
    getMyStatus,
    setMyStatus as apiSetMyStatus,
    setPresencePreference as apiSetPresencePreference,
    sendActivityPing,
} from './api';
import { ACTIVITY_PING_THROTTLE_MS } from './constants';

// Default "we haven't heard from the server yet" payload.
const INITIAL_ME = {
    userId: null,
    effective: 'available',
    presence: 'offline',          // WS not yet open
    manualStatus: null,
    presencePreference: 'auto',
    statusMessage: null,
    statusMessageExpiresAt: null,
    source: 'system',
};

const StatusContext = createContext({
    ...INITIAL_ME,
    peers: {},
    getPeerStatus: () => null,
    setManualStatus: async () => { },
    setInvisible: async () => { },
});

export function StatusProvider({ children }) {
    const { user, isAuthenticated } = useAuth();
    const myUserId = user?.id ?? null;

    // Current user's effective state (mirrors the WS payload).
    const [me, setMe] = useState(INITIAL_ME);
    // Effective state for every peer we've heard about. Append-only.
    const [peers, setPeers] = useState({});

    const lastPingRef = useRef(0);

    // ── WS handler ────────────────────────────────────────────────────────
    // Single handler for the unified `user_status` event. The legacy
    // `presence_change` / `status_change` events were removed in PR7.
    const onWsMessage = useCallback((msg) => {
        if (!msg || !msg.type) return;
        if (msg.type !== 'user_status' || !msg.data?.userId) return;

        const payload = msg.data;
        // Update self if it's our event.
        if (myUserId && payload.userId === myUserId) {
            setMe(prev => ({ ...prev, ...payload }));
        }
        // Always merge into peers map so any component can look up
        // any user without a roundtrip.
        setPeers(prev => ({ ...prev, [payload.userId]: payload }));
    }, [myUserId]);

    const { sendMessage: _wsSend } = useWebSocket(onWsMessage);

    // ── Initial fetch ─────────────────────────────────────────────────────
    // On login, ask the server for our current resolved state so we have
    // something to show before the first WS event arrives.
    useEffect(() => {
        if (!isAuthenticated) {
            setMe(INITIAL_ME);
            setPeers({});
            return;
        }
        let cancelled = false;
        getMyStatus()
            .then(res => {
                if (!cancelled && res.data) {
                    setMe(prev => ({ ...prev, ...res.data }));
                    if (res.data.userId) {
                        setPeers(prev => ({ ...prev, [res.data.userId]: res.data }));
                    }
                }
            })
            .catch(() => { /* tolerate — the next WS event will fill us in */ });
        return () => { cancelled = true; };
    }, [isAuthenticated]);

    // ── Activity ping ─────────────────────────────────────────────────────
    // Lightweight throttle around real user input. Sends at most one ping
    // per ACTIVITY_PING_THROTTLE_MS. The server uses this to clear
    // 'away' on its own resolver pass.
    useEffect(() => {
        if (!isAuthenticated) return;

        const handler = () => {
            const now = Date.now();
            if (now - lastPingRef.current < ACTIVITY_PING_THROTTLE_MS) return;
            lastPingRef.current = now;
            sendActivityPing().catch(() => { /* best-effort */ });
        };
        const events = ['mousemove', 'keydown', 'mousedown', 'touchstart'];
        events.forEach(e => document.addEventListener(e, handler, { passive: true }));
        // Fire one immediately so the server doesn't keep us at 'away' on tab focus.
        handler();
        return () => {
            events.forEach(e => document.removeEventListener(e, handler));
        };
    }, [isAuthenticated]);

    // ── Mutators ──────────────────────────────────────────────────────────
    const setManualStatus = useCallback(async (status, opts = {}) => {
        // status may be null to clear the manual preference.
        const body = {
            status: status ?? null,
            message: opts.message ?? null,
            messageExpiresAt: opts.messageExpiresAt ?? null,
        };
        const res = await apiSetMyStatus(body);
        // Optimistic: the server will also broadcast a WS event, but we
        // update locally first so the UI responds instantly.
        if (res?.data) setMe(prev => ({ ...prev, ...res.data }));
        return res?.data ?? null;
    }, []);

    const setInvisible = useCallback(async (isInvisible) => {
        const res = await apiSetPresencePreference(isInvisible ? 'invisible' : 'auto');
        if (res?.data) setMe(prev => ({ ...prev, ...res.data }));
        return res?.data ?? null;
    }, []);

    // ── Peer lookup helper ────────────────────────────────────────────────
    const getPeerStatus = useCallback((userId) => peers[userId] || null, [peers]);

    // ── Provided value ────────────────────────────────────────────────────
    const value = useMemo(() => ({
        // me
        userId: me.userId,
        effective: me.effective,
        presence: me.presence,
        manualStatus: me.manualStatus,
        presencePreference: me.presencePreference,
        statusMessage: me.statusMessage,
        statusMessageExpiresAt: me.statusMessageExpiresAt,
        // peers
        peers,
        getPeerStatus,
        // mutators
        setManualStatus,
        setInvisible,
    }), [me, peers, getPeerStatus, setManualStatus, setInvisible]);

    return (
        <StatusContext.Provider value={value}>
            {children}
        </StatusContext.Provider>
    );
}

// Internal export only — consumers should use the `useStatus` hook.
export { StatusContext };