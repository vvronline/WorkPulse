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
        user: { id: 1, username: 'test', full_name: 'Test User', role: 'employee', avatar: null },
        logout: vi.fn(),
        updateUser: vi.fn(),
    }),
}));
vi.mock('../components/EditProfileModal', () => ({ default: () => null }));
vi.mock('../components/NotificationBell', () => ({ default: () => <div data-testid="notif-bell" /> }));
vi.mock('../components/ConfirmDialog', () => ({ default: () => null }));

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
        // At least one Calendar link should carry the active class
        const calendarLinks = screen.getAllByText('Calendar');
        const anyActive = calendarLinks.some(el => el.closest('a')?.className.includes('active'));
        expect(anyActive).toBe(true);
    });
});
