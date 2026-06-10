import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api } from "../api";
import { clearToken, getToken, setToken } from "./tokenStore";
import { setUnauthorizedHandler } from "../api";
import { socket } from "../realtime/socket";

export type User = {
  id: number;
  username: string;
  full_name?: string;
  email?: string | null;
  avatar?: string | null;
  role: string;
  org_id?: number | null;
  tenant_id?: number | null;
  has_reports?: boolean;
  must_change_password?: boolean;
  // Plan / feature gating (mirrors the web profile payload).
  tenant_features?: Record<string, boolean> | null;
  tenant_plan?: string | null;
};

/**
 * Fail-closed feature check (mirrors client/src/FeaturesContext.tsx).
 * Platform admins with no tenant are never gated. A missing key = off.
 */
export function userHasFeature(
  user: User | null,
  name: string,
): boolean {
  if (!user) return false;
  if (user.role === "platform_admin" && !user.tenant_id) return true;
  const features = user.tenant_features;
  if (!features) return false;
  return features[name] === true;
}

type AuthContextValue = {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } catch {
      // ignore network/logout errors — clear local state regardless
    }
    socket.disconnect();
    await clearToken();
    setUser(null);
  }, []);

  // Restore session on launch: if a token exists, hydrate the profile.
  useEffect(() => {
    let active = true;
    (async () => {
      const token = await getToken();
      if (!token) {
        if (active) setLoading(false);
        return;
      }
      try {
        const res = await api.get<User>("/profile");
        if (active) {
          setUser(res.data);
          socket.connect();
        }
      } catch {
        await clearToken();
        if (active) setUser(null);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Force sign-out when any request returns 401.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      void clearToken();
      setUser(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.post<{ user: User; token: string }>("/auth/login", {
      username,
      password,
    });
    if (!res.data?.token) {
      throw new Error("Login did not return a token");
    }
    await setToken(res.data.token);
    setUser(res.data.user);
    socket.connect();
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const res = await api.get<User>("/profile");
      setUser(res.data);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, logout, refreshUser }),
    [user, loading, login, logout, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
