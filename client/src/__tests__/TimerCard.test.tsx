import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, test, expect, vi, beforeEach } from "vitest";
import TimerCard from "../pages/dashboard/TimerCard";

// ── Default props ──────────────────────────────────────────────────────────────

const CIRCUMFERENCE = 2 * Math.PI * 90;

const defaultProps: any = {
    state: "logged_out",
    isWeekend: false,
    workMode: "office",
    setWorkMode: vi.fn(),
    liveFloorSec: 0,
    liveBreakSec: 0,
    breakCount: 0,
    floorMinutes: 0,
    progressPercent: 0,
    progressColor: { color: "var(--danger)", glow: "var(--danger-glow)" },
    radius: 90,
    circumference: CIRCUMFERENCE,
    strokeDashoffset: CIRCUMFERENCE,
    completedTarget: false,
    completedMandatory: false,
    remaining: 480,
    mandatoryRemaining: 480,
    estimatedClockOut: null,
    overtimeMinutes: 0,
    targetMinutes: 480,
    dailyTargetMet: false,
    onOvertimeRequest: vi.fn(),
    weeklyData: null,
    actionLoading: "",
    error: "",
    handleClockIn: vi.fn(),
    handleBreakStart: vi.fn(),
    handleBreakEnd: vi.fn(),
    onClockOut: vi.fn(),
};

function renderTimerCard(props: any = {}) {
    return render(<TimerCard {...defaultProps} {...props} />);
}

// ── Logged-out state ───────────────────────────────────────────────────────────

describe("TimerCard — logged_out state", () => {
    beforeEach(() => {
        defaultProps.handleClockIn.mockReset();
        defaultProps.onOvertimeRequest.mockReset();
    });

    test("shows Login button when target not met", () => {
        renderTimerCard({ state: "logged_out", dailyTargetMet: false });
        expect(screen.getByRole("button", { name: /login/i })).toBeInTheDocument();
        expect(screen.queryByText(/daily target complete/i)).not.toBeInTheDocument();
    });

    test("shows work-mode toggle when target not met", () => {
        renderTimerCard({ state: "logged_out", dailyTargetMet: false });
        expect(screen.getByRole("button", { name: /office/i })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /remote/i })).toBeInTheDocument();
    });

    test("calls handleClockIn when Login is clicked", async () => {
        const handleClockIn = vi.fn();
        renderTimerCard({ state: "logged_out", dailyTargetMet: false, handleClockIn });
        await userEvent.click(screen.getByRole("button", { name: /login/i }));
        expect(handleClockIn).toHaveBeenCalled();
    });

    test("does not show Logout button when logged out", () => {
        renderTimerCard({ state: "logged_out", dailyTargetMet: false });
        expect(screen.queryByRole("button", { name: /^logout$/i })).not.toBeInTheDocument();
    });
});

// ── Daily target met state ─────────────────────────────────────────────────────

describe("TimerCard — daily target met", () => {
    beforeEach(() => {
        defaultProps.onOvertimeRequest.mockReset();
    });

    test("shows daily target complete message", () => {
        renderTimerCard({ state: "logged_out", dailyTargetMet: true });
        expect(screen.getByText(/daily target complete/i)).toBeInTheDocument();
    });

    test("shows Apply for Overtime button", () => {
        renderTimerCard({ state: "logged_out", dailyTargetMet: true });
        expect(screen.getByRole("button", { name: /apply for overtime/i })).toBeInTheDocument();
    });

    test("does not show Login button when daily target met", () => {
        renderTimerCard({ state: "logged_out", dailyTargetMet: true });
        expect(screen.queryByRole("button", { name: /^▶ login$/i })).not.toBeInTheDocument();
    });

    test("calls onOvertimeRequest when Apply for Overtime is clicked", async () => {
        const onOvertimeRequest = vi.fn();
        renderTimerCard({ state: "logged_out", dailyTargetMet: true, onOvertimeRequest });
        await userEvent.click(screen.getByRole("button", { name: /apply for overtime/i }));
        expect(onOvertimeRequest).toHaveBeenCalled();
    });

    test("shows go-home banner when completedTarget is true", () => {
        renderTimerCard({
            state: "logged_out",
            dailyTargetMet: true,
            completedTarget: true,
            floorMinutes: 540,
        });
        expect(screen.getByText(/daily target complete! great work/i)).toBeInTheDocument();
    });
});

// ── on_floor state ─────────────────────────────────────────────────────────────

describe("TimerCard — on_floor state", () => {
    test("shows Break and Logout buttons", () => {
        renderTimerCard({ state: "on_floor", liveFloorSec: 3600 });
        expect(screen.getByRole("button", { name: /break/i })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /logout/i })).toBeInTheDocument();
    });

    test("does not show Login button when on floor", () => {
        renderTimerCard({ state: "on_floor", liveFloorSec: 3600 });
        expect(screen.queryByRole("button", { name: /login/i })).not.toBeInTheDocument();
    });

    test("calls onClockOut when Logout is clicked", async () => {
        const onClockOut = vi.fn();
        renderTimerCard({ state: "on_floor", liveFloorSec: 3600, onClockOut });
        await userEvent.click(screen.getByRole("button", { name: /logout/i }));
        expect(onClockOut).toHaveBeenCalled();
    });

    test("shows ETA banner with dynamic target hours", () => {
        const { container } = renderTimerCard({
            state: "on_floor",
            estimatedClockOut: "6:00 PM",
            targetMinutes: 480,
        });
        expect(container.textContent).toContain("8hr by");
        expect(screen.getByText("6:00 PM")).toBeInTheDocument();
    });

    test("shows overtime banner when overtime has accumulated", () => {
        renderTimerCard({ state: "on_floor", overtimeMinutes: 30 });
        expect(screen.getByText(/overtime/i)).toBeInTheDocument();
    });

    test("buttons are disabled while action is loading", () => {
        renderTimerCard({ state: "on_floor", liveFloorSec: 3600, actionLoading: "clockOut" });
        const logoutBtn = screen.getByRole("button", { name: /logout/i });
        expect(logoutBtn).toBeDisabled();
    });
});

// ── on_break state ─────────────────────────────────────────────────────────────

describe("TimerCard — on_break state", () => {
    test("shows Resume and Logout buttons", () => {
        renderTimerCard({ state: "on_break", liveFloorSec: 3600, liveBreakSec: 600 });
        expect(screen.getByRole("button", { name: /resume/i })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /logout/i })).toBeInTheDocument();
    });

    test("does not show old Clock Out label on break", () => {
        renderTimerCard({ state: "on_break", liveFloorSec: 3600, liveBreakSec: 600 });
        expect(screen.queryByText(/clock out/i)).not.toBeInTheDocument();
    });

    test("shows error message when error prop is set", () => {
        renderTimerCard({ state: "on_break", liveFloorSec: 3600, error: "Something went wrong" });
        expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    });
});

// ── Weekend state ──────────────────────────────────────────────────────────────

describe("TimerCard — weekend state", () => {
    test("shows weekend badge and no action buttons", () => {
        renderTimerCard({ state: "logged_out", isWeekend: true });
        expect(screen.getByText(/weekend holiday/i)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /login/i })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /logout/i })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /apply for overtime/i })).not.toBeInTheDocument();
    });
});