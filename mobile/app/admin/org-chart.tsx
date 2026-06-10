import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { theme } from "../../src/theme";
import { uploadUrl } from "../../src/config";
import { roleLabel } from "../../src/constants/roles";
import { getOrgChart, type OrgChartNode } from "../../src/admin";

function initials(name?: string) {
  if (!name) return "?";
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "?";
}

export default function OrgChartScreen() {
  const [nodes, setNodes] = useState<OrgChartNode[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    getOrgChart()
      .then((r) => {
        const d = r.data as unknown;
        const arr = Array.isArray(d) ? d : ((d as any)?.nodes ?? []);
        setNodes(arr);
      })
      .catch(() => setNodes([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Org Chart" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  // Group reports by manager for a simple hierarchical list.
  const byManager = new Map<number | string, OrgChartNode[]>();
  const roots: OrgChartNode[] = [];
  for (const n of nodes) {
    if (n.manager_id == null) {
      roots.push(n);
    } else {
      const key = n.manager_id;
      if (!byManager.has(key)) byManager.set(key, []);
      byManager.get(key)!.push(n);
    }
  }

  function renderPerson(p: OrgChartNode, depth: number) {
    const avatar = uploadUrl(p.avatar);
    const reports = byManager.get(p.id) || [];
    return (
      <View key={p.id}>
        <View style={[styles.card, { marginLeft: depth * 16 }]}>
          <View style={styles.avatar}>
            {avatar ? (
              <Image source={{ uri: avatar }} style={styles.avatarImg} />
            ) : (
              <Text style={styles.avatarText}>{initials(p.full_name)}</Text>
            )}
          </View>
          <View style={styles.body}>
            <Text style={styles.name} numberOfLines={1}>
              {p.full_name}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {[p.title || roleLabel(p.role), p.department_name]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </View>
          {reports.length > 0 ? (
            <View style={styles.countBadge}>
              <Text style={styles.countText}>{reports.length}</Text>
            </View>
          ) : null}
        </View>
        {reports.map((r) => renderPerson(r, depth + 1))}
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Org Chart" }} />
      <FlatList
        data={roots}
        keyExtractor={(p) => String(p.id)}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => renderPerson(item, 0)}
        ListEmptyComponent={
          <Text style={styles.empty}>No org chart data.</Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: "center", justifyContent: "center" },
  list: { padding: 16, gap: 8, paddingBottom: 40 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 12,
    marginBottom: 8,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarImg: { width: 40, height: 40, borderRadius: 20 },
  avatarText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  body: { flex: 1, gap: 2 },
  name: { fontSize: 15, fontWeight: "600", color: theme.text },
  meta: { fontSize: 12, color: theme.textSecondary },
  countBadge: {
    backgroundColor: theme.primaryGlow,
    borderRadius: theme.radiusFull,
    minWidth: 26,
    paddingHorizontal: 8,
    paddingVertical: 3,
    alignItems: "center",
  },
  countText: { color: theme.primaryLight, fontSize: 12, fontWeight: "700" },
  empty: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    paddingTop: 32,
  },
});