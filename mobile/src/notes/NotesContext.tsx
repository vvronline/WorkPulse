/* ─────────────────────────────────────────────────────────
   NotesContext — shares a single useNotesStore instance across
   the Notes route group (Home dashboard + editor screen) so
   edits in one screen are reflected in the other and there's a
   single source of truth + autosave pipeline.
   ───────────────────────────────────────────────────────── */

import React, { createContext, useContext } from "react";
import { useNotesStore, type NotesStore } from "./useNotesStore";

const NotesContext = createContext<NotesStore | null>(null);

export function NotesProvider({ children }: { children: React.ReactNode }) {
  const store = useNotesStore();
  return <NotesContext.Provider value={store}>{children}</NotesContext.Provider>;
}

export function useNotes(): NotesStore {
  const ctx = useContext(NotesContext);
  if (!ctx) throw new Error("useNotes must be used within a NotesProvider");
  return ctx;
}