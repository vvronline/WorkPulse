import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, test, expect, vi, beforeEach } from "vitest";

// Mock API
const mockGetProfile = vi.fn();
const mockLogoutUser = vi.fn();
vi.mock("../api", () => ({
  getProfile: (...args: any[]) => mockGetProfile(...args),
  logoutUser: (...args: any[]) => mockLogoutUser(...args),
}));

// Must import after mocks
import { AuthProvider, useAuth } from "../AuthContext";

function TestConsumer() {
  const { user, isAuthenticated, saveAuth, logout } = useAuth() as any;
  return (
    <div>
      <span data-testid="auth-status">{isAuthenticated ? "yes" : "no"}</span>
      <span data-testid="username">{user?.username || "none"}</span>
      <button
        onClick={() => saveAuth({ id: 1, username: "saved", role: "employee" })}
      >
        save
      </button>
      <button onClick={() => logout()}>logout</button>
    </div>
  );
}

describe("AuthContext", () => {
  beforeEach(() => {
    localStorage.clear();
    mockGetProfile.mockReset();
    mockLogoutUser.mockReset();
  });

  test("starts unauthenticated when no cache", async () => {
    mockGetProfile.mockRejectedValue(new Error("no session"));
    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );
    // No cached user → should not call getProfile
    await waitFor(() => {
      expect(screen.getByTestId("auth-status").textContent).toBe("no");
    });
  });

  test("verifies session when cached user exists", async () => {
    localStorage.setItem("user", JSON.stringify({ id: 1, username: "cached" }));
    mockGetProfile.mockResolvedValue({
      data: { id: 1, username: "fresh", role: "employee" },
    });

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("username").textContent).toBe("fresh");
    });
    expect(mockGetProfile).toHaveBeenCalled();
  });

  test("clears user on 401 from profile", async () => {
    localStorage.setItem("user", JSON.stringify({ id: 1, username: "old" }));
    mockGetProfile.mockRejectedValue({ response: { status: 401 } });

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("auth-status").textContent).toBe("no");
    });
    expect(localStorage.getItem("user")).toBeNull();
  });

  test("saveAuth stores user and sets authenticated", async () => {
    const user = userEvent.setup();
    mockGetProfile.mockResolvedValue({
      data: { id: 1, username: "saved", role: "employee" },
    });
    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("auth-status")).toBeInTheDocument(),
    );
    await user.click(screen.getByText("save"));

    expect(screen.getByTestId("auth-status").textContent).toBe("yes");
    expect(screen.getByTestId("username").textContent).toBe("saved");
    // localStorage should contain only safe fields
    const cached = JSON.parse(localStorage.getItem("user") as string);
    expect(cached.username).toBe("saved");
    expect(cached.role).toBeUndefined(); // role is NOT safe-cached
  });

  test("logout clears user state", async () => {
    const user = userEvent.setup();
    mockGetProfile.mockResolvedValue({
      data: { id: 1, username: "saved", role: "employee" },
    });
    mockLogoutUser.mockResolvedValue({});
    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    // First save, then logout
    await waitFor(() =>
      expect(screen.getByTestId("auth-status")).toBeInTheDocument(),
    );
    await user.click(screen.getByText("save"));
    expect(screen.getByTestId("auth-status").textContent).toBe("yes");

    await user.click(screen.getByText("logout"));
    await waitFor(() => {
      expect(screen.getByTestId("auth-status").textContent).toBe("no");
    });
    expect(localStorage.getItem("user")).toBeNull();
  });

  test("logout wipes tenant/user-scoped caches but keeps device prefs", async () => {
    const user = userEvent.setup();
    mockGetProfile.mockResolvedValue({
      data: { id: 1, username: "saved", role: "employee" },
    });
    mockLogoutUser.mockResolvedValue({});

    // Seed leftover caches from a previous tenant/user session.
    localStorage.setItem(
      "workpulse_agile_config_v1",
      JSON.stringify({ fetchedAt: Date.now(), config: {} }),
    );
    localStorage.setItem(
      "workpulse.notificationPrefs",
      JSON.stringify({ muteAll: true }),
    );
    localStorage.setItem("workpulse-notes-1", JSON.stringify({ pages: [] }));
    // Device-scoped preferences must survive an account switch.
    localStorage.setItem("theme", "dark");
    localStorage.setItem("wp_recent_emojis_v2", "[]");

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("auth-status")).toBeInTheDocument(),
    );
    await user.click(screen.getByText("save"));
    await user.click(screen.getByText("logout"));
    await waitFor(() => {
      expect(screen.getByTestId("auth-status").textContent).toBe("no");
    });

    // Tenant/user-scoped caches are gone (no cross-tenant leak on next login).
    expect(localStorage.getItem("workpulse_agile_config_v1")).toBeNull();
    expect(localStorage.getItem("workpulse.notificationPrefs")).toBeNull();
    expect(localStorage.getItem("workpulse-notes-1")).toBeNull();
    // Device preferences are preserved.
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(localStorage.getItem("wp_recent_emojis_v2")).toBe("[]");
  });

  test("saveAuth wipes stale tenant/user-scoped caches (account switch without reload)", async () => {
    const user = userEvent.setup();
    mockGetProfile.mockResolvedValue({
      data: { id: 2, username: "saved", role: "employee" },
    });

    // Leftover cache from a previous account that never went through logout()
    // (e.g. desktop app, which does not reload between account switches).
    localStorage.setItem(
      "workpulse_agile_config_v1",
      JSON.stringify({ fetchedAt: Date.now(), config: {} }),
    );
    localStorage.setItem("theme", "light");

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("auth-status")).toBeInTheDocument(),
    );
    await user.click(screen.getByText("save"));

    expect(localStorage.getItem("workpulse_agile_config_v1")).toBeNull();
    expect(localStorage.getItem("theme")).toBe("light");
  });
});
