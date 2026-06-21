import {
    createContext,
    useContext,
    useState,
    useEffect,
    useMemo,
    useCallback,
    type ReactNode,
} from "react";
import { getProfile, logoutUser, refreshToken } from "./api";
import { REFRESH_TOKEN_INTERVAL } from "./constants";
import type { User } from "./types";

interface AuthContextValue {
    user: User | null;
    saveAuth: (userData: User) => void;
    updateUser: (partial: Partial<User>) => void;
    logout: () => Promise<void>;
    isAuthenticated: boolean;
    isInitializing: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Only cache display-safe fields in localStorage to prevent privilege escalation
// via tampered localStorage. Role, org_id, has_reports etc. always come from the server.
const SAFE_CACHE_FIELDS: (keyof User | string)[] = [
    "id",
    "username",
    "full_name",
    "email",
    "avatar",
    "tenant_id",
    "impersonated",
    "impersonated_by_name",
    "impersonated_tenant_name",
];
function sanitizeForCache(user: Partial<User> | null | undefined): Partial<User> {
    const safe: Record<string, unknown> = {};
    SAFE_CACHE_FIELDS.forEach((key) => {
        if (user?.[key as keyof User] !== undefined)
            safe[key] = user[key as keyof User];
    });
    return safe as Partial<User>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [isInitializing, setIsInitializing] = useState(true);

    useEffect(() => {
        // Only verify session if there's a cached user — avoids a 401 console error
        // when the user was never logged in (no cookie exists).
        const cached = localStorage.getItem("user");
        if (!cached) {
            setIsInitializing(false);
            return;
        }
        const controller = new AbortController();
        getProfile({ signal: controller.signal })
            .then((res) => {
                if (res.data) {
                    setUser(res.data);
                    localStorage.setItem(
                        "user",
                        JSON.stringify(sanitizeForCache(res.data)),
                    );
                }
            })
            .catch((err) => {
                if (controller.signal.aborted) return;
                // Session expired or invalid — clear cached user
                if (err.response?.status === 401) {
                    localStorage.removeItem("user");
                    setUser(null);
                } else if (!err.response) {
                    // Network error (no response) — use cached display-safe fields only.
                    // Role/org_id/has_reports are NOT in the cache, so the user gets a
                    // basic view without admin or manager features until the server reconnects.
                    try {
                        const cachedUser = JSON.parse(cached);
                        if (cachedUser) {
                            setUser(sanitizeForCache(cachedUser) as User);
                        } else {
                            localStorage.removeItem("user");
                            setUser(null);
                        }
                    } catch {
                        localStorage.removeItem("user");
                        setUser(null);
                    }
                } else {
                    // Server error (500, 403, etc.) — don't trust cached permissions
                    localStorage.removeItem("user");
                    setUser(null);
                }
            })
            .finally(() => {
                setIsInitializing(false);
            });
        return () => controller.abort();
    }, []);

    // Silently refresh the JWT cookie periodically to keep active sessions alive.
    // Runs every 30 minutes while the user is logged in.
    useEffect(() => {
        if (!user) return;
        const id = setInterval(() => {
            refreshToken().catch(() => {
                /* token expired or network error — AxiosInterceptor handles 401 */
            });
        }, REFRESH_TOKEN_INTERVAL);
        return () => clearInterval(id);
    }, [user]);

    const saveAuth = useCallback((userData: User) => {
        try {
            localStorage.setItem(
                "user",
                JSON.stringify(sanitizeForCache(userData)),
            );
        } catch {
            /* quota exceeded or private mode */
        }
        setUser(userData);
        // Signal an auth-identity change so long-lived real-time connections
        // (the WebSockets opened by useWebSocket from StatusContext, CallContext,
        // ChatContext, …) tear down and reconnect under the NEW user's cookie.
        // In the desktop app there is no page reload between logout and login, so
        // without this the previous user's already-open socket stays registered
        // server-side as that user — causing ghost behaviour like the new user
        // simultaneously seeing an OUTGOING call (their own) AND an INCOMING call
        // (routed to the stale previous-user socket on the same device).
        try {
            window.dispatchEvent(
                new CustomEvent("auth-changed", {
                    detail: { userId: userData?.id ?? null },
                }),
            );
        } catch {
            /* CustomEvent unavailable (non-browser env) — ignore */
        }
        getProfile()
            .then((res) => {
                if (res.data) {
                    setUser(res.data);
                    try {
                        localStorage.setItem(
                            "user",
                            JSON.stringify(sanitizeForCache(res.data)),
                        );
                    } catch {
                        /* ignore */
                    }
                }
            })
            .catch(() => {});
    }, []);

    const updateUser = useCallback((partial: Partial<User>) => {
        setUser((prev) => {
            const updated = { ...prev, ...partial } as User;
            try {
                localStorage.setItem(
                    "user",
                    JSON.stringify(sanitizeForCache(updated)),
                );
            } catch {
                /* quota exceeded or private mode */
            }
            return updated;
        });
    }, []);

    const logout = useCallback(async () => {
        // PR7: dropped client-side `updateUserStatus('offline')`. The server's
        // /auth/logout handler calls statusService.closeAllSessions which
        // resolves the user to offline and broadcasts `user_status` for us.
        try {
            await logoutUser();
        } catch {
            /* ignore network error on logout */
        }
        localStorage.removeItem("user");
        setUser(null);
        // Tear down the previous user's real-time WebSockets immediately so the
        // server drops their socket registration (presence → offline, no more
        // call/message routing to this device). The fresh socket that reconnects
        // has no auth cookie and is rejected (4001) until the next login, at
        // which point it re-authenticates as the new user. See useWebSocket's
        // `auth-changed` listener.
        try {
            window.dispatchEvent(
                new CustomEvent("auth-changed", { detail: { userId: null } }),
            );
        } catch {
            /* CustomEvent unavailable (non-browser env) — ignore */
        }
    }, []);

    const value = useMemo(
        () => ({
            user,
            saveAuth,
            updateUser,
            logout,
            isAuthenticated: !!user,
            isInitializing,
        }),
        [user, saveAuth, updateUser, logout, isInitializing],
    );

    return (
        <AuthContext.Provider value={value}>
            {!isInitializing && children}
        </AuthContext.Provider>
    );
}

export const useAuth = (): AuthContextValue => {
    const ctx = useContext(AuthContext);
    if (!ctx) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return ctx;
};