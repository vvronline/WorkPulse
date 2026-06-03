import React, { useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { X } from 'lucide-react';
import s from './ConfirmDialog.module.css';

export default function ConfirmDialog({
    isOpen,
    title,
    message,
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    onConfirm,
    onCancel,
    isDanger = true
}) {
    const modalRef = useRef(null);

    // Keep the latest onCancel without making it an effect dependency.
    // TenantList (and other callers) pass an inline arrow function for
    // onCancel, so its identity changes on every render. If the focus
    // effect below depended on it, every keystroke in a message input
    // would re-run the effect and steal focus back to the first button
    // (you could only type one character). Reading it through a ref keeps
    // the effect stable (open/close only).
    const onCancelRef = useRef(onCancel);
    useEffect(() => { onCancelRef.current = onCancel; }, [onCancel]);

    // Focus trap and Escape key handler
    useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                onCancelRef.current?.();
                return;
            }
            if (e.key === 'Tab') {
                const focusable = modalRef.current?.querySelectorAll(
                    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
                );
                if (!focusable || focusable.length === 0) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (e.shiftKey) {
                    if (document.activeElement === first) {
                        e.preventDefault();
                        last.focus();
                    }
                } else {
                    if (document.activeElement === last) {
                        e.preventDefault();
                        first.focus();
                    }
                }
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        // Auto-focus the cancel button when dialog opens
        const timer = setTimeout(() => {
            modalRef.current?.querySelector('button')?.focus();
        }, 50);

        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            clearTimeout(timer);
        };
    }, [isOpen]);

    if (!isOpen) return null;

    return ReactDOM.createPortal(
        <div className={s.overlay} onClick={(e) => e.target === e.currentTarget && onCancel()}>
            <div className={s.modal} ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
                <div className={s.header}>
                    <h3 className={s.title} id="confirm-dialog-title">{title}</h3>
                    <button className={s.closeBtn} onClick={onCancel}><X size={16} /></button>
                </div>
                <div className={s.body}>
                    {typeof message === 'string' ? <p>{message}</p> : message}
                </div>
                <div className={s.footer}>
                    <button className={s.cancelBtn} onClick={onCancel}>{cancelText}</button>
                    <button
                        className={`${s.confirmBtn} ${isDanger ? s.danger : s.primary}`}
                        onClick={onConfirm}
                    >
                        {confirmText}
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
}
