/* DailyNotes/index.jsx — thin orchestrator */
import React from 'react';
import ConfirmDialog from '../ConfirmDialog';
import { useNotesStore } from './useNotesStore';
import NotesHeader from './components/NotesHeader';
import NotesModal from './components/NotesModal';
import s from './index.module.css';

export default function DailyNotes({ userId }) {
  const store = useNotesStore(userId);
  if (!userId) return null;

  const {
    savedFlash,
    activePage,
    pages,
    maximized, setMaximized,
    confirmDelete, setConfirmDelete,
    handleConfirmDelete,
  } = store;

  return (
    <>
      <div className={s.root}>
        <NotesHeader
          activePage={activePage}
          pages={pages}
          savedFlash={savedFlash}
          onOpen={() => setMaximized(true)}
        />
      </div>

      {maximized && <NotesModal store={store} />}

      <ConfirmDialog
        isOpen={confirmDelete}
        title="Delete Page"
        message={`Are you sure you want to delete "${activePage?.title || 'this page'}"? This action cannot be undone.`}
        confirmText="Delete"
        cancelText="Cancel"
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmDelete(false)}
        isDanger
      />
    </>
  );
}
