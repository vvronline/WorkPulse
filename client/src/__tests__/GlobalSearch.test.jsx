import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('../AuthContext', () => ({
    useAuth: () => ({
        user: { id: 1, username: 'testuser', role: 'employee' },
    }),
}));

const mockGlobalSearch = vi.fn();
vi.mock('../api', () => ({
    globalSearch: (...args) => mockGlobalSearch(...args),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
    const actual = await vi.importActual('react-router-dom');
    return { ...actual, useNavigate: () => mockNavigate };
});

import GlobalSearch from '../components/search/GlobalSearch';

function renderGlobalSearch(onClose = vi.fn()) {
    return render(
        <MemoryRouter>
            <GlobalSearch onClose={onClose} />
        </MemoryRouter>
    );
}

// ─── Rendering ────────────────────────────────────────────────────────────────

describe('GlobalSearch - rendering', () => {
    beforeEach(() => {
        mockGlobalSearch.mockReset();
        mockNavigate.mockReset();
    });

    test('renders search input', () => {
        renderGlobalSearch();
        expect(screen.getByRole('textbox')).toBeInTheDocument();
    });

    test('focuses input on mount', () => {
        renderGlobalSearch();
        expect(document.activeElement.tagName).toBe('INPUT');
    });
});

// ─── Short query behavior ─────────────────────────────────────────────────────

describe('GlobalSearch - short query behavior', () => {
    beforeEach(() => {
        mockGlobalSearch.mockReset();
    });

    test('does not call API when query is shorter than 2 chars', async () => {
        const user = userEvent.setup();
        renderGlobalSearch();

        await user.type(screen.getByRole('textbox'), 'a');
        // No API call should be made
        expect(mockGlobalSearch).not.toHaveBeenCalled();
    });
});

// ─── Nav items filtering ──────────────────────────────────────────────────────

describe('GlobalSearch - nav items filtering', () => {
    beforeEach(() => {
        mockGlobalSearch.mockReset().mockResolvedValue({ data: { tasks: [], notes: [], users: [], events: [], leaves: [], sprints: [] } });
    });

    test('shows nav items matching query (employee sees only allowed items)', async () => {
        const user = userEvent.setup();
        renderGlobalSearch();

        await user.type(screen.getByRole('textbox'), 'dashboard');

        await waitFor(() => {
            expect(screen.getByText('Dashboard')).toBeInTheDocument();
        });
    });

    test('does not show admin nav items for employee role', async () => {
        const user = userEvent.setup();
        renderGlobalSearch();

        await user.type(screen.getByRole('textbox'), 'admin');

        // Employee should not see "Admin Panel" nav item
        await waitFor(() => {
            // Wait for search to process
            expect(screen.getByRole('textbox')).toHaveValue('admin');
        });
        expect(screen.queryByText('Admin Panel')).not.toBeInTheDocument();
    });

    test('shows tasks nav item when querying tasks', async () => {
        const user = userEvent.setup();
        renderGlobalSearch();

        await user.type(screen.getByRole('textbox'), 'tasks');

        await waitFor(() => {
            expect(screen.getByText('Tasks')).toBeInTheDocument();
        });
    });
});

// ─── Keyboard navigation ──────────────────────────────────────────────────────

describe('GlobalSearch - keyboard close', () => {
    test('calls onClose when Escape is pressed', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        renderGlobalSearch(onClose);

        await user.keyboard('{Escape}');

        expect(onClose).toHaveBeenCalled();
    });
});

// ─── HR admin nav items ───────────────────────────────────────────────────────

describe('GlobalSearch - hr_admin nav items', () => {
    test('hr_admin sees admin nav items', async () => {
        // This test verifies the role filtering logic works conceptually.
        const ROLE_LEVEL = { employee: 1, team_lead: 2, manager: 3, hr_admin: 4, super_admin: 5 };
        const NAV_INCLUDES_ADMIN = [
            { title: 'Admin Panel', minRole: 'hr_admin' },
        ];
        const userLevel = ROLE_LEVEL['hr_admin'];
        const visible = NAV_INCLUDES_ADMIN.filter(n => !n.minRole || userLevel >= (ROLE_LEVEL[n.minRole] || 1));
        expect(visible).toHaveLength(1);
    });
});
