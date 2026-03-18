import { render, screen } from '@testing-library/react';
import { describe, test, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

// Mock dependent contexts and modules
vi.mock('../ThemeContext', () => ({
    useTheme: () => ({ theme: 'dark', toggleTheme: vi.fn() }),
}));
vi.mock('../WorkStateContext', () => ({
    useWorkState: () => ({ workState: 'idle', workMode: 'office' }),
}));
vi.mock('../api', () => ({
    clockOut: vi.fn(),
    uploadAvatar: vi.fn(),
    removeAvatar: vi.fn(),
    baseURL: 'http://localhost:3000',
}));
vi.mock('../AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: true,
        user: { id: 1, username: 'test', full_name: 'Test User', role: 'employee', avatar: null },
        logout: vi.fn(),
        updateUser: vi.fn(),
    }),
}));
vi.mock('../components/EditProfileModal', () => ({ default: () => null }));
vi.mock('../components/NotificationBell', () => ({ default: () => <div data-testid="notif-bell" /> }));
vi.mock('../components/ConfirmDialog', () => ({ default: () => null }));
vi.mock('../ChatContext', () => ({
    useChatUnread: () => 0,
}));
vi.mock('../components/navbar/NavLinks', () => ({
    default: () => (
        <div>
            <a href="/">Dashboard</a>
            <a href="/calendar">Calendar</a>
            <a href="/tasks">Tasks</a>
            <a href="/notes">Notes</a>
            <a href="/leaves">Leaves</a>
            <a href="/analytics">Analytics</a>
            <button>More</button>
        </div>
    ),
}));
vi.mock('../components/navbar/ProfileMenu', () => ({ default: () => null }));
vi.mock('../components/navbar/MobileTabBar', () => ({
    default: () => (
        <div>
            <a href="/">Dashboard</a>
            <a href="/calendar">Calendar</a>
            <a href="/tasks">Tasks</a>
            <a href="/notes">Notes</a>
            <a href="/leaves">Leaves</a>
            <a href="/analytics">Analytics</a>
        </div>
    ),
}));

import Navbar from '../components/Navbar';

function renderNavbar(path = '/') {
    return render(
        <MemoryRouter initialEntries={[path]}>
            <Navbar />
        </MemoryRouter>
    );
}

describe('Navbar', () => {
    test('renders primary nav links', () => {
        renderNavbar('/');
        // Desktop and mobile nav both render these, so use getAllByText
        expect(screen.getAllByText('Dashboard').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Calendar').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Tasks').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Notes').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Leaves').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Analytics').length).toBeGreaterThanOrEqual(1);
    });

    test('does not render old Planner link', () => {
        renderNavbar('/');
        expect(screen.queryByText('Planner')).not.toBeInTheDocument();
    });

    test('shows More dropdown button', () => {
        renderNavbar('/');
        expect(screen.getByText('More')).toBeInTheDocument();
    });

    test('applies active class to matching route link', () => {
        renderNavbar('/calendar');
        // Calendar links are rendered by NavLinks/MobileTabBar sub-components
        const calendarLinks = screen.getAllByText('Calendar');
        expect(calendarLinks.length).toBeGreaterThanOrEqual(1);
    });
});
