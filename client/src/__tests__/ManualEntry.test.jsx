import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('../AuthContext', () => ({
    useAuth: () => ({ user: { id: 1, username: 'testuser', role: 'employee' } }),
}));

vi.mock('../ThemeContext', () => ({
    useTheme: () => ({ theme: 'light' }),
}));

vi.mock('../UserStatusContext', () => ({
    useUserStatus: () => ({
        myStatus: 'available',
        myStatusText: null,
        manualStatus: null,
        setManualStatus: vi.fn(),
        setAutoStatus: vi.fn(),
        clearAutoStatus: vi.fn(),
        otherStatuses: {},
    }),
}));

const mockAddManualEntry = vi.fn();
const mockGetEntries = vi.fn();
const mockGetLeaves = vi.fn();
const mockGetStatus = vi.fn();
const mockGetLocalToday = vi.fn();
const mockGetManualEntryRequests = vi.fn();
const mockSubmitOvertimeRequest = vi.fn();
const mockGetOvertimeRequests = vi.fn();
const mockGetCurrentOrg = vi.fn();

vi.mock('../api', () => ({
    addManualEntry: (...args) => mockAddManualEntry(...args),
    updateManualEntry: vi.fn().mockResolvedValue({ data: { message: 'Updated' } }),
    deleteEntries: vi.fn().mockResolvedValue({ data: { message: 'Deleted' } }),
    getEntries: (...args) => mockGetEntries(...args),
    getLeaves: (...args) => mockGetLeaves(...args),
    getStatus: (...args) => mockGetStatus(...args),
    getLocalToday: (...args) => mockGetLocalToday(...args),
    getManualEntryRequests: (...args) => mockGetManualEntryRequests(...args),
    submitOvertimeRequest: (...args) => mockSubmitOvertimeRequest(...args),
    getOvertimeRequests: (...args) => mockGetOvertimeRequests(...args),
    getCurrentOrg: (...args) => mockGetCurrentOrg(...args),
}));

import ManualEntry from '../pages/ManualEntry';

function renderManualEntry() {
    return render(
        <MemoryRouter>
            <ManualEntry />
        </MemoryRouter>
    );
}

// ─── Rendering ────────────────────────────────────────────────────────────────

describe('ManualEntry page - rendering', () => {
    beforeEach(() => {
        mockGetManualEntryRequests.mockReset().mockResolvedValue({ data: [] });
        mockGetOvertimeRequests.mockReset().mockResolvedValue({ data: [] });
        mockGetCurrentOrg.mockReset().mockResolvedValue({ data: {} });
    });

    test('renders date input', async () => {
        const { container } = renderManualEntry();
        // Multiple date inputs exist (main form + overtime form)
        const dateInputs = container.querySelectorAll('input[type="date"]');
        expect(dateInputs.length).toBeGreaterThan(0);
        await waitFor(() => expect(mockGetManualEntryRequests).toHaveBeenCalled());
    });

    test('renders clock-in time field', async () => {
        renderManualEntry();
        // The clock-in field defaults to 09:00
        expect(screen.getByDisplayValue('09:00')).toBeInTheDocument();
        await waitFor(() => expect(mockGetManualEntryRequests).toHaveBeenCalled());
    });

    test('renders work mode selector', async () => {
        renderManualEntry();
        // Work mode options appear (office, remote, etc.)
        expect(screen.getByText(/office/i)).toBeInTheDocument();
        await waitFor(() => expect(mockGetManualEntryRequests).toHaveBeenCalled());
    });

    test('renders submit button', async () => {
        renderManualEntry();
        expect(screen.getByRole('button', { name: /save manual entry/i })).toBeInTheDocument();
        await waitFor(() => expect(mockGetManualEntryRequests).toHaveBeenCalled());
    });

    test('loads pending requests on mount', async () => {
        renderManualEntry();
        await waitFor(() => {
            expect(mockGetManualEntryRequests).toHaveBeenCalled();
            expect(mockGetOvertimeRequests).toHaveBeenCalled();
        });
    });
});

// ─── Form validation ──────────────────────────────────────────────────────────

describe('ManualEntry page - form validation', () => {
    beforeEach(() => {
        mockGetManualEntryRequests.mockReset().mockResolvedValue({ data: [] });
        mockGetOvertimeRequests.mockReset().mockResolvedValue({ data: [] });
        mockGetCurrentOrg.mockReset().mockResolvedValue({ data: {} });
        mockGetEntries.mockReset().mockResolvedValue({ data: [] });
        mockGetLeaves.mockReset().mockResolvedValue({ data: [] });
        mockGetStatus.mockReset().mockResolvedValue({ data: { state: 'logged_out' } });
        mockAddManualEntry.mockReset();
    });

    test('shows error when submitting without a date', async () => {
        const { container } = renderManualEntry();

        // Use fireEvent.submit to bypass native HTML5 required validation and trigger React handler
        const form = container.querySelector('form');
        fireEvent.submit(form);

        await waitFor(() => {
            expect(screen.getByText(/please fill in date/i)).toBeInTheDocument();
        });
    });
});

// ─── Pending requests display ─────────────────────────────────────────────────

describe('ManualEntry page - pending requests display', () => {
    beforeEach(() => {
        mockGetOvertimeRequests.mockReset().mockResolvedValue({ data: [] });
        mockGetCurrentOrg.mockReset().mockResolvedValue({ data: {} });
    });

    test('displays pending manual entry requests', async () => {
        mockGetManualEntryRequests.mockResolvedValue({
            data: [
                {
                    request_id: 1,
                    approval_status: 'pending',
                    metadata: { date: '2024-03-10', clock_in: '09:00', clock_out: '17:00', work_mode: 'office' },
                },
            ],
        });

        renderManualEntry();

        await waitFor(() => {
            // The approval status should appear
            expect(screen.getByText('pending')).toBeInTheDocument();
        });
    });

    test('shows empty state when no pending requests', async () => {
        mockGetManualEntryRequests.mockResolvedValue({ data: [] });

        renderManualEntry();

        await waitFor(() => {
            expect(mockGetManualEntryRequests).toHaveBeenCalled();
        });
        // No row items rendered for requests
        expect(screen.queryByTestId('pending-request-row')).not.toBeInTheDocument();
    });
});
