import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import Login from "../pages/Login";

// Mock the api module
const mockLoginApi = vi.fn();
vi.mock("../api", () => ({
    login: (...args: any[]) => mockLoginApi(...args),
    getProfile: vi.fn().mockRejectedValue(new Error("not logged in")),
    logoutUser: vi.fn(),
}));

// Mock AuthContext
const mockSaveAuth = vi.fn();
vi.mock("../AuthContext", () => ({
    useAuth: () => ({
        user: null,
        saveAuth: mockSaveAuth,
        isAuthenticated: false,
        isInitializing: false,
    }),
    AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

function renderLogin() {
    return render(
        <MemoryRouter initialEntries={["/login"]}>
            <Routes>
                <Route path="/login" element={<Login />} />
            </Routes>
        </MemoryRouter>
    );
}

describe("Login page", () => {
    beforeEach(() => {
        mockLoginApi.mockReset();
        mockSaveAuth.mockReset();
    });

    test("renders form with username and password", () => {
        renderLogin();
        expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
        expect(screen.getByPlaceholderText(/enter your password/i)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
    });

    test("renders register and forgot password links", () => {
        renderLogin();
        expect(screen.getByText(/register/i)).toBeInTheDocument();
        expect(screen.getByText(/forgot password/i)).toBeInTheDocument();
    });

    test("calls login API on form submit", async () => {
        const user = userEvent.setup();
        mockLoginApi.mockResolvedValue({ data: { user: { id: 1, username: "test" } } });
        renderLogin();

        await user.type(screen.getByLabelText(/username/i), "testuser");
        await user.type(screen.getByPlaceholderText(/enter your password/i), "password123");
        await user.click(screen.getByRole("button", { name: /sign in/i }));

        await waitFor(() => {
            expect(mockLoginApi).toHaveBeenCalledWith({ username: "testuser", password: "password123" });
        });
        expect(mockSaveAuth).toHaveBeenCalledWith({ id: 1, username: "test" });
    });

    test("shows error on failed login", async () => {
        const user = userEvent.setup();
        mockLoginApi.mockRejectedValue({ response: { data: { error: "Invalid credentials" } } });
        renderLogin();

        await user.type(screen.getByLabelText(/username/i), "bad");
        await user.type(screen.getByPlaceholderText(/enter your password/i), "wrong");
        await user.click(screen.getByRole("button", { name: /sign in/i }));

        await waitFor(() => {
            expect(screen.getByText("Invalid credentials")).toBeInTheDocument();
        });
    });

    test("disables button while loading", async () => {
        const user = userEvent.setup();
        // Don't resolve immediately — keep it pending
        let resolveLogin: (value: any) => void;
        mockLoginApi.mockImplementation(
            () =>
                new Promise((r) => {
                    resolveLogin = r;
                })
        );
        renderLogin();

        await user.type(screen.getByLabelText(/username/i), "test");
        await user.type(screen.getByPlaceholderText(/enter your password/i), "pass");
        await user.click(screen.getByRole("button", { name: /sign in/i }));

        expect(screen.getByRole("button", { name: /signing in/i })).toBeDisabled();

        // Resolve to prevent act warning
        resolveLogin!({ data: { user: { id: 1 } } });
        await waitFor(() => expect(mockSaveAuth).toHaveBeenCalled());
    });
});