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
import {
  biometricPlatform,
  clearBiometricCredential,
  getBiometricCredentialId,
  hasBiometricCredential,
  isBiometricAvailable,
  saveBiometricCredential,
  unlockBiometricCredential,
} from "./biometricStore";
import { setUnauthorizedHandler } from "../api";
import { socket } from "../realtime/socket";
import { pushNotificationService } from "../services/pushNotificationService";
import { notifeeService } from "../services/notifeeService";
import { nativeCallService } from "../services/nativeCallService";
import {
  clearPendingCall,
  clearPersistedPendingCall,
} from "../realtime/pendingCall";

export type User = {
  id: number;
  username: string;
  full_name?: string;
  email?: string | null;
  avatar?: string | null;
  role: string;
  org_id?: number | null;
  tenant_id?: number | null;
  team_id?: number | null;
  team_name?: string | null;
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
  // ── Biometric ("login with your face") ──
  /** Hardware + OS-enrolled biometric available on this device. */
  biometricAvailable: boolean;
  /** A biometric credential has been enrolled for THIS device. */
  biometricEnrolled: boolean;
  /** Enroll the current (already-authenticated) user for biometric login. */
  enableBiometric: () => Promise<void>;
  /** Remove biometric login from this device (revokes server-side too). */
  disableBiometric: () => Promise<void>;
  /** Sign in using the stored biometric credential. Returns false if cancelled. */
  biometricLogin: () => Promise<boolean>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricEnrolled, setBiometricEnrolled] = useState(false);

  // Probe biometric hardware + local credential once at mount so the login
  // screen can decide whether to show the "Login with Face ID" button.
  useEffect(() => {
    let active = true;
    (async () => {
      const [available, enrolled] = await Promise.all([
        isBiometricAvailable(),
        hasBiometricCredential(),
      ]);
      if (active) {
        setBiometricAvailable(available);
        setBiometricEnrolled(enrolled);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const logout = useCallback(async () => {
    // Best-effort, fire BEFORE clearing the token while still authenticated:
    // delete THIS device's push token server-side so a logged-out device stops
    // receiving call/message pushes ("ring after logout"). We pass the device
    // token so the server can scope the delete to this device only.
    try {
      const deviceToken = pushNotificationService.getDeviceToken();
      await api.post("/auth/logout", deviceToken ? { deviceToken } : {});
    } catch {
      // ignore network/logout errors — clear local state regardless
    }

    // Dismiss any active incoming-call ring (Notifee/CallKeep) so a ring that
    // arrived right before logout doesn't linger.
    try {
      await notifeeService.cancelCall();
    } catch {
      // ignore — best-effort
    }

    // P1.3 — tear down the native CallKeep integration so a subsequent login
    // (possibly as a different user) re-initializes from a clean slate instead
    // of stacking a second set of CallKeep event listeners on top of the first
    // (the iOS bug where one answer/end tap fired the handler multiple times).
    try {
      nativeCallService.teardown();
    } catch {
      // ignore — best-effort
    }

    // Kill any pending-call route (in-memory + persisted) so the next login
    // doesn't flash a stale call screen.
    try {
      clearPendingCall();
      await clearPersistedPendingCall();
    } catch {
      // ignore — best-effort
    }

    // Reset the push-registration guard so the NEXT user to log in on this
    // device re-registers their device token (the cached auth token no longer
    // matches once we clear it below).
    try {
      pushNotificationService.resetRegistrationState();
    } catch {
      // ignore — best-effort
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

  // Shared post-auth hydration: persist the token, seed user state, connect
  // the realtime socket, then re-fetch the full profile (which carries the
  // plan/feature flags the login payload omits). Used by both password and
  // biometric login so the two paths stay in lock-step.
  const completeSession = useCallback(
    async (token: string, seedUser: User) => {
      await setToken(token);
      setUser(seedUser);
      socket.connect();
      try {
        const profile = await api.get<User>("/profile");
        if (profile.data) setUser(profile.data);
      } catch {
        // Non-fatal — keep the seed payload; session-restore hydrates later.
      }
    },
    [],
  );

  const login = useCallback(
    async (username: string, password: string) => {
      const res = await api.post<{ user: User; token: string }>("/auth/login", {
        username,
        password,
      });
      if (!res.data?.token) {
        throw new Error("Login did not return a token");
      }
      await completeSession(res.data.token, res.data.user);
    },
    [completeSession],
  );

  const refreshUser = useCallback(async () => {
    try {
      const res = await api.get<User>("/profile");
      setUser(res.data);
    } catch {
      /* ignore */
    }
  }, []);

  // ── Biometric login ──────────────────────────────────────────────────────

  // Enroll the currently-authenticated user for biometric login: ask the
  // server to mint a device secret, then stash it behind the OS biometric.
  const enableBiometric = useCallback(async () => {
    const res = await api.post<{ credentialId: string; deviceSecret: string }>(
      "/auth/biometric/enroll",
      { platform: biometricPlatform() },
    );
    const { credentialId, deviceSecret } = res.data || ({} as any);
    if (!credentialId || !deviceSecret) {
      throw new Error("Enrollment did not return a credential");
    }
    await saveBiometricCredential(credentialId, deviceSecret);
    setBiometricEnrolled(true);
  }, []);

  // Remove biometric login from this device: revoke server-side (best-effort)
  // then wipe the local credential.
  const disableBiometric = useCallback(async () => {
    try {
      const credId = await getBiometricCredentialId();
      if (credId) {
        await api.delete(`/auth/biometric/${encodeURIComponent(credId)}`);
      }
    } catch {
      // Best-effort: even if the server call fails, drop the local secret so
      // the device can no longer biometric-login.
    }
    await clearBiometricCredential();
    setBiometricEnrolled(false);
  }, []);

  // Sign in using the stored biometric credential. The OS biometric prompt is
  // triggered while reading the secret. Returns false if the user cancelled or
  // no credential exists; throws on a network/auth failure so the caller can
  // surface an error.
  const biometricLogin = useCallback(async (): Promise<boolean> => {
    const unlocked = await unlockBiometricCredential();
    if (!unlocked) return false; // cancelled / no credential
    try {
      const res = await api.post<{ user: User; token: string }>(
        "/auth/biometric/login",
        unlocked,
      );
      if (!res.data?.token) {
        throw new Error("Biometric login did not return a token");
      }
      await completeSession(res.data.token, res.data.user);
      return true;
    } catch (err: any) {
      // A 401 means the server-side credential was revoked (e.g. password
      // reset / "log out everywhere"). Clear the now-useless local secret.
      if (err?.response?.status === 401) {
        await clearBiometricCredential();
        setBiometricEnrolled(false);
      }
      throw err;
    }
  }, [completeSession]);

  const value = useMemo(
    () => ({
      user,
      loading,
      login,
      logout,
      refreshUser,
      biometricAvailable,
      biometricEnrolled,
      enableBiometric,
      disableBiometric,
      biometricLogin,
    }),
    [
      user,
      loading,
      login,
      logout,
      refreshUser,
      biometricAvailable,
      biometricEnrolled,
      enableBiometric,
      disableBiometric,
      biometricLogin,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
