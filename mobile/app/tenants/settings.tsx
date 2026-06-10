import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { Settings2 } from "lucide-react-native";
import { theme } from "../../src/theme";
import { getPlatformConfig } from "../../src/admin";

export default function PlatformSettingsScreen() {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    getPlatformConfig()
      .then((r) => setConfig(r.data))
      .catch(() => setConfig(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Platform Settings" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  const entries = config ? Object.entries(config) : [];

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: "Platform Settings" }} />
      <View style={styles.headerRow}>
        <Settings2 size={18} color={theme.primary} />
        <Text style={styles.heading}>Global platform configuration</Text>
      </View>
      <Text style={styles.note}>
        These settings apply across every tenant on the install.
      </Text>

      {entries.length === 0 ? (
        <Text style={styles.empty}>No configuration available.</Text>
      ) : (
        <View style={styles.card}>
          {entries.map(([k, v], i) => (
            <View
              key={k}
              style={[styles.row, i < entries.length - 1 && styles.rowBorder]}
            >
              <Text style={styles.key}>{k.replace(/_/g, " ")}</Text>
              <Text style={styles.value} numberOfLines={2}>
                {typeof v === "boolean"
                  ? v
                    ? "Enabled"
                    : "Disabled"
                  : typeof v === "object"
                    ? JSON.stringify(v)
                    : String(v)}
              </Text>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: "center", justifyContent: "center" },
  container: { padding: 16, gap: 10, paddingBottom: 40 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  heading: { fontSize: 17, fontWeight: "700", color: theme.text },
  note: { fontSize: 13, color: theme.textSecondary, marginBottom: 4 },
  card: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: theme.border },
  key: {
    flex: 1,
    fontSize: 14,
    color: theme.text,
    textTransform: "capitalize",
  },
  value: { fontSize: 13, color: theme.textSecondary, flexShrink: 1, textAlign: "right" },
  empty: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    paddingTop: 24,
  },
});