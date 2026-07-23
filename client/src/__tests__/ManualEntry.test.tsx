import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("../AuthContext", () => ({
    useAuth: () => ({ user: { id: 1, username: "testuser", role: "employee" } }),
}));

vi.mock("../ThemeContext", () => ({
    useTheme: () => ({ theme: "light" }),
}));

// NOTE (status v2): ManualEntry no longer imports UserStatusContext —
// tracker events don't write status. No mock needed.

const mockAddManualEntry = vi.fn();
const mockUpdateManualEntry = vi.fn();
const mockGetEntries = vi.fn();
const mockGetLeaves = vi.fn();
const mockGetStatus = vi.fn();
const mockGetLocalToday = vi.fn();
const mockGetManualEntryRequests = vi.fn();
const mockSubmitOvertimeRequest = vi.fn();
const mockGetOvertimeRequests = vi.fn();
const mockGetCurrentOrg = vi.fn();

vi.mock("../api", () => ({
    addManualEntry: (...args: any[]) => mockAddManualEntry(...args),
    updateManualEntry: (...args: any[]) => mockUpdateManualEntry(...args),
    deleteEntries: vi.fn().mockResolvedValue({ data: { message: "Deleted" } }),
    getEntries: (...args: any[]) => mockGetEntries(...args),
    getLeaves: (...args: any[]) => mockGetLeaves(...args),
    getStatus: (...args: any[]) => mockGetStatus(...args),
    getLocalToday: (...args: any[]) => mockGetLocalToday(...args),
    getManualEntryRequests: (...args: any[]) => mockGetManualEntryRequests(...args),
    submitOvertimeRequest: (...args: any[]) => mockSubmitOvertimeRequest(...args),
    getOvertimeRequests: (...args: any[]) => mockGetOvertimeRequests(...args),
    getCurrentOrg: (...args: any[]) => mockGetCurrentOrg(...args),
}));

import ManualEntry from "../pages/ManualEntry";

function renderManualEntry() {
    return render(
        <MemoryRouter>
            <ManualEntry />
        </MemoryRouter>
    );
}

// ─── Rendering ────────────────────────────────────────────────────────────────

describe("ManualEntry page - rendering", () => {
    beforeEach(() => {
        mockGetManualEntryRequests.mockReset().mockResolvedValue({ data: [] });
        mockGetOvertimeRequests.mockReset().mockResolvedValue({ data: [] });
        mockGetCurrentOrg.mockReset().mockResolvedValue({ data: {} });
    });

    test("renders date input", async () => {
        const { container } = renderManualEntry();
        // Multiple date inputs exist (main form + overtime form)
        const dateInputs = container.querySelectorAll('input[type="date"]');
        expect(dateInputs.length).toBeGreaterThan(0);
        await waitFor(() => expect(mockGetManualEntryRequests).toHaveBeenCalled());
    });

    test("renders clock-in time field", async () => {
        renderManualEntry();
        // The clock-in field defaults to 09:00
        expect(screen.getByDisplayValue("09:00")).toBeInTheDocument();
        await waitFor(() => expect(mockGetManualEntryRequests).toHaveBeenCalled());
    });

    test("renders work mode selector", async () => {
        renderManualEntry();
        // Work mode options appear (office, remote, etc.)
        expect(screen.getByText(/office/i)).toBeInTheDocument();
        await waitFor(() => expect(mockGetManualEntryRequests).toHaveBeenCalled());
    });

    test("renders submit button", async () => {
        renderManualEntry();
        expect(screen.getByRole("button", { name: /save manual entry/i })).toBeInTheDocument();
        await waitFor(() => expect(mockGetManualEntryRequests).toHaveBeenCalled());
    });

    test("loads pending requests on mount", async () => {
        renderManualEntry();
        await waitFor(() => {
            expect(mockGetManualEntryRequests).toHaveBeenCalled();
            expect(mockGetOvertimeRequests).toHaveBeenCalled();
        });
    });
});

// ─── Form validation ──────────────────────────────────────────────────────────

describe("ManualEntry page - form validation", () => {
    beforeEach(() => {
        mockGetManualEntryRequests.mockReset().mockResolvedValue({ data: [] });
        mockGetOvertimeRequests.mockReset().mockResolvedValue({ data: [] });
        mockGetCurrentOrg.mockReset().mockResolvedValue({ data: {} });
        mockGetEntries.mockReset().mockResolvedValue({ data: [] });
        mockGetLeaves.mockReset().mockResolvedValue({ data: [] });
        mockGetStatus.mockReset().mockResolvedValue({ data: { state: "logged_out" } });
        mockAddManualEntry.mockReset();
    });

    test("shows error when submitting without a date", async () => {
        const { container } = renderManualEntry();

        // Use fireEvent.submit to bypass native HTML5 required validation and trigger React handler
        const form = container.querySelector("form") as HTMLFormElement;
        fireEvent.submit(form);

        await waitFor(() => {
            expect(screen.getByText(/please fill in date/i)).toBeInTheDocument();
        });
    });
});

// ─── Pending requests display ─────────────────────────────────────────────────

describe("ManualEntry page - pending requests display", () => {
    beforeEach(() => {
        mockGetOvertimeRequests.mockReset().mockResolvedValue({ data: [] });
        mockGetCurrentOrg.mockReset().mockResolvedValue({ data: {} });
    });

    test("displays pending manual entry requests", async () => {
        mockGetManualEntryRequests.mockResolvedValue({
            data: [
                {
                    request_id: 1,
                    approval_status: "pending",
                    metadata: { date: "2024-03-10", clock_in: "09:00", clock_out: "17:00", work_mode: "office" },
                },
            ],
        });

        renderManualEntry();

        await waitFor(() => {
            // The approval status should appear
            expect(screen.getByText("pending")).toBeInTheDocument();
        });
    });

    test("shows empty state when no pending requests", async () => {
        mockGetManualEntryRequests.mockResolvedValue({ data: [] });

        renderManualEntry();

        await waitFor(() => {
            expect(mockGetManualEntryRequests).toHaveBeenCalled();
        });
        // No row items rendered for requests
        expect(screen.queryByTestId("pending-request-row")).not.toBeInTheDocument();
    });
});

// -- Non-destructive edit workflow ------------------------------------------

describe("ManualEntry page - edit approval workflow", () => {
    beforeEach(() => {
        mockGetManualEntryRequests.mockReset().mockResolvedValue({ data: [] });
        mockGetOvertimeRequests.mockReset().mockResolvedValue({ data: [] });
        mockGetCurrentOrg.mockReset().mockResolvedValue({ data: {} });
        mockGetLeaves.mockReset().mockResolvedValue({ data: [] });
        mockGetStatus.mockReset().mockResolvedValue({ data: { state: "logged_out" } });
        mockAddManualEntry.mockReset();
        mockUpdateManualEntry.mockReset();
        mockGetLocalToday.mockReset().mockReturnValue("2024-03-20");
        // A recorded day with an approved clock-in / clock-out pair.
        mockGetEntries.mockReset().mockResolvedValue({
            data: [
                { entry_type: "clock_in", timestamp: "2024-03-10T09:00:00.000Z", work_mode: "office", is_manual: false, approval_status: "approved" },
                { entry_type: "clock_out", timestamp: "2024-03-10T17:00:00.000Z", is_manual: false, approval_status: "approved" },
            ],
        });
    });

    async function enterEditMode() {
        const { container } = renderManualEntry();
        const dateInput = container.querySelector('input[type="date"]') as HTMLInputElement;
        fireEvent.change(dateInput, { target: { value: "2024-03-10" } });
        // Wait for existing entries to load and the edit button to appear.
        const editBtn = await screen.findByText(/Edit These Entries/i);
        fireEvent.click(editBtn);
        return container;
    }

    test("shows the manager-approval banner when editing a recorded day", async () => {
        await enterEditMode();
        expect(
            await screen.findByText(/require manager approval/i),
        ).toBeInTheDocument();
    });

    test("submitting an edit surfaces the server's approval message", async () => {
        mockUpdateManualEntry.mockResolvedValue({
            data: {
                message: "Your edit was submitted for manager approval. Your original entries stay in place until it is approved.",
                status: "pending",
                needsApproval: true,
            },
        });
        const container = await enterEditMode();
        const form = container.querySelector("form") as HTMLFormElement;
        fireEvent.submit(form);
        await waitFor(() => {
            expect(mockUpdateManualEntry).toHaveBeenCalledWith("2024-03-10", expect.any(Object));
        });
        expect(
            await screen.findByText(/submitted for manager approval/i),
        ).toBeInTheDocument();
    });
});
