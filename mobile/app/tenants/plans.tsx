import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { Check, CreditCard, X } from "lucide-react-native";
import { theme } from "../../src/theme";
import { getPlanCatalog, type PlanCatalog } from "../../src/admin";

export default function PlansScreen() {
  const [catalog, setCatalog] = useState<PlanCatalog | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    getPlanCatalog()
      .then((r) => setCatalog(r.data))
      .catch(() => setCatalog(null))
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

  const plans = Object.entries(catalog?.plans || {});
  const featureLabels = catalog?.feature_labels || {};

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.list}>
      <Stack.Screen options={{ title: "Plans" }} />
      {plans.length === 0 ? (
        <Text style={styles.empty}>No plans configured.</Text>
      ) : (
        plans.map(([key, plan]) => {
          const features = Object.entries(plan.features || {});
          const limits = plan.limits || {};
          return (
            <View key={key} style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={styles.iconWrap}>
                  <CreditCard size={18} color={theme.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{plan.label || key}</Text>
                  <Text style={styles.meta}>
                    {plan.description || key}
                  </Text>
                </View>
              </View>

              <View style={styles.limitsRow}>
                <View style={styles.limitTile}>
                  <Text style={styles.limitValue}>
                    {limits.max_users ?? "∞"}
                  </Text>
                  <Text style={styles.limitLabel}>Max users</Text>
                </View>
                <View style={styles.limitTile}>
                  <Text style={styles.limitValue}>
                    {limits.max_storage_mb ? `${limits.max_storage_mb} MB` : "∞"}
                  </Text>
                  <Text style={styles.limitLabel}>Max storage</Text>
                </View>
              </View>

              {features.length > 0 ? (
                <View style={styles.featureList}>
                  {features.map(([fKey, enabled]) => (
                    <View key={fKey} style={styles.featureRow}>
                      {enabled ? (
                        <Check size={14} color={theme.success} />
                      ) : (
                        <X size={14} color={theme.textMuted} />
                      )}
                      <Text
                        style={[
                          styles.featureText,
                          !enabled && styles.featureTextOff,
                        ]}
                      >
                        {featureLabels[fKey] || fKey.replace(/_/g, " ")}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          );
        })
      )}
    </ScrollView>
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
    marginBottom: 12,
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
  limitsRow: { flexDirection: "row", gap: 10 },
  limitTile: {
    flex: 1,
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    padding: 10,
    alignItems: "center",
    gap: 2,
  },
  limitValue: { fontSize: 15, fontWeight: "700", color: theme.primary },
  limitLabel: {
    fontSize: 10,
    color: theme.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  featureList: { gap: 6 },
  featureRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  featureText: { fontSize: 13, color: theme.text },
  featureTextOff: { color: theme.textMuted },
  empty: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    paddingTop: 32,
  },
});