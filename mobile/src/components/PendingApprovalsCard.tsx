import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { Check, ClipboardCheck, X } from "../icons";
import type { Theme } from "../theme";
import { useTheme } from "../theme/ThemeProvider";
import {
  approveRequest,
  getApprovals,
  rejectRequest,
  type Approval,
} from "../features";

export default function PendingApprovalsCard() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [items, setItems] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [actioning, setActioning] = useState<number | string>("");

  const load = useCallback(async () => {
    try {
      const { data } = await getApprovals({ status: "pending" });
      setItems(data || []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleApprove = useCallback(
    async (id: number | string) => {
      setActioning(id);
      try {
        await approveRequest(Number(id));
        await load();
      } catch {
        /* ignore */
      } finally {
        setActioning("");
      }
    },
    [load],
  );

  const handleReject = useCallback(
    async (id: number | string) => {
      setActioning(id);
      try {
        await rejectRequest(Number(id));
        await load();
      } catch {
        /* ignore */
      } finally {
        setActioning("");
      }
    },
    [load],
  );

  // Hide the card entirely when there's nothing to approve.
  if (loading || items.length === 0) return null;

  function typeLabel(t: string) {
    if (t === "manual_entry") return "Manual Entry";
    if (t === "leave") return "Leave";
    if (t === "leave_withdraw") return "Leave Withdraw";
    if (t === "overtime") return "Overtime";
    return t;
  }

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.6 }]}
      onPress={() => router.push("/team")}
    >
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <ClipboardCheck size={16} color={theme.primary} />
          <Text style={styles.title}>Pending Approvals</Text>
          <View style={styles.countBadge}>
            <Text style={styles.countText}>{items.length}</Text>
          </View>
        </View>
        <Text style={styles.chevron}>›</Text>
      </View>

      {items.slice(0, 3).map((a) => {
        const name = a.requester_name || "User";
        const busy = actioning === a.id;
        return (
          // Stop row taps (and the inline buttons) from triggering the card's
          // navigate-to-team handler.
          <Pressable
            key={a.id}
            style={styles.row}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.dot} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowName} numberOfLines={1}>
                {name}
              </Text>
              <Text style={styles.rowType}>{typeLabel(a.type)}</Text>
            </View>
            <Pressable
              style={[styles.actionBtn, styles.approveBtn]}
              onPress={() => handleApprove(a.id)}
              disabled={!!actioning}
              hitSlop={6}
            >
              {busy ? (
                <ActivityIndicator size="small" color={theme.success} />
              ) : (
                <Check size={15} color={theme.success} />
              )}
            </Pressable>
            <Pressable
              style={[styles.actionBtn, styles.rejectBtn]}
              onPress={() => handleReject(a.id)}
              disabled={!!actioning}
              hitSlop={6}
            >
              <X size={15} color={theme.danger} />
            </Pressable>
          </Pressable>
        );
      })}

      {items.length > 3 ? (
        <Text style={styles.viewAll}>View all {items.length} →</Text>
      ) : null}
    </Pressable>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
  card: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    padding: 16,
    gap: 10,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { fontSize: 15, fontWeight: "700", color: theme.text },
  chevron: { fontSize: 20, color: theme.textMuted },
  countBadge: {
    backgroundColor: theme.primaryGlow,
    borderRadius: theme.radiusFull,
    paddingHorizontal: 8,
    paddingVertical: 1,
  },
  countText: { color: theme.primaryLight, fontSize: 11, fontWeight: "700" },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.warning },
  rowName: { fontSize: 13, color: theme.text },
  rowType: {
    fontSize: 12,
    color: theme.textSecondary,
    textTransform: "capitalize",
  },
  actionBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  approveBtn: {
    borderColor: theme.success + "55",
    backgroundColor: theme.success + "1a",
  },
  rejectBtn: {
    borderColor: theme.danger + "55",
    backgroundColor: theme.danger + "1a",
  },
  viewAll: {
    fontSize: 12,
    fontWeight: "600",
    color: theme.primary,
    marginTop: 2,
  },
});
