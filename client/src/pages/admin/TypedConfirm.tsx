import React, { useState, useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import s from "./UserManagement.module.css";

interface TypedConfirmProps {
    title: string;
    message: string;
    hint?: string;
    confirmLabel?: string;
    requireText?: string;
    danger?: boolean;
    onConfirm?: () => void | Promise<void>;
    onCancel?: () => void;
}

/**
 * TypedConfirm — generic confirmation modal that optionally requires the
 * user to type a specific string (e.g. a username) before the destructive
 * action is enabled.
 *
 * Props:
 *   title         – modal heading
 *   message       – primary message body
 *   hint          – sub-text / explanation
 *   confirmLabel  – text on the confirm button (default: "Confirm")
 *   requireText   – if set, user must type this exact string to enable confirm
 *   danger        – if true, confirm button uses danger styling
 *   onConfirm()   – called when confirmed; modal closes after the call resolves
 *   onCancel()
 */
export default function TypedConfirm({
    title,
    message,
    hint,
    confirmLabel = "Confirm",
    requireText,
    danger,
    onConfirm,
    onCancel,
}: TypedConfirmProps) {
    const [typed, setTyped] = useState("");
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        setTyped("");
        setBusy(false);
    }, [requireText, message]);

    const canConfirm = !requireText || typed === requireText;

    const handleConfirm = async () => {
        if (!canConfirm || busy) return;
        setBusy(true);
        try {
            await Promise.resolve(onConfirm?.());
        } finally {
            setBusy(false);
            onCancel?.();
        }
    };

    const handleKey = (e: React.KeyboardEvent) => {
        if (e.key === "Escape") onCancel?.();
        if (e.key === "Enter" && canConfirm && !busy) handleConfirm();
    };

    return (
        <div className={s.confirmOverlay} onClick={onCancel}>
            <div
                className={s.confirm}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={handleKey}
                role="dialog"
                aria-modal="true"
                aria-labelledby="typed-confirm-title"
            >
                <h3 id="typed-confirm-title" className={s.confirmTitle}>
                    {danger && <AlertTriangle size={18} color="var(--danger)" />}
                    {title}
                </h3>
                <p className={s.confirmText}>{message}</p>
                {hint && <p className={s.confirmHint}>{hint}</p>}

                {requireText && (
                    <input
                        autoFocus
                        type="text"
                        className={s.confirmInput}
                        value={typed}
                        onChange={(e) => setTyped(e.target.value)}
                        placeholder={`Type "${requireText}"`}
                        disabled={busy}
                    />
                )}

                <div className={s.confirmActions}>
                    <button
                        className={`${s.btn} ${s.secondary}`}
                        onClick={onCancel}
                        disabled={busy}
                    >
                        Cancel
                    </button>
                    <button
                        className={`${s.btn} ${danger ? s.danger : ""}`}
                        onClick={handleConfirm}
                        disabled={!canConfirm || busy}
                        autoFocus={!requireText}
                    >
                        {busy ? "Working…" : confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}