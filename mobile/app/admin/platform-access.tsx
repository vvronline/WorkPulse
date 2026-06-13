import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack } from "expo-router";
import * as Clipboard from "expo-clipboard";
import {
  BadgeAlert,
  Check,
  CheckCircle2,
  Copy,
  Shield,
  X,
} from "lucide-react-native";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { PromptModal } from "../../src/components/PromptModal";
import {
  approveAccessRequest,
  denyAccessRequest,
  listIncomingAccessRequests,
  revokeAccessSession,
  type IncomingAccessRequest,
} from "../../src/admin";

function fmt(iso?: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function statusPalette(theme: Theme, status: string): string {
  switch (status) {
    case "pending":
      return theme.warning;
    case "approved":
    case "consumed":
      return theme.primary;
    case "denied":
    case "revoked":
      return theme.danger;
    default:
      return theme.textMuted;
  }
}

type RevealedCode = {
  id: number;
  code: string;
  expires_at?: string;
  inspector?: string | null;
};

export default function PlatformAccessScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [requests, setRequests] = useState<IncomingAccessRequest[]>([]);
  const [activeSession, setActiveSession] =
    useState<IncomingAccessRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The plaintext approval code is returned exactly once on approve — we
  // surface it in a banner with copy-to-clipboard (mirrors the web inbox).
  const [revealedCode, setRevealedCode] = useState<RevealedCode | null>(null);
  const [copied, setCopied] = useState(false);

  // Deny-with-reason modal
  const [denyTarget, setDenyTarget] = useState<IncomingAccessRequest | null>(
    null,
  );
  const [denyBusy, setDenyBusy] = useState(false);

  const load = useCallback(() => {
    listIncomingAccessRequests({ limit: 50 })
      .then((r) => {
        setRequests(r.data.requests || []);
        setActiveSession(r.data.active_session || null);
      })
      .catch((e: any) =>
        setError(e?.response?.data?.error || "Failed to load requests"),
      )
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
      });
  }, []);

  useEffect(() => {
    load();
    // Cheap polling so new requests appear without manual refresh.
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [load]);

  async function approve(req: IncomingAccessRequest) {
    setBusyId(req.id);
    setError(null);
    try {
      const { data } = await approveAccessRequest(req.id);
      setRevealedCode({
        id: req.id,
        code: data.approval_code,
        expires_at: data.code_expires_at,
        inspector: req.requested_by_name,
      });
      setCopied(false);
      load();
    } catch (e: any) {
      setError(e?.response?.data?.error || "Failed to approve");
    } finally {
      setBusyId(null);
    }
  }

  async function submitDeny(values: Record<string, string>) {
    if (!denyTarget) return;
    setDenyBusy(true);
    try {
      await denyAccessRequest(denyTarget.id, values.reason?.trim() || undefined);
      setDenyTarget(null);
      load();
    } catch (e: any) {
      setError(e?.response?.data?.error || "Failed to deny");
      setDenyTarget(null);
    } finally {
      setDenyBusy(false);
    }
  }

  async function revoke(req: IncomingAccessRequest) {
    setBusyId(req.id);
    setError(null);
    try {
      await revokeAccessSession(req.id, "Revoked from mobile admin");
      load();
    } catch (e: any) {
      setError(e?.response?.data?.error || "Failed to revoke");
    } finally {
      setBusyId(null);
    }
  }

  async function copyCode() {
    if (!revealedCode) return;
    await Clipboard.setStringAsync(revealedCode.code);
    setCopied(true);
  }

  const pending = requests.filter((r) => r.status === "pending");
  const history = requests.filter((r) => r.status !== "pending");

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Platform Access" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            load();
          }}
          tintColor={theme.primary}
        />
      }
    >
      <Stack.Screen options={{ title: "Platform Access" }} />

      <Text style={styles.intro}>
        Review access requests from platform support staff. Each approval mints
        a one-time 6-digit code that you must share with the inspector over a
        trusted channel.
      </Text>

      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={() => setError(null)} hitSlop={8}>
            <X size={16} color={theme.danger} />
          </Pressable>
        </View>
      ) : null}

      {/* Active session card */}
      {activeSession ? (
        <View style={[styles.card, styles.activeCard]}>
          <View style={styles.cardHeader}>
            <BadgeAlert size={16} color={theme.warning} />
            <Text style={styles.activeTitle}>
              Inspector currently active in your workspace
            </Text>
          </View>
          <Text style={styles.meta}>
            Inspector:{" "}
            {activeSession.requested_by_name ||
              `User #${activeSession.requested_by}`}
            {activeSession.scope ? ` · ${activeSession.scope} access` : ""}
          </Text>
          {activeSession.reason ? (
            <Text style={styles.reason}>"{activeSession.reason}"</Text>
          ) : null}
          <Text style={styles.meta}>
            Started {fmt(activeSession.consumed_at)}
            {activeSession.session_ends_at
              ? ` · ends ${fmt(activeSession.session_ends_at)}`
              : ""}
          </Text>
          <Pressable
            style={styles.revokeBtn}
            onPress={() => revoke(activeSession)}
            disabled={busyId === activeSession.id}
          >
            <X size={15} color={theme.danger} />
            <Text style={[styles.actionBtnText, { color: theme.danger }]}>
              Revoke session
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* One-time revealed approval code */}
      {revealedCode ? (
        <View style={[styles.card, styles.codeCard]}>
          <View style={styles.cardHeader}>
            <CheckCircle2 size={16} color={theme.success} />
            <Text style={styles.codeTitle}>Approval code generated</Text>
            <Pressable onPress={() => setRevealedCode(null)} hitSlop={8}>
              <X size={18} color={theme.textSecondary} />
            </Pressable>
          </View>
          <Text style={styles.codeNote}>
            Share this code with{" "}
            {revealedCode.inspector || "the inspector"} over a trusted channel.
            {revealedCode.expires_at
              ? ` It expires at ${fmt(revealedCode.expires_at)}`
              : ""}{" "}
            and is shown only this once.
          </Text>
          <View style={styles.codeRow}>
            <View style={styles.codeBox}>
              <Text style={styles.codeText}>{revealedCode.code}</Text>
            </View>
            <Pressable style={styles.copyBtn} onPress={copyCode}>
              <Copy size={15} color={theme.text} />
              <Text style={styles.copyText}>{copied ? "Copied" : "Copy"}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* Pending requests */}
      <Text style={styles.sectionTitle}>
        Pending requests{pending.length > 0 ? ` (${pending.length})` : ""}
      </Text>
      {pending.length === 0 ? (
        <Text style={styles.empty}>No pending requests.</Text>
      ) : (
        pending.map((item) => (
          <View key={item.id} style={styles.card}>
            <View style={styles.cardHeader}>
              <Shield size={16} color={theme.primary} />
              <Text style={styles.name} numberOfLines={1}>
                {item.requested_by_name || `Inspector #${item.requested_by}`}
              </Text>
              <View
                style={[
                  styles.statusPill,
                  { backgroundColor: statusPalette(theme, item.status) + "22" },
                ]}
              >
                <Text
                  style={[
                    styles.statusText,
                    { color: statusPalette(theme, item.status) },
                  ]}
                >
                  {item.status}
                </Text>
              </View>
            </View>
            {item.requested_by_email ? (
              <Text style={styles.meta}>{item.requested_by_email}</Text>
            ) : null}
            {item.reason ? (
              <Text style={styles.reason}>"{item.reason}"</Text>
            ) : null}
            <Text style={styles.meta}>
              {item.scope || "write"} access
              {item.duration_minutes ? ` · ${item.duration_minutes} min` : ""}
              {item.requested_at
                ? ` · requested ${fmt(item.requested_at)}`
                : ""}
            </Text>

            <View style={styles.actionRow}>
              <Pressable
                style={[styles.actionBtn, styles.approveBtn]}
                onPress={() => approve(item)}
                disabled={busyId === item.id}
              >
                <Check size={15} color="#fff" />
                <Text style={styles.actionBtnText}>Approve</Text>
              </Pressable>
              <Pressable
                style={[styles.actionBtn, styles.denyBtn]}
                onPress={() => setDenyTarget(item)}
                disabled={busyId === item.id}
              >
                <X size={15} color={theme.danger} />
                <Text style={[styles.actionBtnText, { color: theme.danger }]}>
                  Deny
                </Text>
              </Pressable>
            </View>
          </View>
        ))
      )}

      {/* History */}
      <Text style={styles.sectionTitle}>Recent history</Text>
      {history.length === 0 ? (
        <Text style={styles.empty}>No previous requests yet.</Text>
      ) : (
        history.slice(0, 20).map((item) => (
          <View key={item.id} style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.name} numberOfLines={1}>
                {item.requested_by_name || `Inspector #${item.requested_by}`}
              </Text>
              <View
                style={[
                  styles.statusPill,
                  { backgroundColor: statusPalette(theme, item.status) + "22" },
                ]}
              >
                <Text
                  style={[
                    styles.statusText,
                    { color: statusPalette(theme, item.status) },
                  ]}
                >
                  {item.status}
                </Text>
              </View>
            </View>
            {item.reason ? (
              <Text style={styles.reason} numberOfLines={2}>
                "{item.reason}"
              </Text>
            ) : null}
            <Text style={styles.meta}>
              {item.requested_at ? `Requested ${fmt(item.requested_at)}` : ""}
              {item.denied_reason ? ` · denied: ${item.denied_reason}` : ""}
            </Text>
            {item.status === "consumed" && !item.revoked_at ? (
              <Pressable
                style={styles.revokeBtn}
                onPress={() => revoke(item)}
                disabled={busyId === item.id}
              >
                <X size={15} color={theme.danger} />
                <Text style={[styles.actionBtnText, { color: theme.danger }]}>
                  Revoke session
                </Text>
              </Pressable>
            ) : null}
          </View>
        ))
      )}

      <PromptModal
        visible={!!denyTarget}
        title="Deny access request"
        message="Optionally tell the inspector why you're denying."
        fields={[
          {
            key: "reason",
            label: "Reason (optional)",
            placeholder: "Reason for denial",
            multiline: true,
          },
        ]}
        confirmLabel="Deny"
        destructive
        busy={denyBusy}
        onCancel={() => setDenyTarget(null)}
        onSubmit={submitDeny}
      />
    </ScrollView>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  container: { padding: 16, gap: 12, paddingBottom: 40 },
  intro: { fontSize: 13, color: theme.textSecondary, lineHeight: 18 },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: theme.danger + "1A",
    borderWidth: 1,
    borderColor: theme.danger + "55",
    borderRadius: theme.radius,
    padding: 12,
  },
  errorText: { flex: 1, fontSize: 13, color: theme.danger },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: theme.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 6,
  },
  card: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    padding: 16,
    gap: 8,
  },
  activeCard: { borderColor: theme.warning + "88" },
  activeTitle: { flex: 1, fontSize: 14, fontWeight: "700", color: theme.text },
  codeCard: { borderColor: theme.success + "88" },
  codeTitle: { flex: 1, fontSize: 14, fontWeight: "700", color: theme.text },
  codeNote: { fontSize: 12, color: theme.textSecondary, lineHeight: 17 },
  codeRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  codeBox: {
    flex: 1,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.success,
    borderRadius: theme.radius,
    paddingVertical: 12,
    alignItems: "center",
  },
  codeText: {
    fontSize: 26,
    fontWeight: "800",
    letterSpacing: 8,
    color: theme.success,
    fontVariant: ["tabular-nums"],
  },
  copyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  copyText: { color: theme.text, fontSize: 13, fontWeight: "600" },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { flex: 1, fontSize: 15, fontWeight: "700", color: theme.text },
  statusPill: {
    borderRadius: theme.radiusFull,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  statusText: { fontSize: 11, fontWeight: "600", textTransform: "capitalize" },
  reason: { fontSize: 13, color: theme.textSecondary, fontStyle: "italic" },
  meta: { fontSize: 11, color: theme.textMuted },
  actionRow: { flexDirection: "row", gap: 10, marginTop: 4 },
  actionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: theme.radiusSm,
    paddingVertical: 11,
  },
  approveBtn: { backgroundColor: theme.success },
  denyBtn: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  revokeBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: theme.radiusSm,
    paddingVertical: 11,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    marginTop: 4,
  },
  actionBtnText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  empty: { color: theme.textMuted, fontSize: 13, paddingVertical: 4 },
});