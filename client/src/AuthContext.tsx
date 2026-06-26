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
import { queryClient, PERSISTED_QUERY_CACHE_KEY } from "./queryClient";
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
function sanitizeForCache(
  user: Partial<User> | null | undefined,
): Partial<User> {
  const safe: Record<string, unknown> = {};
  SAFE_CACHE_FIELDS.forEach((key) => {
    if (user?.[key as keyof User] !== undefined)
      safe[key] = user[key as keyof User];
  });
  return safe as Partial<User>;
}

// Persistent localStorage caches that hold tenant- or user-scoped DATA (as
// opposed to device-level UI preferences). These MUST be wiped whenever the
// session ends or a different account signs in, otherwise on a shared browser
// — and especially the desktop (Electron) app, which never reloads the page
// between logout and the next login — the next account would read the previous
// tenant's cached data. Several of these keys are global or only keyed by a
// userId (which is unique only WITHIN a tenant DB), so a stale entry would be
// served cross-tenant.
//
// Device-scoped preferences (theme, emoji recents/skin-tone) are intentionally
// left untouched — they carry no tenant data and should survive an account
// switch on the same device.
const TENANT_SCOPED_CACHE_KEYS = [
  "workpulse_agile_config_v1", // AgileConfigContext — tenant workflow/board config
  "workpulse.notificationPrefs", // NotificationPrefsContext — per-user prefs
  PERSISTED_QUERY_CACHE_KEY, // React Query persisted snapshot — tenant server data
];
// Dynamic per-user keys share a stable prefix; clear every match.
const TENANT_SCOPED_CACHE_PREFIXES = [
  "workpulse-notes-", // useNotesPersistence — per-user private notebook (keyed by userId)
];

function clearTenantScopedCaches(): void {
  try {
    // Drop the in-memory React Query cache too — removing only the persisted
    // localStorage snapshot would leave the live cache to be re-persisted, and
    // (on the desktop app, which never reloads between logout and login) let the
    // next account briefly read the previous tenant's data within staleTime.
    queryClient.clear();
  } catch {
    /* best-effort — must not block auth */
  }
  try {
    TENANT_SCOPED_CACHE_KEYS.forEach((key) => localStorage.removeItem(key));
    // Snapshot the keys first — removing while iterating localStorage is
    // unsafe (indices shift).
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
    keys.forEach((k) => {
      if (TENANT_SCOPED_CACHE_PREFIXES.some((p) => k.startsWith(p))) {
        localStorage.removeItem(k);
      }
    });
  } catch {
    /* private mode / quota — best-effort, must not block auth */
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // Seed from the display-safe localStorage cache synchronously so a cold start
  // (notably the desktop app relaunching from a killed state) paints the app
  // shell immediately instead of blocking on the getProfile() round-trip. The
  // cache only holds SAFE_CACHE_FIELDS (no role/org_id/has_reports), so
  // role-gated UI stays fail-closed until the background verify below resolves.
  const [user, setUser] = useState<User | null>(() => {
    try {
      const cached = localStorage.getItem("user");
      if (!cached) return null;
      const parsed = JSON.parse(cached);
      return parsed ? (sanitizeForCache(parsed) as User) : null;
    } catch {
      return null;
    }
  });
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
    // Account switch on the same device (notably the desktop app, which does
    // NOT reload between logout and login): proactively drop any
    // tenant/user-scoped caches left over from a previous session so the
    // incoming user can never read the prior tenant's cached data.
    clearTenantScopedCaches();
    try {
      localStorage.setItem("user", JSON.stringify(sanitizeForCache(userData)));
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
        localStorage.setItem("user", JSON.stringify(sanitizeForCache(updated)));
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
    clearTenantScopedCaches();
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

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
};
