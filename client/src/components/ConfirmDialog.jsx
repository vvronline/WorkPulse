import React from 'react';
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
    if (!isOpen) return null;

    return (
        <div className={s.overlay} onClick={(e) => e.target === e.currentTarget && onCancel()}>
            <div className={s.modal}>
                <div className={s.header}>
                    <h3 className={s.title}>{title}</h3>
                    <button className={s.closeBtn} onClick={onCancel}>✕</button>
                </div>
                <div className={s.body}>
                    <p>{message}</p>
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
        </div>
    );
}
