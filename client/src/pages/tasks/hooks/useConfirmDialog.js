import { useState } from 'react';

export function useConfirmDialog() {
  const [confirmDialog, setConfirmDialog] = useState({
    open: false, title: '', message: '', confirmText: 'Confirm', isDanger: false, onConfirm: null,
  });

  const showConfirm = (title, message, onConfirm, { confirmText = 'Confirm', isDanger = false } = {}) => {
    setConfirmDialog({ open: true, title, message, confirmText, isDanger, onConfirm });
  };

  const closeConfirm = () =>
    setConfirmDialog((prev) => ({ ...prev, open: false, onConfirm: null }));

  return { confirmDialog, showConfirm, closeConfirm };
}
