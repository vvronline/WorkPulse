import React, { useState, useEffect, useCallback, useRef } from "react";
import s from "./UpdateNotification.module.css";

/* eslint-disable @typescript-eslint/no-explicit-any */
const api = window.electronAPI as any;

type UpdateState = "idle" | "checking" | "downloading" | "ready" | "upToDate" | "error";

interface UpdateInfo {
    version?: string;
    releaseNotes?: string | Array<{ note?: string } | string>;
    percent?: number;
    message?: string;
}

export default function UpdateNotification() {
    const [state, setState] = useState<UpdateState>("idle");
    const [version, setVersion] = useState("");
    const [appVersion, setAppVersion] = useState("");
    const [progress, setProgress] = useState(0);
    const [visible, setVisible] = useState(false);
    const [errorMsg, setErrorMsg] = useState("");
    const [releaseNotes, setReleaseNotes] = useState<string | Array<{ note?: string } | string>>("");
    const [showNotes, setShowNotes] = useState(false);
    const [fetchingNotes, setFetchingNotes] = useState(false);
    const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearDismissTimer = useCallback(() => {
        if (dismissTimerRef.current) {
            clearTimeout(dismissTimerRef.current);
            dismissTimerRef.current = null;
        }
    }, []);

    const autoDismiss = useCallback(
        (delay = 5000) => {
            clearDismissTimer();
            dismissTimerRef.current = setTimeout(() => {
                setState("idle");
                setVisible(false);
                setErrorMsg("");
            }, delay);
        },
        [clearDismissTimer]
    );

    const dismiss = useCallback(() => {
        clearDismissTimer();
        setVisible(false);
        setShowNotes(false);
    }, [clearDismissTimer]);

    const checkForUpdate = useCallback(async () => {
        if (!api?.checkForUpdate) return;
        setState("checking");
        setVisible(true);
        try {
            const result = await api.checkForUpdate();
            if (result?.available) return; // update-available event will handle state transition
            if (result?.reason === "check-in-progress") {
                autoDismiss(2000);
                return;
            }
            if (result?.reason === "error") {
                setErrorMsg(result.error || "Unknown error");
                setState("error");
            } else {
                setState("upToDate");
            }
            autoDismiss(5000);
        } catch {
            setState("error");
            setErrorMsg("Failed to check for updates");
            autoDismiss(6000);
        }
    }, [autoDismiss]);

    useEffect(() => {
        if (!api) return;
        api.getVersion?.().then((v: string) => setAppVersion(v));

        const cleanups: Array<() => void> = [];

        // Allow triggering check from profile menu
        const handleExternalCheck = () => checkForUpdate();
        window.addEventListener("workpulse-check-update", handleExternalCheck);

        const unsub1 = api.onUpdateAvailable((info: UpdateInfo) => {
            setVersion(info.version || "");
            if (info.releaseNotes) setReleaseNotes(info.releaseNotes);
            setState("downloading");
            setProgress(0);
            setVisible(true);
        });
        if (unsub1) cleanups.push(unsub1);

        const unsub2 = api.onDownloadProgress?.((info: UpdateInfo) => {
            setProgress(info.percent || 0);
        });
        if (unsub2) cleanups.push(unsub2);

        const unsub3 = api.onUpdateDownloaded(async (info: UpdateInfo) => {
            setVersion(info.version || "");
            if (info.releaseNotes) {
                setReleaseNotes(info.releaseNotes);
                setShowNotes(true);
            }
            setState("ready");
            setVisible(true);
            // Auto-fetch release notes if not included by electron-updater
            if (!info.releaseNotes && api?.fetchReleaseNotes && info.version) {
                setFetchingNotes(true);
                try {
                    const notes = await api.fetchReleaseNotes(info.version);
                    if (notes) {
                        setReleaseNotes(notes);
                        setShowNotes(true);
                    }
                } catch {
                    /* ignore */
                }
                setFetchingNotes(false);
            }
        });
        if (unsub3) cleanups.push(unsub3);

        const unsub4 = api.onUpdateReminder?.((info: UpdateInfo) => {
            setVersion(info.version || "");
            if (info.releaseNotes) {
                setReleaseNotes(info.releaseNotes);
                setShowNotes(true);
            }
            setState("ready");
            setVisible(true);
        });
        if (unsub4) cleanups.push(unsub4);

        const unsub5 = api.onUpdateNotAvailable?.(() => {
            setState("upToDate");
            setVisible(true);
            autoDismiss(5000);
        });
        if (unsub5) cleanups.push(unsub5);

        const unsub6 = api.onUpdateError?.((info: UpdateInfo) => {
            setState("error");
            setErrorMsg(info?.message || "");
            setVisible(true);
            autoDismiss(6000);
        });
        if (unsub6) cleanups.push(unsub6);

        return () => {
            window.removeEventListener("workpulse-check-update", handleExternalCheck);
            cleanups.forEach((fn) => fn());
            clearDismissTimer();
        };
    }, [checkForUpdate, autoDismiss, clearDismissTimer]);

    if (!visible || state === "idle") return null;

    return (
        <div className={s.banner}>
            <div className={s.content}>
                {state === "checking" && (
                    <>
                        <span className={s.spinner} />
                        <span>Checking for updates…</span>
                    </>
                )}

                {state === "downloading" && (
                    <>
                        <span className={s.icon}>⏬</span>
                        <span>Downloading <strong>v{version}</strong>… {progress}%</span>
                        <div className={s.progressBar}>
                            <div className={s.progressFill} style={{ width: `${progress}%` }} />
                        </div>
                    </>
                )}

                {state === "ready" && (
                    <>
                        <span className={s.icon}>✅</span>
                        <span>Update <strong>v{version}</strong> ready — restart to apply</span>
                        <div className={s.actions}>
                            <button className={s.actionBtn} onClick={() => api.installUpdate()}>
                                Restart Now
                            </button>
                            <button
                                className={s.notesBtn}
                                disabled={fetchingNotes}
                                onClick={async () => {
                                    if (showNotes) { setShowNotes(false); return; }
                                    // If we already have notes, just toggle
                                    if (releaseNotes) { setShowNotes(true); return; }
                                    // Fetch from GitHub API as fallback
                                    if (api?.fetchReleaseNotes && version) {
                                        setFetchingNotes(true);
                                        try {
                                            const notes = await api.fetchReleaseNotes(version);
                                            if (notes) setReleaseNotes(notes);
                                        } catch {
                                            /* ignore */
                                        }
                                        setFetchingNotes(false);
                                    }
                                    setShowNotes(true);
                                }}
                            >
                                {fetchingNotes ? "Loading…" : showNotes ? "Hide" : "What's new"}
                            </button>
                            <button className={s.dismissBtn} onClick={dismiss}>Later</button>
                        </div>
                        {showNotes && (
                            <div className={s.releaseNotes}>
                                {releaseNotes
                                    ? (typeof releaseNotes === "string"
                                        ? releaseNotes
                                        : Array.isArray(releaseNotes)
                                            ? releaseNotes.map((n, i) => <p key={i}>{typeof n === "string" ? n : n.note || ""}</p>)
                                            : null)
                                    : <span className={s.noNotes}>No release notes available for this version.</span>
                                }
                            </div>
                        )}
                    </>
                )}

                {state === "upToDate" && (
                    <>
                        <span className={s.icon}>✓</span>
                        <span>You're on the latest version <strong>v{appVersion}</strong></span>
                    </>
                )}

                {state === "error" && (
                    <>
                        <span className={s.icon}>⚠️</span>
                        <span>{errorMsg || "Couldn't check for updates"}</span>
                        <button className={s.dismissBtn} onClick={dismiss}>Dismiss</button>
                    </>
                )}
            </div>
        </div>
    );
}