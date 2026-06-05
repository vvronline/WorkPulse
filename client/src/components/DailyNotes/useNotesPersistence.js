import { useState, useEffect, useRef, useCallback } from 'react';
import { getNotes, saveNotes } from '../../api';
import { newPage, newFolder, migratePageModel } from './notesUtils';

/**
 * Owns the server-persisted state for notes: pages, folders, active page,
 * sort order, and the save/load/flush lifecycle.
 * Extracted from useNotesStore to separate persistence concerns from UI state.
 */
export function useNotesPersistence(userId) {
    const [pages, setPages] = useState([]);
    const [folders, setFolders] = useState([]);
    const [todos, setTodos] = useState([]);
    const [activePageId, setActivePageId] = useState(null);
    const [sortBy, setSortBy] = useState('modified');
    const [savedFlash, setSavedFlash] = useState(false);

    const saveTimerRef = useRef(null);

    // Snapshot refs — used in async callbacks & unmount flush
    const latestPages = useRef([]);
    const latestFolders = useRef([]);
    const latestTodos = useRef([]);
    const latestActiveId = useRef(null);
    const latestSortBy = useRef('modified');
    const userIdRef = useRef(userId);

    useEffect(() => { latestPages.current = pages; }, [pages]);
    useEffect(() => { latestFolders.current = folders; }, [folders]);
    useEffect(() => { latestTodos.current = todos; }, [todos]);
    useEffect(() => { latestActiveId.current = activePageId; }, [activePageId]);
    useEffect(() => { latestSortBy.current = sortBy; }, [sortBy]);
    useEffect(() => { userIdRef.current = userId; }, [userId]);

    const saveToServer = useCallback(async (data) => {
        try {
            await saveNotes(data);
        } catch (e) {
            console.error('Failed to save notes:', e);
            if (userIdRef.current)
                localStorage.setItem('workpulse-notes-' + userIdRef.current, JSON.stringify(data));
        }
    }, []);

    const persist = useCallback((pgs, flds, aid, sort, tds) => {
        saveToServer({
            pages: pgs ?? latestPages.current,
            folders: flds ?? latestFolders.current,
            todos: tds ?? latestTodos.current,
            activePageId: aid ?? latestActiveId.current,
            sortBy: sort ?? latestSortBy.current,
        });
    }, [saveToServer]);

    const scheduleAutoSave = useCallback((pgs, flds, aid) => {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            persist(pgs, flds, aid);
            setSavedFlash(true);
            setTimeout(() => setSavedFlash(false), 2000);
        }, 10000);
    }, [persist]);

    // Load on mount
    useEffect(() => {
        if (!userId) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await getNotes();
                if (cancelled) return;
                if (res.data?.data) {
                    const nb = res.data.data;
                    const pgs = (nb.pages || []).map(migratePageModel);
                    const flds = nb.folders || [];
                    if (pgs.length > 0) {
                        setPages(pgs);
                        setFolders(flds);
                        setTodos(Array.isArray(nb.todos) ? nb.todos : []);
                        setActivePageId(nb.activePageId || pgs[0]?.id);
                        setSortBy(nb.sortBy || 'modified');
                        return;
                    }
                }
            } catch (e) {
                console.warn('Could not load from server, checking localStorage:', e.message);
            }
            try {
                const raw = localStorage.getItem('workpulse-notes-' + userId);
                if (raw) {
                    const nb = JSON.parse(raw);
                    if (nb.pages?.length > 0) {
                        const pgs = nb.pages.map(migratePageModel);
                        const flds = nb.folders || [];
                        const tds = Array.isArray(nb.todos) ? nb.todos : [];
                        if (!cancelled) {
                            setPages(pgs);
                            setFolders(flds);
                            setTodos(tds);
                            setActivePageId(nb.activePageId || pgs[0]?.id);
                            setSortBy(nb.sortBy || 'modified');
                            saveToServer({ pages: pgs, folders: flds, todos: tds, activePageId: nb.activePageId || pgs[0]?.id, sortBy: nb.sortBy || 'modified' });
                        }
                        return;
                    }
                }
            } catch { /* ignore */ }
            if (!cancelled) {
                const first = newPage('My Notes');
                setPages([first]);
                setActivePageId(first.id);
            }
        })();
        return () => { cancelled = true; };
    }, [userId, saveToServer]);

    // Flush on unmount / page unload
    useEffect(() => {
        const flush = () => {
            clearTimeout(saveTimerRef.current);
            if (userIdRef.current && latestPages.current.length > 0) {
                const data = {
                    pages: latestPages.current, folders: latestFolders.current,
                    todos: latestTodos.current,
                    activePageId: latestActiveId.current, sortBy: latestSortBy.current,
                };
                localStorage.setItem('workpulse-notes-' + userIdRef.current, JSON.stringify(data));
                saveToServer(data).catch(() => { });
            }
        };
        window.addEventListener('beforeunload', flush);
        return () => { window.removeEventListener('beforeunload', flush); flush(); };
    }, [saveToServer]);

    return {
        pages, setPages,
        folders, setFolders,
        todos, setTodos,
        activePageId, setActivePageId,
        sortBy, setSortBy,
        savedFlash,
        persist,
        scheduleAutoSave,
        saveTimerRef,
    };
}
