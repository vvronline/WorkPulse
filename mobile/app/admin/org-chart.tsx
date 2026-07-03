import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack } from "expo-router";
import {
  Building2,
  ChevronDown,
  ChevronRight,
  Search,
  Users,
  X,
} from "../../src/icons";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { uploadUrl } from "../../src/config";
import { roleLabel } from "../../src/constants/roles";
import {
  getOrgChart,
  type OrgChartDepartment,
  type OrgChartNode,
  type OrgChartTeam,
} from "../../src/admin";

const EMPTY_DEPARTMENTS: OrgChartDepartment[] = [];
const EMPTY_TEAMS: OrgChartTeam[] = [];
const EMPTY_MEMBERS: OrgChartNode[] = [];

function initials(name?: string) {
  if (!name) return "?";
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "?";
}

function MemberChip({ m }: { m: OrgChartNode }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const avatar = uploadUrl(m.avatar);
  return (
    <View style={styles.chip}>
      <View style={styles.chipAvatar}>
        {avatar ? (
          <Image source={{ uri: avatar }} style={styles.chipAvatarImg} />
        ) : (
          <Text style={styles.chipAvatarText}>{initials(m.full_name)}</Text>
        )}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.chipName} numberOfLines={1}>
          {m.full_name}
        </Text>
        <Text style={styles.chipRole} numberOfLines={1}>
          {m.title || roleLabel(m.role)}
        </Text>
      </View>
    </View>
  );
}

function DeptCard({
  dept,
  teams,
  members,
}: {
  dept: OrgChartDepartment;
  teams: OrgChartTeam[];
  members: OrgChartNode[];
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [open, setOpen] = useState(true);
  const deptTeams = teams.filter((t) => t.department_id === dept.id);
  const deptDirectMembers = members.filter(
    (m) => m.department_id === dept.id && !m.team_id,
  );
  const totalCount = members.filter((m) => m.department_id === dept.id).length;

  return (
    <View style={styles.panel}>
      <Pressable style={styles.deptHeader} onPress={() => setOpen((o) => !o)}>
        {open ? (
          <ChevronDown size={16} color={theme.textSecondary} />
        ) : (
          <ChevronRight size={16} color={theme.textSecondary} />
        )}
        <View style={styles.deptIcon}>
          <Building2 size={16} color={theme.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.deptName}>{dept.name}</Text>
          {dept.head_name ? (
            <Text style={styles.deptSub}>Head: {dept.head_name}</Text>
          ) : null}
        </View>
        <View style={styles.countBadge}>
          <Text style={styles.countText}>{totalCount}</Text>
        </View>
      </Pressable>

      {open ? (
        <View style={styles.deptBody}>
          {deptTeams.length === 0 && deptDirectMembers.length === 0 ? (
            <Text style={styles.emptySmall}>
              No teams or members in this department yet.
            </Text>
          ) : null}

          {deptTeams.map((team) => {
            const tMembers = members.filter((m) => m.team_id === team.id);
            return (
              <View key={team.id} style={styles.teamCard}>
                <View style={styles.teamTitleRow}>
                  <Users size={13} color={theme.textSecondary} />
                  <Text style={styles.teamTitle}>{team.name}</Text>
                  <View style={styles.countBadgeSm}>
                    <Text style={styles.countTextSm}>{tMembers.length}</Text>
                  </View>
                  {team.lead_name ? (
                    <Text style={styles.teamLead} numberOfLines={1}>
                      · Lead: {team.lead_name}
                    </Text>
                  ) : null}
                </View>
                {tMembers.length > 0 ? (
                  <View style={styles.chipWrap}>
                    {tMembers.map((m) => (
                      <MemberChip key={m.id} m={m} />
                    ))}
                  </View>
                ) : (
                  <Text style={styles.emptySmall}>No members</Text>
                )}
              </View>
            );
          })}

          {deptDirectMembers.length > 0 ? (
            <View style={styles.unassignedSection}>
              <Text style={styles.unassignedLabel}>
                Not assigned to a team:
              </Text>
              <View style={styles.chipWrap}>
                {deptDirectMembers.map((m) => (
                  <MemberChip key={m.id} m={m} />
                ))}
              </View>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function TreeRow({
  member,
  childrenMap,
  depth,
}: {
  member: OrgChartNode;
  childrenMap: Map<number | string, OrgChartNode[]>;
  depth: number;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [open, setOpen] = useState(depth < 2);
  const children = childrenMap.get(member.id) || [];
  const hasChildren = children.length > 0;
  const avatar = uploadUrl(member.avatar);

  return (
    <View>
      <View style={[styles.treeRow, { marginLeft: depth * 16 }]}>
        {hasChildren ? (
          <Pressable onPress={() => setOpen((o) => !o)} hitSlop={6}>
            {open ? (
              <ChevronDown size={16} color={theme.textSecondary} />
            ) : (
              <ChevronRight size={16} color={theme.textSecondary} />
            )}
          </Pressable>
        ) : (
          <View style={styles.treeLeafDot} />
        )}
        <View style={styles.treeAvatar}>
          {avatar ? (
            <Image source={{ uri: avatar }} style={styles.treeAvatarImg} />
          ) : (
            <Text style={styles.treeAvatarText}>
              {initials(member.full_name)}
            </Text>
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.treeName} numberOfLines={1}>
            {member.full_name}
          </Text>
          <Text style={styles.treeMeta} numberOfLines={1}>
            {[
              member.title || roleLabel(member.role),
              member.department_name,
              member.team_name,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </View>
        {hasChildren ? (
          <View style={styles.countBadgeSm}>
            <Text style={styles.countTextSm}>{children.length}</Text>
          </View>
        ) : null}
      </View>
      {hasChildren && open
        ? children.map((c) => (
            <TreeRow
              key={c.id}
              member={c}
              childrenMap={childrenMap}
              depth={depth + 1}
            />
          ))
        : null}
    </View>
  );
}

export default function OrgChartScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [viewMode, setViewMode] = useState<"dept" | "tree">("dept");
  const [search, setSearch] = useState("");

  const {
    data,
    isLoading: loading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["admin", "orgChart"],
    queryFn: async () => {
      const r = await getOrgChart();
      const d = r.data as unknown;
      if (Array.isArray(d)) {
        // Legacy shape — bare array of members.
        return {
          departments: EMPTY_DEPARTMENTS,
          teams: EMPTY_TEAMS,
          members: d as OrgChartNode[],
        };
      }
      const obj = (d ?? {}) as {
        departments?: OrgChartDepartment[];
        teams?: OrgChartTeam[];
        members?: OrgChartNode[];
        nodes?: OrgChartNode[];
      };
      return {
        departments: Array.isArray(obj.departments)
          ? obj.departments
          : EMPTY_DEPARTMENTS,
        teams: Array.isArray(obj.teams) ? obj.teams : EMPTY_TEAMS,
        members: obj.members ?? obj.nodes ?? EMPTY_MEMBERS,
      };
    },
  });

  const departments = data?.departments ?? EMPTY_DEPARTMENTS;
  const teams = data?.teams ?? EMPTY_TEAMS;
  const members = data?.members ?? EMPTY_MEMBERS;
  const errorMessage = isError
    ? (error as any)?.response?.data?.error || "Failed to load org chart"
    : null;

  const q = search.trim().toLowerCase();

  const filteredMembers = useMemo(() => {
    if (!q) return members;
    return members.filter(
      (m) =>
        m.full_name?.toLowerCase().includes(q) ||
        m.email?.toLowerCase().includes(q) ||
        roleLabel(m.role).toLowerCase().includes(q) ||
        m.manager_name?.toLowerCase().includes(q) ||
        m.department_name?.toLowerCase().includes(q) ||
        m.team_name?.toLowerCase().includes(q),
    );
  }, [members, q]);

  const { childrenMap, roots } = useMemo(() => {
    const ids = new Set(members.map((m) => m.id));
    const map = new Map<number | string, OrgChartNode[]>();
    const rootList: OrgChartNode[] = [];
    for (const m of members) {
      const pid =
        m.manager_id != null && ids.has(m.manager_id) ? m.manager_id : null;
      if (pid == null) {
        rootList.push(m);
      } else {
        if (!map.has(pid)) map.set(pid, []);
        map.get(pid)!.push(m);
      }
    }
    return { childrenMap: map, roots: rootList };
  }, [members]);

  const filteredUnassigned = filteredMembers.filter(
    (m) => !m.department_id && !m.team_id,
  );

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Org Chart" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  if (errorMessage) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Org Chart" }} />
        <Text style={styles.empty}>{errorMessage}</Text>
        <Pressable style={styles.retryBtn} onPress={() => refetch()}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  const Header = (
    <View style={styles.controls}>
      <View style={styles.viewToggle}>
        <Pressable
          style={[styles.viewBtn, viewMode === "dept" && styles.viewBtnActive]}
          onPress={() => setViewMode("dept")}
        >
          <Building2
            size={14}
            color={viewMode === "dept" ? "#fff" : theme.textSecondary}
          />
          <Text
            style={[
              styles.viewBtnText,
              viewMode === "dept" && styles.viewBtnTextActive,
            ]}
          >
            By Department
          </Text>
        </Pressable>
        <Pressable
          style={[styles.viewBtn, viewMode === "tree" && styles.viewBtnActive]}
          onPress={() => setViewMode("tree")}
        >
          <Users
            size={14}
            color={viewMode === "tree" ? "#fff" : theme.textSecondary}
          />
          <Text
            style={[
              styles.viewBtnText,
              viewMode === "tree" && styles.viewBtnTextActive,
            ]}
          >
            Reporting Lines
          </Text>
        </Pressable>
      </View>

      <View style={styles.searchBox}>
        <Search size={15} color={theme.textMuted} />
        <TextInput
          style={styles.searchInput}
          placeholder="Filter by name, role, dept…"
          placeholderTextColor={theme.textMuted}
          value={search}
          onChangeText={setSearch}
        />
        {search ? (
          <Pressable onPress={() => setSearch("")} hitSlop={8}>
            <X size={16} color={theme.textMuted} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Org Chart" }} />

      {viewMode === "dept" ? (
        <ScrollView contentContainerStyle={styles.list}>
          {Header}

          {departments.length === 0 && filteredUnassigned.length === 0 ? (
            <Text style={styles.empty}>
              No departments yet. Add departments and teams to build your org
              chart.
            </Text>
          ) : null}

          {departments.map((dept) => {
            if (q) {
              const hasMatch = filteredMembers.some(
                (m) => m.department_id === dept.id,
              );
              const nameMatch = dept.name.toLowerCase().includes(q);
              if (!hasMatch && !nameMatch) return null;
            }
            return (
              <DeptCard
                key={dept.id}
                dept={dept}
                teams={teams}
                members={filteredMembers}
              />
            );
          })}

          {filteredUnassigned.length > 0 ? (
            <View style={styles.panel}>
              <View style={styles.deptHeader}>
                <View style={styles.deptIcon}>
                  <Users size={16} color={theme.textSecondary} />
                </View>
                <Text style={[styles.deptName, { flex: 1 }]}>Unassigned</Text>
                <View style={styles.countBadge}>
                  <Text style={styles.countText}>
                    {filteredUnassigned.length}
                  </Text>
                </View>
              </View>
              <View style={styles.deptBody}>
                <View style={styles.chipWrap}>
                  {filteredUnassigned.map((m) => (
                    <MemberChip key={m.id} m={m} />
                  ))}
                </View>
              </View>
            </View>
          ) : null}

          {q && filteredMembers.length === 0 ? (
            <Text style={styles.empty}>No members match "{search}".</Text>
          ) : null}
        </ScrollView>
      ) : (
        <FlatList
          data={roots}
          keyExtractor={(p) => String(p.id)}
          contentContainerStyle={styles.list}
          ListHeaderComponent={Header}
          renderItem={({ item }) => (
            <TreeRow member={item} childrenMap={childrenMap} depth={0} />
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>
              No reporting lines configured — assign managers to employees to
              build the hierarchy.
            </Text>
          }
        />
      )}
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.bg },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 12,
    },
    list: { padding: 16, gap: 12, paddingBottom: 40 },
    controls: { gap: 10 },
    viewToggle: {
      flexDirection: "row",
      gap: 8,
    },
    viewBtn: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingVertical: 9,
      borderRadius: theme.radiusSm,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.glassBorder,
    },
    viewBtnActive: {
      backgroundColor: theme.primary,
      borderColor: theme.primary,
    },
    viewBtnText: {
      fontSize: 13,
      color: theme.textSecondary,
      fontWeight: "600",
    },
    viewBtnTextActive: { color: "#fff" },
    searchBox: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: theme.inputBg,
      borderWidth: 1,
      borderColor: theme.inputBorder,
      borderRadius: theme.radiusSm,
      paddingHorizontal: 12,
    },
    searchInput: {
      flex: 1,
      paddingVertical: 10,
      color: theme.text,
      fontSize: 14,
    },
    panel: {
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radiusLg,
      overflow: "hidden",
    },
    deptHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      padding: 14,
    },
    deptIcon: {
      width: 32,
      height: 32,
      borderRadius: 8,
      backgroundColor: theme.primaryGlow,
      alignItems: "center",
      justifyContent: "center",
    },
    deptName: { fontSize: 15, fontWeight: "700", color: theme.text },
    deptSub: { fontSize: 11, color: theme.textMuted, marginTop: 1 },
    deptBody: {
      paddingHorizontal: 14,
      paddingBottom: 14,
      gap: 10,
    },
    countBadge: {
      backgroundColor: theme.primaryGlow,
      borderRadius: theme.radiusFull,
      minWidth: 26,
      paddingHorizontal: 8,
      paddingVertical: 3,
      alignItems: "center",
    },
    countText: { color: theme.primaryLight, fontSize: 12, fontWeight: "700" },
    countBadgeSm: {
      backgroundColor: theme.surface,
      borderRadius: theme.radiusFull,
      minWidth: 22,
      paddingHorizontal: 7,
      paddingVertical: 1,
      alignItems: "center",
    },
    countTextSm: {
      color: theme.textSecondary,
      fontSize: 11,
      fontWeight: "700",
    },
    teamCard: {
      backgroundColor: theme.surface,
      borderRadius: theme.radius,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      padding: 10,
      gap: 8,
    },
    teamTitleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
    teamTitle: { fontSize: 13, fontWeight: "600", color: theme.text },
    teamLead: { fontSize: 11, color: theme.textMuted, flexShrink: 1 },
    chipWrap: { gap: 8 },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: theme.bgElevated,
      borderRadius: theme.radiusSm,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      padding: 8,
    },
    chipAvatar: {
      width: 30,
      height: 30,
      borderRadius: 15,
      backgroundColor: theme.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    chipAvatarImg: { width: 30, height: 30, borderRadius: 15 },
    chipAvatarText: { color: "#fff", fontSize: 11, fontWeight: "700" },
    chipName: { fontSize: 13, fontWeight: "600", color: theme.text },
    chipRole: { fontSize: 11, color: theme.textSecondary },
    unassignedSection: { gap: 8 },
    unassignedLabel: {
      fontSize: 12,
      color: theme.textMuted,
      fontWeight: "500",
    },
    emptySmall: { fontSize: 12, color: theme.textMuted },
    treeRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radius,
      padding: 12,
      marginBottom: 8,
    },
    treeLeafDot: {
      width: 16,
      height: 16,
      alignItems: "center",
      justifyContent: "center",
    },
    treeAvatar: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: theme.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    treeAvatarImg: { width: 36, height: 36, borderRadius: 18 },
    treeAvatarText: { color: "#fff", fontSize: 12, fontWeight: "700" },
    treeName: { fontSize: 14, fontWeight: "600", color: theme.text },
    treeMeta: { fontSize: 11, color: theme.textSecondary, marginTop: 1 },
    empty: {
      color: theme.textMuted,
      fontSize: 13,
      textAlign: "center",
      paddingTop: 32,
    },
    retryBtn: {
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radiusSm,
      paddingHorizontal: 20,
      paddingVertical: 10,
    },
    retryText: { color: theme.text, fontSize: 14, fontWeight: "600" },
  });
