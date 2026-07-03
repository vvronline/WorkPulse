import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { GitBranch, GitMerge, RefreshCw, Trash2 } from "../../src/icons";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import {
  deleteIntegration,
  disconnectGithub,
  getGithubStatus,
  getIntegrations,
  type GithubStatus,
  type Integration,
} from "../../src/admin";

const EMPTY_INTEGRATIONS: Integration[] = [];

export default function IntegrationsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const queryClient = useQueryClient();

  const { data, isLoading: loading } = useQuery({
    queryKey: ["admin", "integrations"],
    queryFn: async () => {
      const [listR, ghR] = await Promise.allSettled([
        getIntegrations(),
        getGithubStatus(),
      ]);
      let items: Integration[] = EMPTY_INTEGRATIONS;
      let error: string | null = null;
      if (listR.status === "fulfilled") {
        const d = listR.value.data as unknown;
        items = Array.isArray(d)
          ? (d as Integration[])
          : ((d as { integrations?: Integration[] })?.integrations ??
            EMPTY_INTEGRATIONS);
      } else {
        const e = listR.reason as any;
        error = e?.response?.data?.error || "Failed to load integrations";
      }
      const github =
        ghR.status === "fulfilled" ? (ghR.value.data as GithubStatus) : null;
      return { items, github, error };
    },
  });
  const items = data?.items ?? EMPTY_INTEGRATIONS;
  const github = data?.github ?? null;
  const error = data?.error ?? null;

  function confirmDisconnectGithub() {
    Alert.alert(
      "Disconnect GitHub",
      "Disconnect the GitHub integration? Connected repos and webhooks will be removed.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: () =>
            disconnectGithub()
              .then(() =>
                queryClient.invalidateQueries({
                  queryKey: ["admin", "integrations"],
                }),
              )
              .catch((e: any) =>
                Alert.alert(
                  "Error",
                  e?.response?.data?.error || "Failed to disconnect",
                ),
              ),
        },
      ],
    );
  }

  function confirmDelete(i: Integration) {
    Alert.alert("Remove integration", `Remove "${i.provider}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () =>
          deleteIntegration(i.id)
            .then(() =>
              queryClient.invalidateQueries({
                queryKey: ["admin", "integrations"],
              }),
            )
            .catch((e: any) =>
              Alert.alert(
                "Error",
                e?.response?.data?.error || "Failed to remove",
              ),
            ),
      },
    ]);
  }

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Integrations" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Integrations" }} />
      <FlatList
        data={items}
        keyExtractor={(i) => String(i.id)}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={styles.ghCard}>
            <View style={styles.ghHeader}>
              <GitBranch size={20} color={theme.text} />
              <Text style={styles.ghTitle}>GitHub</Text>
              <View
                style={[
                  styles.statusPill,
                  {
                    backgroundColor: github?.connected
                      ? theme.success + "22"
                      : theme.surface,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.statusText,
                    {
                      color: github?.connected
                        ? theme.success
                        : theme.textMuted,
                    },
                  ]}
                >
                  {github?.connected ? "Connected" : "Not connected"}
                </Text>
              </View>
            </View>
            {github?.connected ? (
              <>
                {github.account ? (
                  <Text style={styles.ghMeta}>Account: {github.account}</Text>
                ) : null}
                {Array.isArray(github.repos) && github.repos.length > 0 ? (
                  <Text style={styles.ghMeta}>
                    {github.repos.length} repo
                    {github.repos.length === 1 ? "" : "s"} connected
                  </Text>
                ) : null}
                <Pressable
                  style={styles.dangerBtn}
                  onPress={confirmDisconnectGithub}
                >
                  <Text style={styles.dangerBtnText}>Disconnect GitHub</Text>
                </Pressable>
              </>
            ) : (
              <Text style={styles.ghHint}>
                Connecting GitHub requires an OAuth popup — use the web admin
                console (Admin → Integrations) to connect. Once connected, the
                status and connected repos appear here.
              </Text>
            )}
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.iconWrap}>
              <GitMerge size={18} color={theme.primary} />
            </View>
            <View style={styles.body}>
              <Text style={styles.name}>{item.provider}</Text>
              <Text style={styles.meta}>
                {item.status || "active"}
                {item.created_at
                  ? ` · added ${new Date(item.created_at).toLocaleDateString()}`
                  : ""}
              </Text>
            </View>
            <Pressable
              style={styles.iconBtn}
              onPress={() => confirmDelete(item)}
              hitSlop={6}
            >
              <Trash2 size={16} color={theme.danger} />
            </Pressable>
          </View>
        )}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {error ?? "No other integrations configured."}
          </Text>
        }
        ListFooterComponent={
          <Pressable
            style={styles.refreshBtn}
            onPress={() =>
              queryClient.invalidateQueries({
                queryKey: ["admin", "integrations"],
              })
            }
          >
            <RefreshCw size={14} color={theme.textSecondary} />
            <Text style={styles.refreshText}>Refresh</Text>
          </Pressable>
        }
      />
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.bg },
    center: { alignItems: "center", justifyContent: "center", flex: 1 },
    list: { padding: 16, gap: 10, paddingBottom: 40 },
    ghCard: {
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radiusLg,
      padding: 16,
      gap: 8,
      marginBottom: 6,
    },
    ghHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
    ghTitle: { flex: 1, fontSize: 16, fontWeight: "700", color: theme.text },
    statusPill: {
      borderRadius: theme.radiusFull,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    statusText: { fontSize: 11, fontWeight: "700" },
    ghMeta: { fontSize: 13, color: theme.textSecondary },
    ghHint: { fontSize: 12, color: theme.textMuted, lineHeight: 17 },
    dangerBtn: {
      borderWidth: 1,
      borderColor: theme.danger,
      borderRadius: theme.radiusSm,
      paddingVertical: 10,
      alignItems: "center",
      marginTop: 4,
    },
    dangerBtnText: { color: theme.danger, fontSize: 13, fontWeight: "600" },
    card: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radius,
      padding: 12,
    },
    iconWrap: {
      width: 38,
      height: 38,
      borderRadius: 10,
      backgroundColor: theme.primaryGlow,
      alignItems: "center",
      justifyContent: "center",
    },
    body: { flex: 1, gap: 2 },
    name: {
      fontSize: 15,
      fontWeight: "600",
      color: theme.text,
      textTransform: "capitalize",
    },
    meta: { fontSize: 12, color: theme.textSecondary },
    iconBtn: { padding: 6 },
    empty: {
      color: theme.textMuted,
      fontSize: 13,
      textAlign: "center",
      paddingVertical: 24,
    },
    refreshBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingVertical: 12,
    },
    refreshText: {
      fontSize: 13,
      color: theme.textSecondary,
      fontWeight: "500",
    },
  });
