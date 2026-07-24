import { useEffect, useState } from "react";
import { MapPin, ScanFace, AlertTriangle, Clock, Loader2 } from "lucide-react";
import s from "./VerifyError.module.css";

export type VerifyErrKind = "location" | "face" | "generic";

interface VerifyErrorProps {
    kind: VerifyErrKind;
    title: string;
    message: string;
    code?: string;
    /** Optional retry action (e.g. re-run location capture). */
    onRetry?: () => void;
    retryLabel?: string;
    /** Optional busy flag for the retry button. */
    retryBusy?: boolean;
    /** Optional secondary action (e.g. "Enroll face"). */
    onSecondary?: () => void;
    secondaryLabel?: string;
}

// Face-attempt lockout window enforced by the server (see
// server/routes/tracker.ts — "Please wait 15 minutes"). The server does not
// return a precise unlock timestamp, so we count down from this default the
// moment the lockout error is shown.
const LOCKOUT_SECONDS = 15 * 60;

function fmt(sec: number): string {
    const m = Math.floor(sec / 60);
    const s2 = sec % 60;
    return `${m}:${String(s2).padStart(2, "0")}`;
}

/**
 * Shared, themed error block for the attendance verification modals. Renders a
 * kind-specific icon + title + the server's exact detail message, plus optional
 * remediation buttons. For the `FACE_ATTEMPTS_LOCKED` code it shows a live
 * "try again in mm:ss" countdown.
 */
export default function VerifyError({
    kind,
    title,
    message,
    code,
    onRetry,
    retryLabel = "Try again",
    retryBusy = false,
    onSecondary,
    secondaryLabel,
}: VerifyErrorProps) {
    const isLocked = code === "FACE_ATTEMPTS_LOCKED";
    const [remaining, setRemaining] = useState(isLocked ? LOCKOUT_SECONDS : 0);

    useEffect(() => {
        if (!isLocked) return;
        setRemaining(LOCKOUT_SECONDS);
        const id = setInterval(() => {
            setRemaining((r) => (r <= 1 ? 0 : r - 1));
        }, 1000);
        return () => clearInterval(id);
    }, [isLocked, message]);

    const Icon = isLocked
        ? Clock
        : kind === "location"
          ? MapPin
          : kind === "face"
            ? ScanFace
            : AlertTriangle;

    const locked = isLocked && remaining > 0;

    return (
        <div className={s.wrap} role="alert" aria-live="assertive">
            <Icon size={18} className={s.icon} />
            <div className={s.body}>
                <strong className={s.title}>{title}</strong>
                <span className={s.msg}>{message}</span>
                {isLocked && (
                    <span className={s.countdown}>
                        {locked
                            ? `You can try again in ${fmt(remaining)}`
                            : "You can try again now."}
                    </span>
                )}
                {(onRetry || onSecondary) && (
                    <div className={s.actions}>
                        {onRetry && (
                            <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                onClick={onRetry}
                                disabled={retryBusy || locked}
                            >
                                {retryBusy ? (
                                    <>
                                        <Loader2 size={13} className={s.spin} /> Working…
                                    </>
                                ) : (
                                    retryLabel
                                )}
                            </button>
                        )}
                        {onSecondary && secondaryLabel && (
                            <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={onSecondary}
                            >
                                {secondaryLabel}
                            </button>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
