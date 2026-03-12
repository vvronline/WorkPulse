import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock API
const mockGetProfile = vi.fn();
const mockLogoutUser = vi.fn();
vi.mock('../api', () => ({
    getProfile: (...args) => mockGetProfile(...args),
    logoutUser: (...args) => mockLogoutUser(...args),
}));

// Must import after mocks
import { AuthProvider, useAuth } from '../AuthContext';

function TestConsumer() {
    const { user, isAuthenticated, saveAuth, logout } = useAuth();
    return (
        <div>
            <span data-testid="auth-status">{isAuthenticated ? 'yes' : 'no'}</span>
            <span data-testid="username">{user?.username || 'none'}</span>
            <button onClick={() => saveAuth({ id: 1, username: 'saved', role: 'employee' })}>save</button>
            <button onClick={() => logout()}>logout</button>
        </div>
    );
}

describe('AuthContext', () => {
    beforeEach(() => {
        localStorage.clear();
        mockGetProfile.mockReset();
        mockLogoutUser.mockReset();
    });

    test('starts unauthenticated when no cache', async () => {
        mockGetProfile.mockRejectedValue(new Error('no session'));
        render(
            <AuthProvider>
                <TestConsumer />
            </AuthProvider>
        );
        // No cached user → should not call getProfile
        await waitFor(() => {
            expect(screen.getByTestId('auth-status').textContent).toBe('no');
        });
    });

    test('verifies session when cached user exists', async () => {
        localStorage.setItem('user', JSON.stringify({ id: 1, username: 'cached' }));
        mockGetProfile.mockResolvedValue({ data: { id: 1, username: 'fresh', role: 'employee' } });

        render(
            <AuthProvider>
                <TestConsumer />
            </AuthProvider>
        );

        await waitFor(() => {
            expect(screen.getByTestId('username').textContent).toBe('fresh');
        });
        expect(mockGetProfile).toHaveBeenCalled();
    });

    test('clears user on 401 from profile', async () => {
        localStorage.setItem('user', JSON.stringify({ id: 1, username: 'old' }));
        mockGetProfile.mockRejectedValue({ response: { status: 401 } });

        render(
            <AuthProvider>
                <TestConsumer />
            </AuthProvider>
        );

        await waitFor(() => {
            expect(screen.getByTestId('auth-status').textContent).toBe('no');
        });
        expect(localStorage.getItem('user')).toBeNull();
    });

    test('saveAuth stores user and sets authenticated', async () => {
        const user = userEvent.setup();
        render(
            <AuthProvider>
                <TestConsumer />
            </AuthProvider>
        );

        await waitFor(() => expect(screen.getByTestId('auth-status')).toBeInTheDocument());
        await user.click(screen.getByText('save'));

        expect(screen.getByTestId('auth-status').textContent).toBe('yes');
        expect(screen.getByTestId('username').textContent).toBe('saved');
        // localStorage should contain only safe fields
        const cached = JSON.parse(localStorage.getItem('user'));
        expect(cached.username).toBe('saved');
        expect(cached.role).toBeUndefined(); // role is NOT safe-cached
    });

    test('logout clears user state', async () => {
        const user = userEvent.setup();
        mockLogoutUser.mockResolvedValue({});
        render(
            <AuthProvider>
                <TestConsumer />
            </AuthProvider>
        );

        // First save, then logout
        await waitFor(() => expect(screen.getByTestId('auth-status')).toBeInTheDocument());
        await user.click(screen.getByText('save'));
        expect(screen.getByTestId('auth-status').textContent).toBe('yes');

        await user.click(screen.getByText('logout'));
        await waitFor(() => {
            expect(screen.getByTestId('auth-status').textContent).toBe('no');
        });
        expect(localStorage.getItem('user')).toBeNull();
    });
});
