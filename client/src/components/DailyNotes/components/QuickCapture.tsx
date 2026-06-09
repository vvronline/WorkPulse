/* eslint-disable @typescript-eslint/no-explicit-any */
/* ─────────────────────────────────────────────────────────
   QuickCapture — floating compact composer triggered by
   Ctrl+Shift+N. Anything you type gets appended to the
   "Inbox" page (created on demand) as a timestamped block.

   Keyboard:
     Ctrl+Enter   → save and close
     Escape       → cancel
   ───────────────────────────────────────────────────────── */
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Inbox, X, Check } from "../../../constants/icons";
import s from "./QuickCapture.module.css";

interface QuickCaptureProps {
    store: any;
    onClose: () => void;
}

export default function QuickCapture({ store, onClose }: QuickCaptureProps) {
    const { appendToInbox } = store;
    const [text, setText] = useState("");
    const [saved, setSaved] = useState(false);
    const inputRef = useRef<HTMLTextAreaElement | null>(null);

    useEffect(() => {
        const id = setTimeout(() => inputRef.current?.focus(), 30);
        return () => clearTimeout(id);
    }, []);

    /* Lock body scroll while open */
    useEffect(() => {
        const prev = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => { document.body.style.overflow = prev; };
    }, []);

    const submit = () => {
        const v = text.trim();
        if (!v) {
            onClose();
            return;
        }
        appendToInbox(v);
        setSaved(true);
        // Tiny success flash before closing
        setTimeout(() => onClose(), 380);
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Escape") {
            e.preventDefault();
            onClose();
        } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            submit();
        }
    };

    return createPortal(
        <div
            className={s.overlay}
            onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
            <div className={s.panel} role="dialog" aria-label="Quick capture">
                <div className={s.head}>
                    <span className={s.headLabel}>
                        <Inbox size={14} aria-hidden="true" />
                        Quick capture
                        <span className={s.headHint}>· appends to <strong>Inbox</strong></span>
                    </span>
                    <button
                        type="button"
                        className={s.closeBtn}
                        onClick={onClose}
                        aria-label="Close"
                        title="Close (Esc)"
                    >
                        <X size={14} />
                    </button>
                </div>

                <textarea
                    ref={inputRef}
                    className={s.input}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="What's on your mind? (Ctrl+Enter to save)"
                    rows={4}
                />

                <div className={s.foot}>
                    <span className={s.footHint}>
                        <kbd className={s.kbd}>Ctrl</kbd>
                        +
                        <kbd className={s.kbd}>Enter</kbd>
                        save
                        <span className={s.dot}>·</span>
                        <kbd className={s.kbd}>Esc</kbd>
                        close
                    </span>
                    <button
                        type="button"
                        className={`${s.saveBtn} ${saved ? s.saveBtnSaved : ""}`}
                        onClick={submit}
                        disabled={!text.trim() && !saved}
                    >
                        {saved ? (
                            <>
                                <Check size={14} />
                                Saved
                            </>
                        ) : (
                            "Save to Inbox"
                        )}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}