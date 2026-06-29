import { useEffect, useState } from "react";

interface PipState {
    remoteName: string;
    remoteAvatar: string | null;
    status: string;
    durationSec: number;
    muted: boolean;
    videoOff: boolean;
    callType: string;
}

/**
 * Tiny page rendered inside the Electron always-on-top mini call window
 * ("floatie"). It does NOT own the WebRTC peer connection or capture any
 * media itself — the main WorkPulse window keeps full control of those.
 *
 * Lifecycle:
 *   1. On mount we tell the main process we're ready via callPip.ready().
 *      The main process then pushes the latest cached call state, and the
 *      main window starts streaming live updates (duration tick, mute,
 *      videoOff, status changes, etc.) via callPip.updateState.
 *   2. User actions (mute toggle, restore, end) are sent back via
 *      callPip.sendAction(...). The main window's CallOverlay subscribes
 *      to those and runs the matching control.
 *   3. When the main window decides the call is over it calls
 *      callPip.close() which closes this BrowserWindow.
 */
export default function CallPipPage() {
    const api = window.electronAPI as any;
    const pip = api?.callPip;

    const [state, setState] = useState<PipState>({
        remoteName: "",
        remoteAvatar: null,
        status: "connecting",
        durationSec: 0,
        muted: false,
        videoOff: false,
        callType: "audio",
    });

    useEffect(() => {
        if (!pip) return;
        const off = pip.onState((next: Partial<PipState>) => {
            setState((prev) => ({ ...prev, ...next }));
        });
        // Signal main process to push the cached state. Small delay so the
        // event handler is definitely registered first.
        const t = setTimeout(() => { try { pip.ready(); } catch { /* ignore */ } }, 0);
        return () => { clearTimeout(t); try { off?.(); } catch { /* ignore */ } };
    }, [pip]);

    const sendAction = (action: string) => {
        try { pip?.sendAction(action); } catch { /* ignore */ }
    };

    const formatTime = (s: number) => {
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return `${m}:${String(sec).padStart(2, "0")}`;
    };

    const initial = (state.remoteName || "?").charAt(0).toUpperCase();
    const avatarUrl = state.remoteAvatar
        ? (state.remoteAvatar.startsWith("http")
            ? state.remoteAvatar
            : `${window.location.origin}${state.remoteAvatar.startsWith("/") ? "" : "/"}${state.remoteAvatar}`)
        : null;

    const statusLabel = (() => {
        if (state.status === "incoming") return "Incoming call…";
        if (state.status === "ringing") return "Ringing…";
        if (state.status === "connecting") return "Connecting…";
        if (state.status === "reconnecting") return "Reconnecting…";
        if (state.status === "on-hold") return "On Hold";
        return formatTime(state.durationSec || 0);
    })();

    return (
        <div style={styles.root}>
            {/* Draggable area covers the whole card — buttons use no-drag */}
            <div style={styles.dragArea} />

            <div style={styles.body}>
                <div style={styles.avatar}>
                    {avatarUrl
                        ? <img src={avatarUrl} alt="" style={styles.avatarImg} />
                        : <span style={styles.avatarInitial}>{initial}</span>}
                    {state.muted && (
                        <span style={styles.muteBadge} title="You are muted">
                            <MicOffIcon />
                        </span>
                    )}
                </div>

                <div style={styles.meta}>
                    <div style={styles.name} title={state.remoteName || "Call"}>
                        {state.remoteName || "Call"}
                    </div>
                    <div style={styles.status}>{statusLabel}</div>
                </div>
            </div>

            <div style={styles.actions}>
                <button
                    type="button"
                    style={{ ...styles.btn, ...(state.muted ? styles.btnActiveRed : null) }}
                    onClick={() => sendAction(state.muted ? "unmute" : "mute")}
                    title={state.muted ? "Unmute" : "Mute"}
                    aria-label={state.muted ? "Unmute" : "Mute"}
                >
                    {state.muted ? <MicOffIcon /> : <MicIcon />}
                </button>
                <button
                    type="button"
                    style={styles.btn}
                    onClick={() => sendAction("restore")}
                    title="Return to Loops"
                    aria-label="Return to Loops"
                >
                    <RestoreIcon />
                </button>
                <button
                    type="button"
                    style={{ ...styles.btn, ...styles.btnEnd }}
                    onClick={() => sendAction("end")}
                    title="End call"
                    aria-label="End call"
                >
                    <PhoneIcon rotate />
                </button>
            </div>
        </div>
    );
}

// ─── Inline icons ──────────────────────────────────────────────────────
const MicIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <rect x="9" y="1" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="2" />
        <path d="M5 12a7 7 0 0 0 14 0M12 19v4m-4 0h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
);
const MicOffIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path d="M1 1l22 22M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M17 16.95A7 7 0 0 1 5 12m14-1a7 7 0 0 1-.11 1.23M12 19v4m-4 0h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
);
const PhoneIcon = ({ rotate }: { rotate?: boolean }) => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={rotate ? { transform: "rotate(135deg)" } : undefined}>
        <path d="M3.51 5.47a2.5 2.5 0 0 1 3.53 0l1.06 1.06a2.5 2.5 0 0 1 0 3.54l-.53.53a9 9 0 0 0 5.83 5.83l.53-.53a2.5 2.5 0 0 1 3.54 0l1.06 1.06a2.5 2.5 0 0 1 0 3.53l-.87.87a3 3 0 0 1-3.15.73C9.42 20.45 3.55 14.58 1.91 9.49a3 3 0 0 1 .73-3.15l.87-.87z"
            stroke="currentColor" strokeWidth="2" fill="none" />
    </svg>
);
const RestoreIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

// ─── Inline styles (no global CSS dependency) ──────────────────────────
const styles: Record<string, React.CSSProperties> = {
    root: {
        position: "fixed",
        inset: 0,
        background: "linear-gradient(180deg, #111827 0%, #0a0f1a 100%)",
        color: "#f9fafb",
        display: "flex",
        flexDirection: "column",
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        userSelect: "none",
        overflow: "hidden",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 12,
        boxShadow: "0 12px 32px rgba(0,0,0,0.55)",
    },
    // Invisible draggable region for the OS — covers everything BEHIND
    // the body/actions. We set `-webkit-app-region: drag` here and
    // `no-drag` on each interactive button.
    dragArea: {
        position: "absolute",
        inset: 0,
        WebkitAppRegion: "drag",
    } as React.CSSProperties,
    body: {
        position: "relative",
        flex: 1,
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "16px 18px 8px",
        zIndex: 1,
    },
    avatar: {
        position: "relative",
        width: 64,
        height: 64,
        borderRadius: "50%",
        background: "#374151",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
    },
    avatarImg: {
        width: "100%",
        height: "100%",
        objectFit: "cover",
    },
    avatarInitial: {
        fontSize: 26,
        fontWeight: 600,
        color: "#f9fafb",
    },
    muteBadge: {
        position: "absolute",
        bottom: -2,
        right: -2,
        width: 22,
        height: 22,
        borderRadius: "50%",
        background: "#ef4444",
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "2px solid #0a0f1a",
    },
    meta: {
        minWidth: 0,
        flex: 1,
    },
    name: {
        fontSize: 15,
        fontWeight: 600,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
    },
    status: {
        fontSize: 12,
        opacity: 0.75,
        marginTop: 2,
    },
    actions: {
        position: "relative",
        zIndex: 2,
        display: "flex",
        justifyContent: "center",
        gap: 10,
        padding: "8px 12px 14px",
    },
    btn: {
        width: 36,
        height: 36,
        borderRadius: "50%",
        border: "none",
        background: "rgba(55, 65, 81, 0.95)",
        color: "#f9fafb",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        WebkitAppRegion: "no-drag",
        transition: "background 0.15s, transform 0.1s",
    } as React.CSSProperties,
    btnActiveRed: {
        background: "#ef4444",
        color: "#fff",
    },
    btnEnd: {
        background: "#ef4444",
        color: "#fff",
    },
};