import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";

/**
 * Reusable themed list of approval requests (manual entry or overtime).
 * Mirrors the web client's manualEntry/PendingRequestsList.tsx — the request
 * details live under `metadata` (date, clock_in/clock_out or hours).
 */

export type RequestRow = {
  metadata?: Record<string, any> | null;
  reason?: string | null;
  reject_reason?: string | null;
  [k: string]: unknown;
};

const STATUS_BADGE: Record<string, { label: string; color: string; bg: string }> = {
  pending: { label: "Pending", color: "#f59e0b", bg: "rgba(245,158,11,0.12)" },
  approved: { label: "Approved", color: "#10b981", bg: "rgba(16,185,129,0.12)" },
  rejected: { label: "Rejected", color: "#ef4444", bg: "rgba(239,68,68,0.12)" },
};

function fmtDate(d?: string): string {
  if (!d) return "—";
  const dt = new Date(d + "T00:00:00");
  if (isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export default function PendingRequestsList({
  requests,
  keyField,
  statusField,
  renderTime,
  showReason = false,
  rejectLabel = "Reason: ",
  emptyText = "No requests yet.",
}: {
  requests: RequestRow[];
  keyField: string;
  statusField: string;
  renderTime: (meta: Record<string, any>) => string;
  showReason?: boolean;
  rejectLabel?: string;
  emptyText?: string;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  if (!requests || requests.length === 0) {
    return <Text style={styles.empty}>{emptyText}</Text>;
  }

  return (
    <View style={{ gap: 8 }}>
      {requests.map((r) => {
        const meta = r.metadata || {};
        const status = String((r as any)[statusField] ?? "pending");
        const badge = STATUS_BADGE[status] ?? STATUS_BADGE.pending;
        return (
          <View key={String((r as any)[keyField])} style={styles.item}>
            <View style={{ flex: 1 }}>
              <Text style={styles.date}>{fmtDate(meta.date)}</Text>
              <Text style={styles.time}>{renderTime(meta)}</Text>
              {showReason && r.reason ? (
                <Text style={styles.reason}>"{r.reason}"</Text>
              ) : null}
              {r.reject_reason ? (
                <Text style={styles.rejectReason}>
                  {rejectLabel}
                  {r.reject_reason}
                </Text>
              ) : null}
            </View>
            <View style={[styles.badge, { backgroundColor: badge.bg }]}>
              <Text style={[styles.badgeText, { color: badge.color }]}>
                {badge.label}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    empty: {
      color: theme.textMuted,
      fontSize: 13,
      paddingVertical: 16,
      textAlign: "center",
    },
    item: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radius,
      padding: 12,
    },
    date: { color: theme.text, fontSize: 14, fontWeight: "600" },
    time: { color: theme.textSecondary, fontSize: 12, marginTop: 2 },
    reason: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
    rejectReason: { color: theme.danger, fontSize: 12, marginTop: 2 },
    badge: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: theme.radiusFull,
    },
    badgeText: { fontSize: 11, fontWeight: "700" },
  });