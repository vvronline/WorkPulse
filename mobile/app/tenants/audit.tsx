import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { theme } from "../../src/theme";
import {
  getPlatformAuditLogs,
  getTenants,
  type AuditLog,
  type Tenant,
} from "../../src/admin";

const PAGE_SIZE = 50;

// Mirrors web PlatformAuditLogs ACTION_COLORS keys (used for the action filter).
const KNOWN_ACTIONS = [
  "tenant_created",
  "tenant_updated",
  "tenant_suspended",
  "tenant_reactivated",
  "tenant_soft_deleted",
  "tenant_hard_deleted",
  "tenant_domain_changed",
  "tenant_features_updated",
  "tenant_limits_updated",
  "tenant_impersonation_session",
  "tenant_user_created",
  "tenant_user_deactivated",
  "tenant_seeded",
  "platform_admin_created",
  "platform_admin_deactivated",
  "platform_admin_reactivated",
  "platform_admin_reset_password",
];

const ENTITY_TYPES = ["tenant", "platform_user", "user"];

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function actionColor(action: string): string {
  if (/delete|reject|deactivate|suspend/.test(action)) return theme.danger;
  if (/create|approve|reactivate|seeded/.test(action)) return theme.success;
  if (/update|role|reset|domain|features|limits/.test(action)) return theme.warning;
  if (/impersonation/.test(action)) return "#f97316";
  return theme.primary;
}

type ExtendedLog = AuditLog & {
  tenant_name?: string | null;
  user_agent?: string | null;
  ended_at?: string | null;
};

function parseDetails(d: unknown): Record<string, unknown> | null {
  if (!d) return null;
  if (typeof d === "string") {
    try {
      return JSON.parse(d);
    } catch {
      return null;
    }
  }
  if (typeof d === "object") return d as Record<string, unknown>;
  return null;
}

export default function PlatformAuditScreen() {
  const [logs, setLogs] = useState<ExtendedLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Filters (mirror web: entity type, action, tenant)
  const [entityFilter, setEntityFilter] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [tenantFilter, setTenantFilter] = useState<number | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);

  useEffect(() => {
    getTenants({ limit: 200 })
      .then((r) => setTenants(r.data.tenants || []))
      .catch(() => {});
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    const params: Record<string, string | number> = {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    };
    if (entityFilter) params.entity_type = entityFilter;
    if (actionFilter) params.action = actionFilter;
    if (tenantFilter != null) params.tenant_id = tenantFilter;
    getPlatformAuditLogs(params)
      .then((r) => {
        setLogs((r.data.logs || []) as ExtendedLog[]);
        setTotal(r.data.total || 0);
      })
      .catch(() => setLogs([]))
      .finally(() => setLoading(false));
  }, [page, entityFilter, actionFilter, tenantFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  function FilterChips<T extends string | number | null>({
    options,
    value,
    onChange,
  }: {
    options: { key: T; label: string }[];
    value: T;
    onChange: (v: T) => void;
  }) {
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
      >
        {options.map((o, i) => {
          const active = value === o.key;
          return (
            <Pressable
              key={`${String(o.key)}-${i}`}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => onChange(o.key)}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Audit Trail" }} />

      {/* Filters */}
      <View style={styles.filters}>
        <FilterChips
          options={[
            { key: "", label: "All entities" },
            ...ENTITY_TYPES.map((t) => ({
              key: t,
              label: t.replace("_", " "),
            })),
          ]}
          value={entityFilter}
          onChange={(v) => {
            setEntityFilter(v);
            setPage(0);
          }}
        />
        <FilterChips
          options={[
            { key: "", label: "All actions" },
            ...KNOWN_ACTIONS.map((a) => ({
              key: a,
              label: a.replace(/_/g, " "),
            })),
          ]}
          value={actionFilter}
          onChange={(v) => {
            setActionFilter(v);
            setPage(0);
          }}
        />
        {tenants.length > 0 ? (
          <FilterChips
            options={[
              { key: null, label: "All tenants" },
              ...tenants.map((t) => ({
                key: t.id as number | null,
                label: t.org_name,
              })),
            ]}
            value={tenantFilter}
            onChange={(v) => {
              setTenantFilter(v);
              setPage(0);
            }}
          />
        ) : null}
        <Text style={styles.countText}>
          {total} event{total !== 1 ? "s" : ""}
        </Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.primary} />
        </View>
      ) : (
        <FlatList
          data={logs}
          keyExtractor={(l) => String(l.id)}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => {
            const isExpanded = expandedId === item.id;
            const details = parseDetails(item.details);
            const isSession = item.action === "tenant_impersonation_session";
            return (
              <Pressable
                style={styles.card}
                onPress={() => setExpandedId(isExpanded ? null : item.id)}
              >
                <View style={styles.cardHeader}>
                  <View
                    style={[
                      styles.actionDot,
                      { backgroundColor: actionColor(item.action) },
                    ]}
                  />
                  <Text style={styles.action}>
                    {item.action.replace(/_/g, " ")}
                  </Text>
                  <Text style={styles.time}>{fmtTime(item.created_at)}</Text>
                </View>
                <Text style={styles.detail}>
                  {item.entity_type}
                  {item.entity_id ? ` #${item.entity_id}` : ""}
                  {item.actor_name ? ` · by ${item.actor_name}` : ""}
                  {item.tenant_name ? ` · ${item.tenant_name}` : ""}
                </Text>
                {item.ip_address ? (
                  <Text style={styles.ip}>IP: {item.ip_address}</Text>
                ) : null}

                {isExpanded && details ? (
                  <View style={styles.expanded}>
                    {isSession && details.duration_seconds != null ? (
                      <>
                        <View style={styles.sessionStats}>
                          <SessionStat
                            label="Duration"
                            value={
                              Number(details.duration_seconds) < 60
                                ? `${details.duration_seconds}s`
                                : `${Math.floor(Number(details.duration_seconds) / 60)}m ${Number(details.duration_seconds) % 60}s`
                            }
                          />
                          <SessionStat
                            label="Reads"
                            value={String(details.reads || 0)}
                          />
                          <SessionStat
                            label="Writes"
                            value={String(details.writes || 0)}
                          />
                          <SessionStat
                            label="Actions"
                            value={String(details.total_actions || 0)}
                          />
                        </View>
                        {Array.isArray(details.actions) &&
                        details.actions.length > 0 ? (
                          <View style={styles.actionLog}>
                            {(details.actions as any[])
                              .slice(0, 20)
                              .map((a, i) => (
                                <View key={i} style={styles.actionLogRow}>
                                  <Text
                                    style={[
                                      styles.actionMethod,
                                      {
                                        color:
                                          a.type === "write"
                                            ? theme.warning
                                            : theme.success,
                                      },
                                    ]}
                                  >
                                    {a.method}
                                  </Text>
                                  <Text
                                    style={styles.actionPath}
                                    numberOfLines={1}
                                  >
                                    {a.path}
                                  </Text>
                                </View>
                              ))}
                          </View>
                        ) : null}
                      </>
                    ) : (
                      <Text style={styles.jsonText}>
                        {JSON.stringify(details, null, 2)}
                      </Text>
                    )}
                  </View>
                ) : null}
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <Text style={styles.empty}>No audit entries.</Text>
          }
          ListFooterComponent={
            totalPages > 1 ? (
              <View style={styles.pager}>
                <Pressable
                  style={[styles.pagerBtn, page === 0 && styles.pagerBtnDisabled]}
                  disabled={page === 0}
                  onPress={() => setPage((p) => Math.max(0, p - 1))}
                >
                  <Text style={styles.pagerText}>Previous</Text>
                </Pressable>
                <Text style={styles.pagerInfo}>
                  {page + 1} / {totalPages}
                </Text>
                <Pressable
                  style={[
                    styles.pagerBtn,
                    page >= totalPages - 1 && styles.pagerBtnDisabled,
                  ]}
                  disabled={page >= totalPages - 1}
                  onPress={() => setPage((p) => p + 1)}
                >
                  <Text style={styles.pagerText}>Next</Text>
                </Pressable>
              </View>
            ) : null
          }
        />
      )}
    </View>
  );
}

function SessionStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.sessionStat}>
      <Text style={styles.sessionStatValue}>{value}</Text>
      <Text style={styles.sessionStatLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  filters: { paddingTop: 10, gap: 6 },
  chipRow: { paddingHorizontal: 16, gap: 6 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: theme.radiusFull,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    marginRight: 6,
  },
  chipActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  chipText: {
    fontSize: 12,
    color: theme.textSecondary,
    fontWeight: "500",
    textTransform: "capitalize",
  },
  chipTextActive: { color: "#fff", fontWeight: "600" },
  countText: {
    fontSize: 11,
    color: theme.textMuted,
    paddingHorizontal: 16,
    paddingTop: 2,
  },
  list: { padding: 16, paddingTop: 8, gap: 8, paddingBottom: 40 },
  card: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 14,
    gap: 5,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  actionDot: { width: 8, height: 8, borderRadius: 4 },
  action: {
    flex: 1,
    fontSize: 14,
    fontWeight: "700",
    color: theme.text,
    textTransform: "capitalize",
  },
  time: { fontSize: 11, color: theme.textMuted },
  detail: { fontSize: 13, color: theme.textSecondary },
  ip: { fontSize: 11, color: theme.textMuted },
  expanded: {
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: theme.border,
    paddingTop: 8,
    gap: 8,
  },
  jsonText: {
    fontSize: 11,
    color: theme.textSecondary,
    fontFamily: "monospace",
  },
  sessionStats: { flexDirection: "row", gap: 8 },
  sessionStat: {
    flex: 1,
    backgroundColor: theme.surface,
    borderRadius: theme.radiusSm,
    padding: 8,
    alignItems: "center",
    gap: 2,
  },
  sessionStatValue: { fontSize: 13, fontWeight: "700", color: theme.primary },
  sessionStatLabel: {
    fontSize: 9,
    color: theme.textMuted,
    textTransform: "uppercase",
  },
  actionLog: { gap: 4 },
  actionLogRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  actionMethod: { fontSize: 10, fontWeight: "700", width: 46 },
  actionPath: { flex: 1, fontSize: 11, color: theme.textSecondary },
  empty: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    paddingTop: 32,
  },
  pager: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
  },
  pagerBtn: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  pagerBtnDisabled: { opacity: 0.4 },
  pagerText: { color: theme.text, fontSize: 13, fontWeight: "600" },
  pagerInfo: { color: theme.textSecondary, fontSize: 13 },
});