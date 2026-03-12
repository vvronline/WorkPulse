import { render, screen, waitFor } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

// ── Mocks ──────────────────────────────────────────────────────────────────────
vi.mock('../AuthContext', () => ({
    useAuth: () => ({ user: { id: 1, username: 'test', full_name: 'Test User', role: 'employee' } }),
}));

const mockGetTasks = vi.fn();
vi.mock('../api', () => ({
    getTasks: (...args) => mockGetTasks(...args),
    getLocalToday: () => '2026-03-12',
}));

// Calendar component is complex — render a stub so tests stay fast
vi.mock('../components/calendar/Calendar', () => ({
    default: ({ tasks }) => (
        <div data-testid="calendar-stub">
            <span data-testid="task-count">{tasks.length}</span>
        </div>
    ),
}));

import CalendarPage from '../pages/CalendarPage';

function renderPage() {
    return render(
        <MemoryRouter>
            <CalendarPage />
        </MemoryRouter>
    );
}

describe('CalendarPage', () => {
    beforeEach(() => {
        mockGetTasks.mockReset();
    });

    test('renders page heading', () => {
        mockGetTasks.mockResolvedValue({ data: { tasks: [] } });
        renderPage();
        expect(screen.getByText(/calendar/i)).toBeInTheDocument();
    });

    test('renders subheading text', () => {
        mockGetTasks.mockResolvedValue({ data: { tasks: [] } });
        renderPage();
        expect(screen.getByText(/schedule events/i)).toBeInTheDocument();
    });

    test('renders Calendar component', () => {
        mockGetTasks.mockResolvedValue({ data: { tasks: [] } });
        renderPage();
        expect(screen.getByTestId('calendar-stub')).toBeInTheDocument();
    });

    test('fetches tasks on mount and passes them to Calendar', async () => {
        const tasks = [
            { id: 1, title: 'Fix bug', status: 'pending', priority: 'high' },
            { id: 2, title: 'Write docs', status: 'done', priority: 'low' },
        ];
        mockGetTasks.mockResolvedValue({ data: { tasks } });

        renderPage();

        await waitFor(() => {
            expect(screen.getByTestId('task-count').textContent).toBe('2');
        });
        expect(mockGetTasks).toHaveBeenCalledWith(
            '2026-03-12',
            expect.objectContaining({ scope: 'personal', include_due: '1' })
        );
    });

    test('renders with empty task list when fetch fails', async () => {
        mockGetTasks.mockRejectedValue(new Error('Network error'));

        renderPage();

        // Should still render the calendar — tasks just stay empty
        await waitFor(() => {
            expect(screen.getByTestId('task-count').textContent).toBe('0');
        });
    });
});
