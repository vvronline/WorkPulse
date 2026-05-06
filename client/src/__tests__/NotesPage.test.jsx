import { render, screen, fireEvent } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

// ── Mocks ──────────────────────────────────────────────────────────────────────
vi.mock('../AuthContext', () => ({
    useAuth: () => ({ user: { id: 42, username: 'test', full_name: 'Test User', role: 'employee' } }),
}));

vi.mock('../api', () => ({
    getNotes: vi.fn().mockResolvedValue({ data: { data: null } }),
    saveNotes: vi.fn().mockResolvedValue({}),
}));

// Mock ConfirmDialog used inside NotesPage
vi.mock('../components/common/ConfirmDialog', () => ({
    default: ({ isOpen, title, onConfirm, onCancel }) =>
        isOpen ? (
            <div data-testid="confirm-dialog">
                <span>{title}</span>
                <button onClick={onConfirm}>Confirm</button>
                <button onClick={onCancel}>Cancel</button>
            </div>
        ) : null,
}));

// Stub the heavy NotesModal so tests render quickly
vi.mock('../components/DailyNotes/components/NotesModal', () => ({
    default: ({ store, embedded }) => (
        <div data-testid="notes-modal" data-embedded={String(embedded)}>
            <button onClick={store.handleNewPage}>New page</button>
            <button onClick={store.openHome}>Modal Home Btn</button>
        </div>
    ),
}));

// Stub NotesHome with a lightweight version that exposes its handlers
vi.mock('../components/DailyNotes/components/NotesHome', () => ({
    default: ({ store }) => (
        <div data-testid="notes-home">
            <h1>Welcome</h1>
            <p>Quick actions</p>
            <button onClick={() => store.handleNewFromTemplate('meeting')}>Meeting tile</button>
            <button onClick={() => store.handleOpenTodayJournal()}>Journal tile</button>
            <button onClick={() => store.openEditor('page-1')}>Open page 1</button>
        </div>
    ),
}));

// Mutable view state so tests can drive transitions
let currentView = 'home';
const mockSetEmbedded = vi.fn();
const mockHandleNewPage = vi.fn();
const mockHandleConfirmDelete = vi.fn();
const mockSetConfirmDelete = vi.fn();
const mockOpenHome = vi.fn(() => { currentView = 'home'; });
const mockOpenEditor = vi.fn(() => { currentView = 'editor'; });
const mockHandleNewFromTemplate = vi.fn(() => { currentView = 'editor'; });
const mockHandleOpenTodayJournal = vi.fn(() => { currentView = 'editor'; });

vi.mock('../components/DailyNotes/useNotesStore', () => ({
    useNotesStore: () => ({
        setEmbedded: mockSetEmbedded,
        handleNewPage: mockHandleNewPage,
        handleConfirmDelete: mockHandleConfirmDelete,
        setConfirmDelete: mockSetConfirmDelete,
        confirmDelete: false,
        activePage: { id: '1', title: 'My Notes' },
        pages: [],
        folders: [],
        maximized: false,
        setMaximized: vi.fn(),
        view: currentView,
        setView: vi.fn(),
        openHome: mockOpenHome,
        openEditor: mockOpenEditor,
        handleNewFromTemplate: mockHandleNewFromTemplate,
        handleOpenTodayJournal: mockHandleOpenTodayJournal,
    }),
}));

import NotesPage from '../pages/NotesPage';

function renderPage() {
    return render(
        <MemoryRouter>
            <NotesPage />
        </MemoryRouter>
    );
}

describe('NotesPage', () => {
    beforeEach(() => {
        currentView = 'home';
        mockSetEmbedded.mockReset();
        mockHandleNewPage.mockReset();
        mockSetConfirmDelete.mockReset();
        mockOpenHome.mockClear();
        mockOpenEditor.mockClear();
        mockHandleNewFromTemplate.mockClear();
        mockHandleOpenTodayJournal.mockClear();
    });

    test('renders without crashing on Home view by default', () => {
        renderPage();
        expect(screen.getByTestId('notes-home')).toBeInTheDocument();
    });

    test('does NOT render NotesModal when view is home', () => {
        renderPage();
        expect(screen.queryByTestId('notes-modal')).not.toBeInTheDocument();
    });

    test('renders NotesModal (embedded) when view is editor', () => {
        currentView = 'editor';
        renderPage();
        expect(screen.getByTestId('notes-modal')).toBeInTheDocument();
        expect(screen.getByTestId('notes-modal').dataset.embedded).toBe('true');
    });

    test('calls setEmbedded(true) on mount', () => {
        renderPage();
        expect(mockSetEmbedded).toHaveBeenCalledWith(true);
    });

    test('Home shows greeting and quick actions section', () => {
        renderPage();
        expect(screen.getByText(/welcome/i)).toBeInTheDocument();
        expect(screen.getByText(/quick actions/i)).toBeInTheDocument();
    });

    test('clicking a template tile invokes handleNewFromTemplate', () => {
        renderPage();
        fireEvent.click(screen.getByText('Meeting tile'));
        expect(mockHandleNewFromTemplate).toHaveBeenCalledWith('meeting');
    });

    test('clicking journal tile invokes handleOpenTodayJournal', () => {
        renderPage();
        fireEvent.click(screen.getByText('Journal tile'));
        expect(mockHandleOpenTodayJournal).toHaveBeenCalled();
    });

    test('clicking a page row invokes openEditor with the page id', () => {
        renderPage();
        fireEvent.click(screen.getByText('Open page 1'));
        expect(mockOpenEditor).toHaveBeenCalledWith('page-1');
    });

    test('ConfirmDialog is hidden when confirmDelete is false', () => {
        renderPage();
        expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });
});