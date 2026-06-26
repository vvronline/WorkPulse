import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { clearToken, getToken, setToken } from "./tokenStore";
import {
  biometricPlatform,
  clearBiometricCredential,
  getBiometricCapability,
  getBiometricCredentialId,
  hasBiometricCredential,
  saveBiometricCredential,
  unlockBiometricCredential,
  type BiometricKind,
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
import { clearAllChatCache } from "../storage/chatCache";
import { mmkvQueryPersister } from "../storage/queryPersister";
import { clearMediaCache } from "../components/chat/mediaCache";

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
export function userHasFeature(user: User | null, name: string): boolean {
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
  /** Honest, platform-aware label, e.g. "Face ID", "Touch ID", "Fingerprint". */
  biometricLabel: string;
  /** Icon hint: "face" | "fingerprint" | "biometric". */
  biometricKind: BiometricKind;
  /** Enroll the current (already-authenticated) user for biometric login. */
  enableBiometric: () => Promise<void>;
  /** Remove biometric login from this device (revokes server-side too). */
  disableBiometric: () => Promise<void>;
  /** Sign in using the stored biometric credential. Returns false if cancelled. */
  biometricLogin: () => Promise<boolean>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricEnrolled, setBiometricEnrolled] = useState(false);
  const [biometricLabel, setBiometricLabel] = useState("Biometric Login");
  const [biometricKind, setBiometricKind] =
    useState<BiometricKind>("biometric");

  // Probe biometric hardware + local credential once at mount so the login
  // screen can decide whether to show the biometric button, and with what
  // label/icon (Face ID vs Touch ID vs Fingerprint).
  useEffect(() => {
    let active = true;
    (async () => {
      const [cap, enrolled] = await Promise.all([
        getBiometricCapability(),
        hasBiometricCredential(),
      ]);
      if (active) {
        setBiometricAvailable(cap.available);
        setBiometricLabel(cap.label);
        setBiometricKind(cap.kind);
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

    // Wipe on-device chat caches BEFORE dropping the session. These caches are
    // keyed only by conversationId (unique only within a tenant DB), so leaving
    // them in place would let the NEXT account to sign in on this device read
    // the previous user's cached conversation list / messages — a cross-tenant
    // data leak on shared devices. Both are best-effort and must not throw.
    try {
      clearAllChatCache();
    } catch {
      // ignore — best-effort
    }
    try {
      await clearMediaCache();
    } catch {
      // ignore — best-effort
    }

    // Drop the in-memory React Query cache so the next account to sign in on
    // this device (without an app restart) can't briefly read the previous
    // user's cached server data while it's still within staleTime.
    try {
      queryClient.clear();
    } catch {
      // ignore — best-effort
    }
    // Also drop the PERSISTED query snapshot from disk. clear() above empties
    // the in-memory cache (which the persister eventually mirrors), but a kill
    // before that async write lands would leave the previous tenant's cached
    // data on disk to be restored under the next account. Removing it here is
    // the same multi-tenant safeguard as clearAllChatCache() above.
    try {
      mmkvQueryPersister.removeClient();
    } catch {
      // ignore — best-effort
    }

    setUser(null);
  }, [queryClient]);

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
      // Same cross-tenant concern as the explicit logout(): drop cached chat
      // artifacts so a different account signing in next can't read them.
      try {
        clearAllChatCache();
      } catch {
        /* best-effort */
      }
      void clearMediaCache();
      try {
        queryClient.clear();
      } catch {
        /* best-effort */
      }
      try {
        mmkvQueryPersister.removeClient();
      } catch {
        /* best-effort */
      }
      setUser(null);
    });
    return () => setUnauthorizedHandler(null);
  }, [queryClient]);

  // Shared post-auth hydration: persist the token, seed user state, connect
  // the realtime socket, then re-fetch the full profile (which carries the
  // plan/feature flags the login payload omits). Used by both password and
  // biometric login so the two paths stay in lock-step.
  const completeSession = useCallback(async (token: string, seedUser: User) => {
    await setToken(token);
    setUser(seedUser);
    socket.connect();
    try {
      const profile = await api.get<User>("/profile");
      if (profile.data) setUser(profile.data);
    } catch {
      // Non-fatal — keep the seed payload; session-restore hydrates later.
    }
  }, []);

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
      biometricLabel,
      biometricKind,
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
      biometricLabel,
      biometricKind,
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
