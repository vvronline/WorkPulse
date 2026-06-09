import { render, screen, fireEvent } from "@testing-library/react";
import { describe, test, expect, vi } from "vitest";
import ConfirmDialog from "../components/common/ConfirmDialog";

describe("ConfirmDialog", () => {
    test("renders nothing when closed", () => {
        const { container } = render(
            <ConfirmDialog isOpen={false} title="Test" message="msg" onConfirm={vi.fn()} onCancel={vi.fn()} />
        );
        expect(container.innerHTML).toBe("");
    });

    test("renders title and message when open", () => {
        render(
            <ConfirmDialog
                isOpen={true}
                title="Delete item?"
                message="This cannot be undone."
                onConfirm={vi.fn()}
                onCancel={vi.fn()}
            />
        );
        expect(screen.getByText("Delete item?")).toBeInTheDocument();
        expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
    });

    test("calls onConfirm when confirm button clicked", () => {
        const onConfirm = vi.fn();
        render(
            <ConfirmDialog
                isOpen={true}
                title="Test"
                message="msg"
                confirmText="Yes"
                onConfirm={onConfirm}
                onCancel={vi.fn()}
            />
        );
        fireEvent.click(screen.getByText("Yes"));
        expect(onConfirm).toHaveBeenCalledOnce();
    });

    test("calls onCancel when cancel button clicked", () => {
        const onCancel = vi.fn();
        render(
            <ConfirmDialog
                isOpen={true}
                title="Test"
                message="msg"
                cancelText="No"
                onConfirm={vi.fn()}
                onCancel={onCancel}
            />
        );
        fireEvent.click(screen.getByText("No"));
        expect(onCancel).toHaveBeenCalledOnce();
    });

    test("calls onCancel on Escape key", () => {
        const onCancel = vi.fn();
        render(
            <ConfirmDialog isOpen={true} title="Test" message="msg" onConfirm={vi.fn()} onCancel={onCancel} />
        );
        fireEvent.keyDown(document, { key: "Escape" });
        expect(onCancel).toHaveBeenCalled();
    });

    test("uses custom button text", () => {
        render(
            <ConfirmDialog
                isOpen={true}
                title="T"
                message="M"
                confirmText="Do it"
                cancelText="Nope"
                onConfirm={vi.fn()}
                onCancel={vi.fn()}
            />
        );
        expect(screen.getByText("Do it")).toBeInTheDocument();
        expect(screen.getByText("Nope")).toBeInTheDocument();
    });
});