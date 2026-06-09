import { useState } from "react";

export interface ConfirmDialogState {
    open: boolean;
    title: string;
    message: string;
    confirmText: string;
    isDanger: boolean;
    onConfirm: (() => void) | null;
}

export function useConfirmDialog() {
    const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
        open: false,
        title: "",
        message: "",
        confirmText: "Confirm",
        isDanger: false,
        onConfirm: null,
    });

    const showConfirm = (
        title: string,
        message: string,
        onConfirm: () => void,
        {
            confirmText = "Confirm",
            isDanger = false,
        }: { confirmText?: string; isDanger?: boolean } = {},
    ) => {
        setConfirmDialog({
            open: true,
            title,
            message,
            confirmText,
            isDanger,
            onConfirm,
        });
    };

    const closeConfirm = () =>
        setConfirmDialog((prev) => ({ ...prev, open: false, onConfirm: null }));

    return { confirmDialog, showConfirm, closeConfirm };
}