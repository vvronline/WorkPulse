import { render, screen, act } from "@testing-library/react";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { ToastProvider, useToast } from "../components/common/Toast";

// Test component that exposes toast functions
function TestConsumer() {
    const toast = useToast() as any;
    return (
        <div>
            <button onClick={() => toast.success("Success!")}>show-success</button>
            <button onClick={() => toast.error("Error!")}>show-error</button>
            <button onClick={() => toast.info("Info!")}>show-info</button>
        </div>
    );
}

function renderToast() {
    return render(
        <ToastProvider>
            <TestConsumer />
        </ToastProvider>
    );
}

describe("Toast", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    test("shows success toast on click", async () => {
        renderToast();
        await act(async () => {
            screen.getByText("show-success").click();
        });
        expect(screen.getByText("Success!")).toBeInTheDocument();
    });

    test("shows error toast", async () => {
        renderToast();
        await act(async () => {
            screen.getByText("show-error").click();
        });
        expect(screen.getByText("Error!")).toBeInTheDocument();
    });

    test("auto-dismisses after timeout", async () => {
        renderToast();
        await act(async () => {
            screen.getByText("show-info").click();
        });
        expect(screen.getByText("Info!")).toBeInTheDocument();

        await act(async () => {
            vi.advanceTimersByTime(5000);
        });
        expect(screen.queryByText("Info!")).not.toBeInTheDocument();
    });
});