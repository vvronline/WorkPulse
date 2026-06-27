import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/common/Toast";

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("../AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, username: "testuser", role: "employee" } }),
}));

vi.mock("../ThemeContext", () => ({
  useTheme: () => ({ theme: "light" }),
}));

const mockGetLeaves = vi.fn();
const mockAddLeave = vi.fn();
const mockAddLeavesBatch = vi.fn();
const mockWithdrawLeave = vi.fn();
const mockGetLeaveBalances = vi.fn();
const mockExportMyLeaves = vi.fn();
const mockGetLeavePolicies = vi.fn();

vi.mock("../api", () => ({
  getLeaves: (...args: any[]) => mockGetLeaves(...args),
  addLeave: (...args: any[]) => mockAddLeave(...args),
  addLeavesBatch: (...args: any[]) => mockAddLeavesBatch(...args),
  withdrawLeave: (...args: any[]) => mockWithdrawLeave(...args),
  getLeaveSummary: vi.fn().mockResolvedValue({ data: {} }),
  getLeaveBalances: (...args: any[]) => mockGetLeaveBalances(...args),
  exportMyLeaves: (...args: any[]) => mockExportMyLeaves(...args),
  getLeavePolicies: (...args: any[]) => mockGetLeavePolicies(...args),
}));

vi.mock("../components/ConfirmDialog", () => ({
  default: ({ isOpen, onConfirm, onCancel, message }: any) =>
    isOpen ? (
      <div data-testid="confirm-dialog">
        <p>{message}</p>
        <button onClick={onConfirm}>Confirm</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    ) : null,
}));

vi.mock("../components/ExportButton", () => ({
  default: () => <button>Export</button>,
}));

import Leaves from "../pages/Leaves";

function renderLeaves() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          <Leaves />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

// ─── Rendering ────────────────────────────────────────────────────────────────

describe("Leaves page - rendering", () => {
  beforeEach(() => {
    mockGetLeaves.mockReset().mockResolvedValue({ data: [] });
    mockGetLeaveBalances.mockReset().mockResolvedValue({ data: [] });
    mockGetLeavePolicies.mockReset().mockResolvedValue({ data: [] });
  });

  test("renders the page title", async () => {
    renderLeaves();
    expect(screen.getByText("Leave Management")).toBeInTheDocument();
    await waitFor(() => expect(mockGetLeaves).toHaveBeenCalled());
  });

  test("renders the leave request form", async () => {
    renderLeaves();
    expect(
      screen.getByRole("button", { name: /submit|request/i }),
    ).toBeInTheDocument();
    await waitFor(() => expect(mockGetLeaves).toHaveBeenCalled());
  });

  test("loads leave data on mount", async () => {
    renderLeaves();
    await waitFor(() => {
      expect(mockGetLeaves).toHaveBeenCalled();
    });
  });

  test("shows leave history table when leaves are loaded", async () => {
    mockGetLeaves.mockResolvedValue({
      data: [
        {
          id: 1,
          date: "2024-03-15",
          leave_type: "sick",
          duration: "full",
          status: "approved",
          reason: "Fever",
          reject_reason: null,
        },
      ],
    });

    renderLeaves();

    await waitFor(() => {
      // Leave type appears in history row
      expect(screen.getAllByText(/sick/i).length).toBeGreaterThan(0);
    });
  });
});

// ─── Form validation ──────────────────────────────────────────────────────────

describe("Leaves page - single leave submission", () => {
  beforeEach(() => {
    mockGetLeaves.mockReset().mockResolvedValue({ data: [] });
    mockGetLeaveBalances.mockReset().mockResolvedValue({ data: [] });
    mockGetLeavePolicies.mockReset().mockResolvedValue({ data: [] });
    mockAddLeave.mockReset();
  });

  test("shows error when date is not selected on submit", async () => {
    const { container } = renderLeaves();

    await waitFor(() => {
      expect(screen.getByText("Leave Management")).toBeInTheDocument();
    });

    // Use fireEvent.submit to bypass native HTML5 required validation
    const form = container.querySelector("form") as HTMLFormElement;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByText(/date is required/i)).toBeInTheDocument();
    });
  });

  test("submits leave request when date is selected", async () => {
    const { container } = renderLeaves();
    mockAddLeave.mockResolvedValue({
      data: { message: "Leave request submitted" },
    });

    await waitFor(() => {
      expect(screen.getByText("Leave Management")).toBeInTheDocument();
    });

    // Set date via DOM (no htmlFor on label)
    const dateInput = container.querySelector(
      'input[type="date"]',
    ) as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: "2024-12-20" } });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() => {
      expect(mockAddLeave).toHaveBeenCalledWith(
        expect.objectContaining({
          date: "2024-12-20",
        }),
      );
    });
  });
});

// ─── Leave history display ────────────────────────────────────────────────────

describe("Leaves page - leave history", () => {
  beforeEach(() => {
    mockGetLeaves.mockReset().mockResolvedValue({ data: [] });
    mockGetLeaveBalances.mockReset().mockResolvedValue({ data: [] });
    mockGetLeavePolicies.mockReset().mockResolvedValue({ data: [] });
  });

  test("shows empty state when no leaves", async () => {
    mockGetLeaves.mockResolvedValue({ data: [] });
    renderLeaves();

    await waitFor(() => {
      expect(mockGetLeaves).toHaveBeenCalled();
    });
    // Loading should be complete and no leave items shown
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  test("displays multiple leaves in history", async () => {
    mockGetLeaves.mockResolvedValue({
      data: [
        {
          id: 1,
          date: "2024-03-10",
          leave_type: "sick",
          duration: "full",
          status: "approved",
          reason: "Cold",
          reject_reason: null,
        },
        {
          id: 2,
          date: "2024-03-20",
          leave_type: "planned",
          duration: "full",
          status: "pending",
          reason: "Trip",
          reject_reason: null,
        },
      ],
    });

    renderLeaves();

    await waitFor(() => {
      expect(screen.getAllByText("Approved").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Pending").length).toBeGreaterThan(0);
    });
  });
});
