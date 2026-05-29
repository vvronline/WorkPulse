import React, { useState, useEffect, useCallback } from 'react';
import { Shield, AlertTriangle, X } from 'lucide-react';
import { useAuth } from '../../AuthContext';
import { getActiveInspectorSession, revokeAccessSession } from '../../api';

/**
 * Tenant-side banner that shows when a platform-admin is currently
 * impersonating a user in this workspace.
 *
 *   - Visible to every user (not just super_admins) so impersonation is
 *     never opaque — staff always know when an outside party is observing.
 *   - super_admins additionally see a "Revoke" button to terminate the
 *     session immediately. Other users see a read-only badge.
 *
 * Polls every 30s + listens for the `platform_access_session_started` /
 * `platform_access_session_ended` WS events so the banner appears/disappears
 * promptly without manual reload. (WS hook intentionally omitted here to
 * keep the component zero-dependency; the polling fallback is sufficient.)
 */
export default function InspectorSessionBanner() {
    const { user } = useAuth();
    const [session, setSession] = useState(null);
    const [dismissed, setDismissed] = useState(false);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        // Only tenant users should poll this — platform admins outside any
        // tenant context get a 400.
        if (!user || user.role === 'platform_admin') {
            setSession(null);
            return;
        }
        try {
            const r = await getActiveInspectorSession();
            setSession(r.data?.active_session || null);
        } catch {
            setSession(null);
        }
    }, [user]);

    useEffect(() => {
        load();
        const id = setInterval(load, 30_000);
        return () => clearInterval(id);
    }, [load]);

    if (!session) return null;

    const handleRevoke = async () => {
        if (!session) return;
        setBusy(true);
        try {
            await revokeAccessSession(session.id, 'Revoked from session banner');
            setSession(null);
        } catch {
            // surface stays — the inspector might already be gone
        } finally { setBusy(false); }
    };

    const canRevoke = user?.role === 'super_admin' || user?.role === 'platform_admin';
    const endsAt = session.session_ends_at ? new Date(session.session_ends_at) : null;

    if (dismissed) return null;

    return (
        <div
            role="alert"
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '8px 16px',
                background: 'color-mix(in srgb, var(--warning) 20%, transparent)',
                borderBottom: '2px solid var(--warning)',
                color: 'var(--text-primary)',
                fontSize: 13,
            }}
        >
            <AlertTriangle size={16} style={{ color: 'var(--warning)', flexShrink: 0 }} />
            <div style={{ flex: 1, lineHeight: 1.4 }}>
                <strong style={{ color: 'var(--warning)' }}>Platform support session active.</strong>{' '}
                <span style={{ color: 'var(--text-secondary)' }}>
                    {session.requested_by_name || 'A platform inspector'} is viewing this workspace
                    {session.scope === 'read' ? ' (read-only)' : ' with write access'}
                    {endsAt && ` until ${endsAt.toLocaleTimeString()}`}.
                </span>
            </div>

            {canRevoke && (
                <button
                    onClick={handleRevoke}
                    disabled={busy}
                    style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        padding: '4px 10px',
                        background: 'var(--danger)', color: '#fff',
                        border: 'none', borderRadius: 4,
                        cursor: 'pointer', fontSize: 12,
                    }}
                >
                    <Shield size={12} /> Revoke
                </button>
            )}
            <button
                onClick={() => setDismissed(true)}
                aria-label="Dismiss"
                style={{
                    background: 'none', border: 'none',
                    color: 'inherit', cursor: 'pointer', padding: 4,
                }}
            >
                <X size={14} />
            </button>
        </div>
    );
}