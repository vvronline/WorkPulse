import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ClipboardCheck } from "lucide-react-native";
import { theme } from "../theme";
import { getApprovals, type Approval } from "../features";

export default function PendingApprovalsCard() {
  const router = useRouter();
  const [items, setItems] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);

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

  // Hide the card entirely when there's nothing to approve.
  if (loading || items.length === 0) return null;

  function typeLabel(t: string) {
    if (t === "manual_entry") return "Manual Entry";
    if (t === "leave") return "Leave";
    if (t === "overtime") return "Overtime";
    return t;
  }

  return (
    <Pressable
      style={styles.card}
      onPress={() => router.push("/team")}
      android_ripple={{ color: theme.surfaceHover }}
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
        return (
          <View key={a.id} style={styles.row}>
            <View style={styles.dot} />
            <Text style={styles.rowName} numberOfLines={1}>
              {name}
            </Text>
            <Text style={styles.rowType}>{typeLabel(a.type)}</Text>
          </View>
        );
      })}
    </Pressable>
  );
}

const styles = StyleSheet.create({
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
  rowName: { flex: 1, fontSize: 13, color: theme.text },
  rowType: {
    fontSize: 12,
    color: theme.textSecondary,
    textTransform: "capitalize",
  },
});