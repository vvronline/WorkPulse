import { useMemo } from 'react';
import { getWordCount, stripHtml } from './notesUtils';

/* Smart-folder filter ids understood by `folderFilter`. */
export const SMART_FOLDER_IDS = {
    UNTAGGED: 'view:untagged',
    TODOS: 'view:todos',
    TODAY: 'view:today',
    WEEK: 'view:week',
    LIKED: 'view:liked',
};

/* Apply a smart-folder filter to a list of pages. Returns the
   list unchanged if the filter id isn't a smart-folder id. */
function applySmartFolder(list, filterId, currentUserId) {
    if (!filterId || !filterId.startsWith('view:')) return list;
    const dayMs = 24 * 60 * 60 * 1000;
    switch (filterId) {
        case SMART_FOLDER_IDS.UNTAGGED:
            return list.filter(p => !p.tags || p.tags.length === 0);
        case SMART_FOLDER_IDS.TODOS:
            return list.filter(p => /data-list="(?:un)?checked"/.test(p.content || ''));
        case SMART_FOLDER_IDS.TODAY: {
            const cutoff = Date.now() - dayMs;
            return list.filter(p => new Date(p.updatedAt || 0).getTime() >= cutoff);
        }
        case SMART_FOLDER_IDS.WEEK: {
            const cutoff = Date.now() - 7 * dayMs;
            return list.filter(p => new Date(p.updatedAt || 0).getTime() >= cutoff);
        }
        case SMART_FOLDER_IDS.LIKED:
            return list.filter(p => {
                const likes = p.reactions?.['👍'];
                return Array.isArray(likes) && likes.includes(currentUserId);
            });
        default:
            return list;
    }
}

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
    currentUserId,
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
            if (folderFilter && folderFilter.startsWith('view:')) {
                list = applySmartFolder(list, folderFilter, currentUserId);
            } else if (folderFilter === 'none') {
                list = list.filter(p => !p.folderId);
            } else {
                list = list.filter(p => p.folderId === folderFilter);
            }
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
    }, [pages, showArchived, folderFilter, searchQuery, sortBy, currentUserId]);

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
