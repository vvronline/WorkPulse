import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { LogOut, Shield } from "lucide-react-native";
import { theme } from "../theme";
import { useAuth } from "../auth/AuthContext";
import {
  clearOrigToken,
  getOrigToken,
  setToken,
} from "../auth/tokenStore";
import { exitImpersonateTenant } from "../admin";

/**
 * Persistent banner shown while a platform admin is inside a tenant via an
 * impersonation session (mobile equivalent of the web's impersonation bar).
 * Detection: an "original token" is parked in SecureStore — its presence
 * means the active token is an impersonation JWT.
 */
export default function ImpersonationBanner() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, refreshUser } = useAuth();
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);

  // Re-check whenever the auth user changes (token swaps re-hydrate the user).
  useEffect(() => {
    let mounted = true;
    getOrigToken().then((t) => {
      if (mounted) setActive(!!t);
    });
    return () => {
      mounted = false;
    };
  }, [user]);

  const exit = useCallback(async () => {
    setBusy(true);
    try {
      // Best-effort: tell the server the session ended (flushes the audit row).
      if (user?.tenant_id) {
        try {
          await exitImpersonateTenant(user.tenant_id);
        } catch {
          /* session may already be expired */
        }
      }
      const orig = await getOrigToken();
      if (orig) {
        await setToken(orig);
        await clearOrigToken();
      }
      setActive(false);
      await refreshUser();
      router.replace("/tenants" as never);
    } finally {
      setBusy(false);
    }
  }, [user?.tenant_id, refreshUser, router]);

  if (!active || !user) return null;

  return (
    <View style={[styles.banner, { paddingTop: 8 + insets.top }]}>
      <Shield size={14} color="#fff" />
      <Text style={styles.text} numberOfLines={1}>
        Inspecting tenant as {user.full_name || user.username}
      </Text>
      <Pressable
        style={[styles.exitBtn, busy && styles.disabled]}
        onPress={exit}
        disabled={busy}
        hitSlop={6}
      >
        <LogOut size={13} color="#fff" />
        <Text style={styles.exitText}>{busy ? "Exiting…" : "Exit"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#f97316",
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  text: { flex: 1, color: "#fff", fontSize: 12, fontWeight: "600" },
  exitBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "rgba(0,0,0,0.25)",
    borderRadius: theme.radiusFull,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  exitText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  disabled: { opacity: 0.6 },
});