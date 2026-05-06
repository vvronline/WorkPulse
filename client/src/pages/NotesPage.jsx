import React, { useEffect } from 'react';
import { useAuth } from '../AuthContext';
import ConfirmDialog from '../components/common/ConfirmDialog';
import { useNotesStore } from '../components/DailyNotes/useNotesStore';
import NotesModal from '../components/DailyNotes/components/NotesModal';
import NotesHome from '../components/DailyNotes/components/NotesHome';
import s from './NotesPage.module.css';

export default function NotesPage() {
  const { user } = useAuth();
  const store = useNotesStore(user?.id);

  useEffect(() => {
    store.setEmbedded(true);
    return () => store.setEmbedded(false);
  }, [store]);

  if (!user?.id) return null;

  const isEditor = store.view !== 'home';

  return (
    <div className={`${s.page} ${isEditor ? s.pageEditor : ''}`}>
      {isEditor
        ? <NotesModal store={store} embedded />
        : <NotesHome store={store} />}

      <ConfirmDialog
        isOpen={store.confirmDelete}
        title="Delete Page"
        message={`Are you sure you want to delete "${store.activePage?.title || 'this page'}"? This action cannot be undone.`}
        confirmText="Delete"
        cancelText="Cancel"
        onConfirm={store.handleConfirmDelete}
        onCancel={() => store.setConfirmDelete(false)}
        isDanger
      />
    </div>
  );
}