import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { CreditCard } from "lucide-react-native";
import { theme } from "../../src/theme";
import { getPlanCatalog, type Plan } from "../../src/admin";

export default function PlansScreen() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    getPlanCatalog()
      .then((r) => {
        const d = r.data as unknown;
        const arr = Array.isArray(d) ? d : ((d as any)?.plans ?? []);
        setPlans(arr);
      })
      .catch(() => setPlans([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Plans" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Plans" }} />
      <FlatList
        data={plans}
        keyExtractor={(p, i) => p.key || String(i)}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => {
          const featureList = Array.isArray(item.features)
            ? item.features
            : item.features
              ? Object.entries(item.features)
                  .filter(([, v]) => v)
                  .map(([k]) => k)
              : [];
          return (
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={styles.iconWrap}>
                  <CreditCard size={18} color={theme.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{item.name}</Text>
                  <Text style={styles.meta}>
                    {item.price != null ? `$${item.price}` : "—"}
                    {item.max_users != null
                      ? ` · up to ${item.max_users} users`
                      : ""}
                  </Text>
                </View>
              </View>
              {featureList.length > 0 ? (
                <View style={styles.featureRow}>
                  {featureList.map((f) => (
                    <View key={String(f)} style={styles.featureChip}>
                      <Text style={styles.featureText}>
                        {String(f).replace(/_/g, " ")}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          );
        }}
        ListEmptyComponent={<Text style={styles.empty}>No plans configured.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  list: { padding: 16, gap: 12, paddingBottom: 40 },
  card: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    padding: 16,
    gap: 12,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: theme.primaryGlow,
    alignItems: "center",
    justifyContent: "center",
  },
  name: { fontSize: 16, fontWeight: "700", color: theme.text },
  meta: { fontSize: 12, color: theme.textSecondary },
  featureRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  featureChip: {
    backgroundColor: theme.surface,
    borderRadius: theme.radiusFull,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  featureText: { fontSize: 11, color: theme.textSecondary, textTransform: "capitalize" },
  empty: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    paddingTop: 32,
  },
});