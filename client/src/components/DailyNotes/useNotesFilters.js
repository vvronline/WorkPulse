import { useMemo } from 'react';
import { getWordCount, stripHtml } from './notesUtils';

/**
 * Derives filtered/sorted page views from raw state.
 * Pure computation — no side-effects, no I/O.
 * Extracted from useNotesStore to keep derived-value logic separate.
 */
export function useNotesFilters({
    pages,
    activePageId,
    sortBy,
    showArchived,
    folderFilter,
    searchQuery,
    dropdownSearch,
}) {
    const activePage = pages.find(p => p.id === activePageId) || null;

    const wc = useMemo(
        () => activePage ? getWordCount(activePage.content) : { words: 0, chars: 0 },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [activePage?.content],
    );

    const processedPages = useMemo(() => {
        let list = pages.filter(p => showArchived ? p.archived : !p.archived);
        if (folderFilter !== 'all') {
            list = folderFilter === 'none'
                ? list.filter(p => !p.folderId)
                : list.filter(p => p.folderId === folderFilter);
        }
        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase();
            list = list.filter(p =>
                p.title.toLowerCase().includes(q) ||
                stripHtml(p.content).toLowerCase().includes(q) ||
                (p.tags || []).some(t => t.toLowerCase().includes(q)),
            );
        }
        return [...list].sort((a, b) => {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            switch (sortBy) {
                case 'name': return a.title.localeCompare(b.title);
                case 'created': return new Date(b.createdAt) - new Date(a.createdAt);
                case 'manual': return (a.sortOrder || 0) - (b.sortOrder || 0);
                default: return new Date(b.updatedAt) - new Date(a.updatedAt);
            }
        });
    }, [pages, showArchived, folderFilter, searchQuery, sortBy]);

    const dropdownPages = useMemo(() => {
        let list = pages.filter(p => !p.archived);
        if (dropdownSearch.trim()) {
            const q = dropdownSearch.toLowerCase();
            list = list.filter(p => p.title.toLowerCase().includes(q));
        }
        return [...list].sort((a, b) => {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            return new Date(b.updatedAt) - new Date(a.updatedAt);
        });
    }, [pages, dropdownSearch]);

    return { activePage, wc, processedPages, dropdownPages };
}
