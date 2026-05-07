import React, { useEffect } from 'react';
import { useAuth } from '../AuthContext';
import ConfirmDialog from '../components/common/ConfirmDialog';
import { useNotesStore } from '../components/DailyNotes/useNotesStore';
import NotesModal from '../components/DailyNotes/components/NotesModal';
import NotesHome from '../components/DailyNotes/components/NotesHome';
import CommandPalette from '../components/DailyNotes/components/CommandPalette';
import PageSwitcherPopover from '../components/DailyNotes/components/PageSwitcherPopover';
import QuickCapture from '../components/DailyNotes/components/QuickCapture';
import PageLinkPicker from '../components/DailyNotes/components/PageLinkPicker';
import AudioRecorder from '../components/DailyNotes/components/AudioRecorder';
import AIAssistPanel from '../components/DailyNotes/components/AIAssistPanel';
import SmartSuggestionsPanel from '../components/DailyNotes/components/SmartSuggestionsPanel';
import ActivityFeedPanel from '../components/DailyNotes/components/ActivityFeedPanel';
import { preloadNotesAssets } from '../components/DailyNotes/notesAssetsSetup';
import '../components/DailyNotes/notesTokens.css';
import s from './NotesPage.module.css';

export default function NotesPage() {
  const { user } = useAuth();
  const store = useNotesStore(user?.id);

  useEffect(() => {
    store.setEmbedded(true);
    return () => store.setEmbedded(false);
  }, [store]);

  // Lazily load math + mermaid runtimes once when the Notes route mounts.
  useEffect(() => { preloadNotesAssets(); }, []);

  if (!user?.id) return null;

  const isEditor = store.view !== 'home';

  return (
    <div className={`notesScope ${s.page} ${isEditor ? s.pageEditor : ''}`}>
      {isEditor
        ? <NotesModal store={store} embedded />
        : <NotesHome store={store} />}

      {/* Floating overlays — rendered at page level so they work on
          both Home and Editor views (Ctrl+K must work everywhere). */}
      {store.paletteOpen && (
        <CommandPalette
          store={store}
          onClose={() => store.setPaletteOpen(false)}
        />
      )}
      {store.switcherOpen && (
        <PageSwitcherPopover
          store={store}
          onClose={() => store.setSwitcherOpen(false)}
        />
      )}
      {store.quickCaptureOpen && (
        <QuickCapture
          store={store}
          onClose={() => store.setQuickCaptureOpen(false)}
        />
      )}
      {store.pageLinkPicker && (
        <PageLinkPicker
          pages={store.pages}
          position={store.pageLinkPicker.position}
          onPick={store.insertPageLink}
          onCreate={store.insertPageLinkForNew}
          onClose={store.closePageLinkPicker}
        />
      )}
      {store.audioRecorder && (
        <AudioRecorder
          onSave={store.insertAudioRecording}
          onClose={store.closeAudioRecorder}
        />
      )}
      {store.aiPanelOpen && (
        <AIAssistPanel
          activePage={store.activePage}
          quillRef={store.modalQuillRef}
          onClose={() => store.setAiPanelOpen(false)}
        />
      )}
      {store.suggestionsPanelOpen && (
        <SmartSuggestionsPanel
          activePage={store.activePage}
          pages={store.pages}
          onSelectPage={(id) => { store.openEditor(id); store.setSuggestionsPanelOpen(false); }}
          onClose={() => store.setSuggestionsPanelOpen(false)}
        />
      )}
      {store.activityFeedOpen && (
        <ActivityFeedPanel
          pages={store.pages}
          onSelectPage={(id) => { store.openEditor(id); store.setActivityFeedOpen(false); }}
          onClose={() => store.setActivityFeedOpen(false)}
        />
      )}
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
