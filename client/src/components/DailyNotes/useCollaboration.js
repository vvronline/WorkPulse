/* useCollaboration.js — Yjs + Hocuspocus collaborative editing hook.
   Manages:
     • Yjs Doc instance per page
     • HocuspocusProvider (connects to /collab WebSocket server)
     • Awareness (presence: user name, color, cursor position)
     • Binding to Quill via y-quill

   Returns { ydoc, provider, awareness, binding, users, connected }
*/
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { QuillBinding } from 'y-quill';

// Distinct cursor colours for up to 12 simultaneous users
const CURSOR_COLORS = [
    '#e91e63', '#9c27b0', '#673ab7', '#3f51b5',
    '#2196f3', '#00bcd4', '#009688', '#4caf50',
    '#ff9800', '#ff5722', '#795548', '#607d8b',
];

function getColor(userId) {
    // Coerce to a finite integer; fall back to 0 so non-numeric / missing
    // user ids still get a deterministic color rather than indexing the
    // array with NaN (which yields `undefined`).
    const n = Number(userId);
    const idx = Number.isFinite(n) ? Math.abs(Math.trunc(n)) : 0;
    return CURSOR_COLORS[idx % CURSOR_COLORS.length];
}

/**
 * Build the WebSocket URL for the collaboration server.
 */
function getCollabWsUrl() {
    if (import.meta.env.VITE_COLLAB_WS_URL) {
        return import.meta.env.VITE_COLLAB_WS_URL;
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    return `${protocol}//${host}/collab`;
}

/**
 * Get the auth token from cookies for Hocuspocus authentication.
 */
function getAuthToken() {
    const match = document.cookie.match(/(?:^|;\s*)token=([^;]*)/);
    return match ? match[1] : '';
}

export default function useCollaboration({ pageId, tenantId, user, quillRef, enabled = true }) {
    const [connected, setConnected] = useState(false);
    const [users, setUsers] = useState([]); // array of { userId, name, avatar, color, cursor }
    const providerRef = useRef(null);
    const ydocRef = useRef(null);
    const bindingRef = useRef(null);
    // Track whether we got a real sync from the server (not a timeout fallback)
    const reallySyncedRef = useRef(false);

    const docName = useMemo(() => {
        if (!pageId) return null;
        return `notes:${tenantId || 0}:${pageId}`;
    }, [pageId, tenantId]);

    const cleanup = useCallback(() => {
        if (bindingRef.current) {
            bindingRef.current.destroy();
            bindingRef.current = null;
        }
        if (providerRef.current) {
            providerRef.current.destroy();
            providerRef.current = null;
        }
        if (ydocRef.current) {
            ydocRef.current.destroy();
            ydocRef.current = null;
        }
        reallySyncedRef.current = false;
        setConnected(false);
        setUsers([]);
    }, []);

    useEffect(() => {
        if (!enabled || !docName || !user) {
            cleanup();
            return;
        }

        // Create Yjs document
        const ydoc = new Y.Doc();
        ydocRef.current = ydoc;
        reallySyncedRef.current = false;

        // Connect to Hocuspocus server
        const wsUrl = getCollabWsUrl();
        const token = getAuthToken();
        const provider = new HocuspocusProvider({
            url: wsUrl,
            name: docName,
            document: ydoc,
            token,
            connect: true,
            onStatus({ status }) {
                setConnected(status === 'connected');
            },
            onSynced() {
                reallySyncedRef.current = true;
                // Now bind Quill to Yjs
                bindQuill();
            },
            onAuthenticationFailed({ reason }) {
                console.warn('[collab] Auth failed:', reason);
                setConnected(false);
                // Don't bind — editor works normally with existing persistence
            },
        });

        providerRef.current = provider;

        // Bind Quill ↔ Yjs only after real server sync
        function bindQuill() {
            if (bindingRef.current) return; // already bound

            const quillNode = quillRef?.current;
            if (!quillNode) return;
            const quill = typeof quillNode.getEditor === 'function' ? quillNode.getEditor() : quillNode;
            if (!quill || !ydocRef.current) return;

            const ytext = ydocRef.current.getText('quill');
            const awareness = providerRef.current?.awareness;

            if (ytext.length > 0) {
                // Yjs has server content — replace Quill's contents entirely
                quill.setContents([], 'silent');
            }
            // If ytext is empty, QuillBinding will seed it from Quill's current content

            const binding = new QuillBinding(ytext, quill, awareness || undefined);
            bindingRef.current = binding;
        }

        // Set up awareness (presence)
        const awareness = provider.awareness;

        // Set local user state
        const color = getColor(user.id);
        awareness.setLocalStateField('user', {
            userId: user.id,
            name: user.full_name || user.username || 'Anonymous',
            avatar: user.avatar || null,
            color,
        });

        // Listen for awareness changes → update users list
        const onAwarenessChange = () => {
            const states = awareness.getStates();
            const activeUsers = [];
            states.forEach((state, clientId) => {
                if (state.user && clientId !== awareness.clientID) {
                    activeUsers.push({
                        clientId,
                        userId: state.user.userId,
                        name: state.user.name,
                        avatar: state.user.avatar,
                        color: state.user.color,
                        cursor: state.cursor || null,
                    });
                }
            });
            setUsers(activeUsers);
        };

        awareness.on('change', onAwarenessChange);

        return () => {
            awareness.off('change', onAwarenessChange);
            cleanup();
        };
    }, [docName, user, enabled, cleanup]);

    return {
        connected,
        users,
        ydoc: ydocRef.current,
        provider: providerRef.current,
    };
}
