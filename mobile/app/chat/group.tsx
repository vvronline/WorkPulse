import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import {
  Crown,
  LogOut,
  Plus,
  Search as SearchIcon,
  Shield,
  X as XIcon,
} from "lucide-react-native";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import ChatAvatar from "../../src/components/ChatAvatar";
import { useAuth } from "../../src/auth/AuthContext";
import {
  getGroupMembers,
  updateGroup,
  leaveGroup,
  setGroupRole,
  transferGroupOwner,
  searchChatUsers,
  type GroupMember,
  type GroupRole,
} from "../../src/features";

/**
 * Group settings screen (mobile parity with the web GroupModal). Lets the
 * owner/admin rename the group, edit its description, add/remove members,
 * promote/demote admins, transfer ownership, and lets anyone leave. Controls
 * are gated on the caller's local role (my_role), which the server enforces too.
 */
export default function GroupSettings() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const { user } = useAuth();
  const params = useLocalSearchParams<{
    id: string;
    name?: string;
    description?: string;
    myRole?: string;
  }>();

  const convId = Number(params.id);
  const myRole: GroupRole = (params.myRole as GroupRole) || "member";
  const isAdminish = myRole === "owner" || myRole === "admin";
  const isOwner = myRole === "owner";

  const [members, setMembers] = useState<GroupMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState(params.name || "");
  const [description, setDescription] = useState(params.description || "");
  const [savingMeta, setSavingMeta] = useState(false);

  // Add-member modal state.
  const [addOpen, setAddOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<
    Array<{ id: number; full_name?: string; avatar?: string | null }>
  >([]);

  const load = useCallback(async () => {
    try {
      const { data } = await getGroupMembers(convId);
      setMembers(data);
    } catch {
      /* ignore */
    }
    setLoading(false);
  }, [convId]);

  useEffect(() => {
    load();
  }, [load]);

  const saveMeta = async () => {
    if (!isAdminish) return;
    setSavingMeta(true);
    try {
      await updateGroup(convId, {
        name: name.trim() || undefined,
        description: description.trim() || null,
      });
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save");
    }
    setSavingMeta(false);
  };

  const doSearch = useCallback(
    async (q: string) => {
      if (!q || q.length < 2) {
        setSearchResults([]);
        return;
      }
      try {
        const { data } = await searchChatUsers(q);
        const existing = new Set(members.map((m) => m.id));
        setSearchResults(data.filter((u) => !existing.has(u.id)));
      } catch {
        setSearchResults([]);
      }
    },
    [members],
  );

  const addMember = async (userId: number) => {
    try {
      await updateGroup(convId, { addUserIds: [userId] });
      setAddOpen(false);
      setSearch("");
      setSearchResults([]);
      load();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to add member");
    }
  };

  const removeMember = (m: GroupMember) => {
    Alert.alert("Remove member", `Remove ${m.full_name} from the group?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          try {
            await updateGroup(convId, { removeUserIds: [m.id] });
            load();
          } catch (e: any) {
            Alert.alert(
              "Error",
              e?.response?.data?.error || "Failed to remove member",
            );
          }
        },
      },
    ]);
  };

  const changeRole = async (m: GroupMember, role: "admin" | "member") => {
    try {
      await setGroupRole(convId, m.id, role);
      load();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to set role");
    }
  };

  const makeOwner = (m: GroupMember) => {
    Alert.alert(
      "Transfer ownership",
      `Make ${m.full_name} the owner? You will become an admin.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Transfer",
          style: "destructive",
          onPress: async () => {
            try {
              await transferGroupOwner(convId, m.id);
              router.back();
            } catch (e: any) {
              Alert.alert(
                "Error",
                e?.response?.data?.error || "Failed to transfer ownership",
              );
            }
          },
        },
      ],
    );
  };

  const doLeave = () => {
    Alert.alert("Leave group", "Are you sure you want to leave this group?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Leave",
        style: "destructive",
        onPress: async () => {
          try {
            await leaveGroup(convId);
            // Pop back to the chat list.
            router.replace("/(tabs)/chat");
          } catch (e: any) {
            Alert.alert(
              "Error",
              e?.response?.data?.error || "Failed to leave group",
            );
          }
        },
      },
    ]);
  };

  const memberActions = (m: GroupMember) => {
    if (!isAdminish) return;
    if (String(m.id) === String(user?.id)) return;
    if (m.role === "owner") return;
    const options: Array<{
      text: string;
      style?: "cancel" | "destructive";
      onPress?: () => void;
    }> = [];
    if (m.role === "admin") {
      options.push({
        text: "Remove admin",
        onPress: () => changeRole(m, "member"),
      });
    } else {
      options.push({
        text: "Make admin",
        onPress: () => changeRole(m, "admin"),
      });
    }
    if (isOwner) {
      options.push({ text: "Make owner", onPress: () => makeOwner(m) });
    }
    options.push({
      text: "Remove from group",
      style: "destructive",
      onPress: () => removeMember(m),
    });
    options.push({ text: "Cancel", style: "cancel" });
    Alert.alert(m.full_name || "Member", undefined, options);
  };

  const roleBadge = (role?: GroupRole) => {
    if (role === "owner")
      return (
        <View style={styles.badge}>
          <Crown size={11} color={theme.warning} />
          <Text style={styles.badgeText}>Owner</Text>
        </View>
      );
    if (role === "admin")
      return (
        <View style={styles.badge}>
          <Shield size={11} color={theme.warning} />
          <Text style={styles.badgeText}>Admin</Text>
        </View>
      );
    return null;
  };

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Group settings" }} />

      {/* Name + description (editable for admins). */}
      <View style={styles.section}>
        <Text style={styles.label}>Group name</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          editable={isAdminish}
          maxLength={100}
          placeholder="Group name"
          placeholderTextColor={theme.textMuted}
        />
        <Text style={styles.label}>Description</Text>
        <TextInput
          style={[styles.input, styles.inputMultiline]}
          value={description}
          onChangeText={setDescription}
          editable={isAdminish}
          maxLength={500}
          multiline
          placeholder="Add a description"
          placeholderTextColor={theme.textMuted}
        />
        {isAdminish && (
          <Pressable
            style={styles.saveBtn}
            onPress={saveMeta}
            disabled={savingMeta}
          >
            <Text style={styles.saveBtnText}>
              {savingMeta ? "Saving…" : "Save"}
            </Text>
          </Pressable>
        )}
      </View>

      {/* Members. */}
      <View style={styles.membersHeader}>
        <Text style={styles.sectionTitle}>
          {members.length} member{members.length !== 1 ? "s" : ""}
        </Text>
        {isAdminish && (
          <Pressable
            style={styles.addBtn}
            onPress={() => setAddOpen(true)}
            hitSlop={8}
          >
            <Plus size={18} color={theme.primary} />
            <Text style={styles.addBtnText}>Add</Text>
          </Pressable>
        )}
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 24 }} color={theme.primary} />
      ) : (
        <FlatList
          data={members}
          keyExtractor={(m) => String(m.id)}
          contentContainerStyle={{ paddingBottom: 100 }}
          renderItem={({ item: m }) => (
            <Pressable
              style={styles.memberRow}
              onPress={() => memberActions(m)}
              disabled={
                !isAdminish ||
                String(m.id) === String(user?.id) ||
                m.role === "owner"
              }
            >
              <ChatAvatar name={m.full_name} avatar={m.avatar} size={40} />
              <View style={{ flex: 1 }}>
                <Text style={styles.memberName} numberOfLines={1}>
                  {m.full_name}
                  {String(m.id) === String(user?.id) ? " (You)" : ""}
                </Text>
                {m.username ? (
                  <Text style={styles.memberSub} numberOfLines={1}>
                    @{m.username}
                  </Text>
                ) : null}
              </View>
              {roleBadge(m.role)}
            </Pressable>
          )}
        />
      )}

      {/* Leave group. */}
      <Pressable style={styles.leaveRow} onPress={doLeave}>
        <LogOut size={20} color={theme.danger} />
        <Text style={styles.leaveText}>Leave group</Text>
      </Pressable>

      {/* Add-member modal. */}
      <Modal
        visible={addOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setAddOpen(false)}
      >
        <View style={styles.modalOverlay}>
          <Pressable
            style={styles.modalScrim}
            onPress={() => setAddOpen(false)}
          />
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add members</Text>
              <Pressable onPress={() => setAddOpen(false)} hitSlop={8}>
                <XIcon size={22} color={theme.textSecondary} />
              </Pressable>
            </View>
            <View style={styles.searchWrap}>
              <SearchIcon size={18} color={theme.textMuted} />
              <TextInput
                style={styles.searchInput}
                value={search}
                onChangeText={(v) => {
                  setSearch(v);
                  doSearch(v);
                }}
                placeholder="Search users…"
                placeholderTextColor={theme.textMuted}
                autoFocus
              />
            </View>
            <FlatList
              data={searchResults}
              keyExtractor={(u) => String(u.id)}
              style={{ maxHeight: 360 }}
              renderItem={({ item: u }) => (
                <Pressable
                  style={styles.resultRow}
                  onPress={() => addMember(u.id)}
                >
                  <ChatAvatar name={u.full_name} avatar={u.avatar} size={36} />
                  <Text style={styles.resultName} numberOfLines={1}>
                    {u.full_name}
                  </Text>
                  <Plus size={18} color={theme.primary} />
                </Pressable>
              )}
              ListEmptyComponent={
                <Text style={styles.modalEmpty}>
                  {search.trim().length < 2
                    ? "Type at least 2 characters"
                    : "No users found"}
                </Text>
              }
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.bg },
    section: {
      marginHorizontal: 16,
      marginTop: 16,
      gap: 6,
    },
    label: {
      fontSize: 12,
      color: theme.textSecondary,
      fontFamily: theme.fontMedium,
      marginTop: 8,
    },
    input: {
      backgroundColor: theme.inputBg,
      borderWidth: 1,
      borderColor: theme.inputBorder,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      color: theme.text,
      fontSize: 15,
    },
    inputMultiline: { minHeight: 60, textAlignVertical: "top" },
    saveBtn: {
      alignSelf: "flex-end",
      marginTop: 10,
      backgroundColor: theme.primary,
      paddingHorizontal: 20,
      paddingVertical: 9,
      borderRadius: 8,
    },
    saveBtnText: { color: "#fff", fontWeight: "600", fontSize: 14 },
    membersHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      marginTop: 22,
      marginBottom: 6,
    },
    sectionTitle: {
      fontSize: 13,
      color: theme.textSecondary,
      fontFamily: theme.fontBold,
      textTransform: "uppercase",
    },
    addBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
    addBtnText: { color: theme.primary, fontWeight: "600", fontSize: 14 },
    memberRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    memberName: { fontSize: 15, color: theme.text, fontFamily: theme.fontMedium },
    memberSub: { fontSize: 12, color: theme.textMuted },
    badge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
      backgroundColor: theme.surface,
      borderRadius: 10,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    badgeText: { fontSize: 11, color: theme.warning, fontWeight: "600" },
    leaveRow: {
      position: "absolute",
      bottom: 0,
      left: 0,
      right: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 16,
      backgroundColor: theme.bg,
      borderTopWidth: 1,
      borderTopColor: theme.border,
    },
    leaveText: { fontSize: 15, color: theme.danger, fontFamily: theme.fontMedium },
    modalOverlay: { flex: 1, justifyContent: "flex-end" },
    modalScrim: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: "rgba(0,0,0,0.6)",
    },
    modalSheet: {
      backgroundColor: theme.bgElevated,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      padding: 16,
      paddingBottom: 28,
      maxHeight: "75%",
    },
    modalHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 12,
    },
    modalTitle: { fontSize: 16, fontWeight: "700", color: theme.text },
    searchWrap: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: theme.inputBg,
      borderWidth: 1,
      borderColor: theme.inputBorder,
      borderRadius: 10,
      paddingHorizontal: 12,
      marginBottom: 10,
    },
    searchInput: { flex: 1, paddingVertical: 10, color: theme.text, fontSize: 15 },
    resultRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 10,
    },
    resultName: { flex: 1, fontSize: 15, color: theme.text },
    modalEmpty: {
      fontSize: 13,
      color: theme.textMuted,
      textAlign: "center",
      paddingVertical: 24,
    },
  });