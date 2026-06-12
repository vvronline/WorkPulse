import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { useDialog } from "../src/hooks/useDialog";
import { socket } from "../src/realtime/socket";
import {
  Bell,
  Building2,
  Camera,
  Check,
  ChevronDown,
  Clock3,
  House,
  KeyRound,
  LogOut,
  Minus,
  Pencil,
  Phone,
  ScanFace,
  Trash2,
  Video,
  X,
} from "lucide-react-native";
import { useAuth } from "../src/auth/AuthContext";
import { theme } from "../src/theme";
import {
  changePassword,
  getFaceStatus,
  getMyStatus,
  getNotificationPrefs,
  getTrackerStatus,
  removeAvatar as apiRemoveAvatar,
  saveNotificationPrefs,
  setMyStatus,
  setPresencePreference,
  updateEmail,
  updateProfile,
  uploadAvatar,
  type FaceStatus,
  type ManualStatus,
  type NotificationPrefs,
  type StatusPayload,
  type TrackerStatus,
} from "../src/features";
import { uploadUrl } from "../src/config";

function initials(name?: string) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase().slice(0, 2);
}

/* ─── Status metadata (mirrors client/src/status/constants.ts) ─── */

type StatusGlyph = "check" | "dot" | "minus" | "clock" | "phone" | "video" | "ring";

type StatusMetaEntry = {
  label: string;
  color: string;
  glyph: StatusGlyph;
  pickable: boolean;
  auto?: boolean;
};

const STATUS_META: Record<string, StatusMetaEntry> = {
  available: { label: "Available", color: "#22c55e", glyph: "check", pickable: true },
  busy: { label: "Busy", color: "#ef4444", glyph: "dot", pickable: true },
  dnd: { label: "Do Not Disturb", color: "#ef4444", glyph: "minus", pickable: true },
  brb: { label: "Away", color: "#f59e0b", glyph: "clock", pickable: true },
  away: { label: "Away (idle)", color: "#f59e0b", glyph: "clock", pickable: false, auto: true },
  in_call: { label: "In a Call", color: "#ef4444", glyph: "phone", pickable: false, auto: true },
  in_meeting: { label: "In a Meeting", color: "#0ea5e9", glyph: "video", pickable: false, auto: true },
  offline: { label: "Offline", color: "#64748b", glyph: "ring", pickable: false },
};

const PICKABLE: ManualStatus[] = ["available", "busy", "dnd", "brb"];

function StatusGlyphIcon({ glyph, size = 9, color = "#fff" }: { glyph: StatusGlyph; size?: number; color?: string }) {
  if (glyph === "check") return <Check size={size} color={color} strokeWidth={3} />;
  if (glyph === "minus") return <Minus size={size} color={color} strokeWidth={3} />;
  if (glyph === "clock") return <Clock3 size={size} color={color} strokeWidth={2.6} />;
  if (glyph === "phone") return <Phone size={size} color={color} strokeWidth={2.6} />;
  if (glyph === "video") return <Video size={size} color={color} strokeWidth={2.6} />;
  return null;
}

function StatusDot({ meta, size = 14 }: { meta: StatusMetaEntry; size?: number }) {
  const isRing = meta.glyph === "ring";
  return (
    <View
      style={[
        styles.statusDot,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: isRing ? "transparent" : meta.color,
          borderWidth: isRing ? 2 : 0,
          borderColor: isRing ? meta.color : "transparent",
        },
      ]}
    >
      {!isRing && <StatusGlyphIcon glyph={meta.glyph} size={Math.round(size * 0.55)} />}
    </View>
  );
}

export default function Profile() {
  const { user, logout, refreshUser } = useAuth();
  const router = useRouter();
  const { alert, confirm, dialog } = useDialog();
  const [editOpen, setEditOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [soundsOpen, setSoundsOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [tracker, setTracker] = useState<TrackerStatus | null>(null);
  const [face, setFace] = useState<FaceStatus | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const { data } = await getMyStatus();
      setStatus(data);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadStatus();
    getTrackerStatus()
      .then((r) => setTracker(r.data))
      .catch(() => {});
    getFaceStatus()
      .then((r) => setFace(r.data))
      .catch(() => {});
  }, [loadStatus]);

  // Keep status live: subscribe to the unified `user_status` WS event so the
  // displayed state reflects server-side changes (mirrors web StatusContext).
  useEffect(() => {
    const off = socket.subscribe((msg) => {
      if (msg.type !== "user_status") return;
      const d = msg.data;
      if (!d || d.userId !== user?.id) return;
      setStatus((prev) => ({ ...(prev as StatusPayload), ...d }));
    });
    return off;
  }, [user?.id]);

  // Re-fetch authoritative status whenever the screen regains focus (covers
  // the case where the WS reconnected while the app was backgrounded).
  useFocusEffect(
    useCallback(() => {
      socket.connect();
      loadStatus();
    }, [loadStatus]),
  );

  const onLogout = async () => {
    await logout();
    router.replace("/login");
  };

  async function pickAvatar() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      alert("Permission needed", "Allow photo access to set an avatar.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (result.canceled || !result.assets?.[0]?.uri) return;
    setUploading(true);
    try {
      await uploadAvatar(result.assets[0].uri);
      await refreshUser();
    } catch (e: any) {
      alert("Error", e?.response?.data?.error || "Failed to upload avatar");
    } finally {
      setUploading(false);
    }
  }

  function confirmRemoveAvatar() {
    confirm({
      title: "Remove Photo",
      message: "Are you sure you want to remove your profile photo?",
      confirmText: "Remove",
      isDanger: true,
      onConfirm: async () => {
        try {
          await apiRemoveAvatar();
          await refreshUser();
        } catch (e: any) {
          alert("Error", e?.response?.data?.error || "Failed to remove photo");
        }
      },
    });
  }

  async function pickStatus(key: ManualStatus) {
    setStatusOpen(false);
    try {
      // Clearing "appear offline" first so the new status is visible
      // (mirrors the web StatusPicker: setInvisible(false) then
      // setManualStatus(key)).
      if (status?.presencePreference === "invisible") {
        const { data: pref } = await setPresencePreference("auto");
        setStatus(pref);
      }
      // Mirror the web exactly: setManualStatus(key) sends message + expiry as
      // null. Re-sending the previous `statusMessageExpiresAt` (a server-side
      // Date string) can fail the server's ISO-date validation → 400
      // "Invalid messageExpiresAt", which surfaced as "Failed to set status".
      const { data } = await setMyStatus({
        status: key,
        message: null,
        messageExpiresAt: null,
      });
      setStatus(data);
      // Re-fetch the authoritative effective state. The PUT response can
      // resolve to "offline" if the WS presence session isn't open yet;
      // re-reading shortly after reflects the real state.
      loadStatus();
    } catch (e: any) {
      alert("Error", e?.response?.data?.error || "Failed to set status");
    }
  }

  async function toggleInvisible() {
    setStatusOpen(false);
    const next = status?.presencePreference === "invisible" ? "auto" : "invisible";
    try {
      const { data } = await setPresencePreference(next);
      setStatus(data);
      loadStatus();
    } catch (e: any) {
      alert("Error", e?.response?.data?.error || "Failed to update preference");
    }
  }

  const avatarUri = uploadUrl(user?.avatar);
  const workState = tracker?.state ?? "logged_out";
  const workMode = tracker?.workMode ?? "office";

  const effective: string = status?.effective || "available";
  const isInvisible = status?.presencePreference === "invisible";
  const baseMeta = STATUS_META[effective] || STATUS_META.available;
  // For "available", the label reflects working state, mirroring web.
  const headerLabel =
    effective === "available" && workState === "on_floor"
      ? workMode === "remote"
        ? "Working Remotely"
        : "Working"
      : baseMeta.label;
  const headerMeta: StatusMetaEntry = { ...baseMeta, label: headerLabel };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.container, { paddingTop: 16 }]}
    >
      {/* Profile header */}
      <View style={styles.headerCard}>
        <View style={styles.avatarWrap}>
          <Pressable onPress={pickAvatar} disabled={uploading}>
            <View style={styles.avatar}>
              {avatarUri ? (
                <Image source={{ uri: avatarUri }} style={styles.avatarImg} />
              ) : (
                <Text style={styles.avatarText}>
                  {initials(user?.full_name || user?.username)}
                </Text>
              )}
            </View>
          </Pressable>
          <View style={styles.avatarStatus}>
            <StatusDot meta={headerMeta} size={20} />
          </View>
          <Pressable style={styles.avatarEdit} onPress={pickAvatar} disabled={uploading}>
            {uploading ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Camera size={13} color="#fff" />
            )}
          </Pressable>
        </View>

        <Text style={styles.name}>{user?.full_name || user?.username}</Text>
        <Text style={styles.username}>@{user?.username}</Text>
        {user?.email ? <Text style={styles.muted}>{user.email}</Text> : null}

        {/* Status + work-mode badges */}
        <View style={styles.badges}>
          <View style={[styles.statusBadge, { borderColor: headerMeta.color + "55" }]}>
            <StatusDot meta={headerMeta} size={12} />
            <Text style={styles.statusBadgeText}>
              {isInvisible ? "Appearing Offline" : headerMeta.label}
            </Text>
          </View>
          {workState !== "logged_out" && (
            <View style={styles.modeBadge}>
              {workMode === "office" ? (
                <Building2 size={12} color={theme.textSecondary} />
              ) : (
                <House size={12} color={theme.textSecondary} />
              )}
              <Text style={styles.modeBadgeText}>
                {workMode === "office" ? "Office" : "Remote"}
              </Text>
            </View>
          )}
        </View>
      </View>

      {/* Status Picker */}
      <Pressable style={styles.statusTrigger} onPress={() => setStatusOpen(true)}>
        <StatusDot meta={baseMeta} size={16} />
        <Text style={styles.statusTriggerLabel}>
          {isInvisible ? "Appear Offline" : baseMeta.label}
        </Text>
        {baseMeta.auto && <Text style={styles.autoBadge}>auto</Text>}
        <ChevronDown size={16} color={theme.textSecondary} />
      </Pressable>

      {/* Actions */}
      <Pressable style={styles.action} onPress={() => setEditOpen(true)}>
        <Pencil size={16} color={theme.text} />
        <Text style={styles.actionText}>Edit Profile</Text>
      </Pressable>
      {avatarUri ? (
        <Pressable style={styles.action} onPress={confirmRemoveAvatar}>
          <Trash2 size={16} color={theme.text} />
          <Text style={styles.actionText}>Remove Photo</Text>
        </Pressable>
      ) : null}
      <Pressable style={styles.action} onPress={() => setSoundsOpen(true)}>
        <Bell size={16} color={theme.text} />
        <Text style={styles.actionText}>Notification Sounds</Text>
      </Pressable>
      <Pressable
        style={styles.action}
        onPress={() => router.push("/profile/face")}
      >
        <ScanFace size={16} color={theme.text} />
        <Text style={styles.actionText}>Face Enrollment</Text>
        {face?.enrolled ? (
          <View style={styles.enrolledPill}>
            <Text style={styles.enrolledPillText}>Enrolled</Text>
          </View>
        ) : null}
      </Pressable>
      <Pressable style={styles.action} onPress={() => setPwOpen(true)}>
        <KeyRound size={16} color={theme.text} />
        <Text style={styles.actionText}>Change Password</Text>
      </Pressable>

      <TouchableOpacity style={styles.logout} onPress={onLogout} activeOpacity={0.85}>
        <LogOut size={16} color={theme.danger} />
        <Text style={styles.logoutText}>Sign Out</Text>
      </TouchableOpacity>

      {/* Status picker modal */}
      <StatusPickerModal
        visible={statusOpen}
        effective={effective}
        isInvisible={isInvisible}
        onClose={() => setStatusOpen(false)}
        onPick={pickStatus}
        onToggleInvisible={toggleInvisible}
      />

      <EditProfileModal
        visible={editOpen}
        initialName={user?.full_name ?? ""}
        initialUsername={user?.username ?? ""}
        initialEmail={user?.email ?? ""}
        onClose={() => setEditOpen(false)}
        onSaved={async () => {
          setEditOpen(false);
          await refreshUser();
        }}
      />
      <ChangePasswordModal
        visible={pwOpen}
        onClose={() => setPwOpen(false)}
        onChanged={onLogout}
      />
      <NotificationSoundsModal
        visible={soundsOpen}
        onClose={() => setSoundsOpen(false)}
      />

      {dialog}
    </ScrollView>
  );
}

/* ─── Status picker modal ─── */

function StatusPickerModal({
  visible,
  effective,
  isInvisible,
  onClose,
  onPick,
  onToggleInvisible,
}: {
  visible: boolean;
  effective: string;
  isInvisible: boolean;
  onClose: () => void;
  onPick: (key: ManualStatus) => void;
  onToggleInvisible: () => void;
}) {
  return (
    <ModalShell title="Set status" visible={visible} onClose={onClose}>
      {PICKABLE.map((key) => {
        const meta = STATUS_META[key];
        const active = effective === key && !isInvisible;
        return (
          <Pressable
            key={key}
            style={[styles.statusOption, active && styles.statusOptionActive]}
            onPress={() => onPick(key)}
          >
            <StatusDot meta={meta} size={16} />
            <Text style={styles.statusOptionLabel}>{meta.label}</Text>
            {active && <Check size={16} color={theme.primary} />}
          </Pressable>
        );
      })}
      <Pressable
        style={[styles.statusOption, isInvisible && styles.statusOptionActive]}
        onPress={onToggleInvisible}
      >
        <View style={styles.invisibleDot} />
        <Text style={styles.statusOptionLabel}>
          {isInvisible ? "Stop appearing offline" : "Appear Offline"}
        </Text>
        {isInvisible && <Check size={16} color={theme.primary} />}
      </Pressable>
    </ModalShell>
  );
}

/* ─── Edit Profile modal ─── */

function EditProfileModal({
  visible,
  initialName,
  initialUsername,
  initialEmail,
  onClose,
  onSaved,
}: {
  visible: boolean;
  initialName: string;
  initialUsername: string;
  initialEmail: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { alert, dialog } = useDialog();
  const [name, setName] = useState(initialName);
  const [username, setUsername] = useState(initialUsername);
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (visible) {
      setName(initialName);
      setUsername(initialUsername);
      setEmail(initialEmail);
    }
  }, [visible, initialName, initialUsername, initialEmail]);

  async function save() {
    setBusy(true);
    try {
      await updateProfile({ full_name: name.trim(), username: username.trim() });
      if (email.trim() && email.trim() !== initialEmail) {
        await updateEmail(email.trim());
      }
      onSaved();
    } catch (e: any) {
      alert("Error", e?.response?.data?.error || "Failed to update profile");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell title="Edit Profile" visible={visible} onClose={onClose}>
      <Text style={styles.label}>Full Name</Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder="Full name"
        placeholderTextColor={theme.textMuted}
      />
      <Text style={styles.label}>Username</Text>
      <TextInput
        style={styles.input}
        value={username}
        onChangeText={setUsername}
        placeholder="username"
        placeholderTextColor={theme.textMuted}
        autoCapitalize="none"
      />
      <Text style={styles.label}>Email</Text>
      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        placeholder="email@example.com"
        placeholderTextColor={theme.textMuted}
        autoCapitalize="none"
        keyboardType="email-address"
      />
      <Pressable
        style={[styles.submit, busy && styles.submitDisabled]}
        onPress={save}
        disabled={busy}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Save</Text>}
      </Pressable>
      {dialog}
    </ModalShell>
  );
}

/* ─── Change password modal ─── */

function ChangePasswordModal({
  visible,
  onClose,
  onChanged,
}: {
  visible: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { alert, dialog } = useDialog();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (next.length < 8) {
      alert("Weak password", "New password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      await changePassword({ current_password: current, new_password: next });
      setCurrent("");
      setNext("");
      // Sign the user out after a successful change (mirrors web). The themed
      // alert here is informational; logout happens immediately after.
      alert("Password changed", "Please sign in again with your new password.");
      onChanged();
    } catch (e: any) {
      alert("Error", e?.response?.data?.error || "Failed to change password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell title="Change Password" visible={visible} onClose={onClose}>
      <Text style={styles.label}>Current Password</Text>
      <TextInput
        style={styles.input}
        value={current}
        onChangeText={setCurrent}
        secureTextEntry
        placeholder="Current password"
        placeholderTextColor={theme.textMuted}
      />
      <Text style={styles.label}>New Password</Text>
      <TextInput
        style={styles.input}
        value={next}
        onChangeText={setNext}
        secureTextEntry
        placeholder="New password"
        placeholderTextColor={theme.textMuted}
      />
      <Pressable
        style={[styles.submit, busy && styles.submitDisabled]}
        onPress={save}
        disabled={busy}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Update</Text>}
      </Pressable>
      {dialog}
    </ModalShell>
  );
}

/* ─── Notification sounds modal ─── */

const MESSAGE_TONES = ["ding", "pop", "chime", "knock", "subtle", "none"];
const RINGTONES = ["classic", "calm", "dynamic", "urgent", "boop", "marimba", "none"];

function NotificationSoundsModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const [prefs, setPrefs] = useState<NotificationPrefs>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    getNotificationPrefs()
      .then((r) => setPrefs(r.data || {}))
      .catch(() => setPrefs({}))
      .finally(() => setLoading(false));
  }, [visible]);

  async function update(patch: NotificationPrefs) {
    const merged = { ...prefs, ...patch };
    setPrefs(merged);
    setSaving(true);
    try {
      const { data } = await saveNotificationPrefs(patch);
      setPrefs(data || merged);
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell title="Notification Sounds" visible={visible} onClose={onClose}>
      {loading ? (
        <ActivityIndicator color={theme.primary} style={{ marginVertical: 24 }} />
      ) : (
        <View style={{ gap: 16 }}>
          <Pressable
            style={styles.toggleRow}
            onPress={() => update({ muteAll: !prefs.muteAll })}
          >
            <Text style={styles.actionText}>Mute all sounds</Text>
            <View style={[styles.switch, prefs.muteAll && styles.switchOn]}>
              <View style={[styles.knob, prefs.muteAll && styles.knobOn]} />
            </View>
          </Pressable>

          <View>
            <Text style={styles.label}>Message Tone</Text>
            <View style={styles.chipRow}>
              {MESSAGE_TONES.map((t) => (
                <Pressable
                  key={t}
                  style={[styles.chip, prefs.messageTone === t && styles.chipActive]}
                  onPress={() => update({ messageTone: t })}
                >
                  <Text
                    style={[
                      styles.chipText,
                      prefs.messageTone === t && styles.chipTextActive,
                    ]}
                  >
                    {t}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          <View>
            <Text style={styles.label}>Ringtone</Text>
            <View style={styles.chipRow}>
              {RINGTONES.map((t) => (
                <Pressable
                  key={t}
                  style={[styles.chip, prefs.ringtone === t && styles.chipActive]}
                  onPress={() => update({ ringtone: t })}
                >
                  <Text
                    style={[styles.chipText, prefs.ringtone === t && styles.chipTextActive]}
                  >
                    {t}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
          {saving ? <Text style={styles.muted}>Saving…</Text> : null}
        </View>
      )}
    </ModalShell>
  );
}

/* ─── Modal shell ─── */

function ModalShell({
  title,
  visible,
  onClose,
  children,
}: {
  title: string;
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <X size={22} color={theme.textSecondary} />
            </Pressable>
          </View>
          {children}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  container: { padding: 16, gap: 10, paddingBottom: 32 },
  headerCard: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    padding: 24,
    alignItems: "center",
    gap: 4,
  },
  avatarWrap: { width: 84, height: 84, marginBottom: 8 },
  avatar: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarImg: { width: 84, height: 84, borderRadius: 42 },
  avatarText: { color: "#fff", fontSize: 30, fontWeight: "700" },
  avatarStatus: {
    position: "absolute",
    bottom: 2,
    left: 2,
  },
  avatarEdit: {
    position: "absolute",
    bottom: 0,
    right: 0,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: theme.primaryDark,
    borderWidth: 2,
    borderColor: theme.bgElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  statusDot: {
    alignItems: "center",
    justifyContent: "center",
  },
  name: { fontSize: 20, fontWeight: "700", color: theme.text },
  username: { color: theme.textSecondary, fontSize: 14 },
  muted: { color: theme.textMuted, fontSize: 13 },
  badges: {
    flexDirection: "row",
    gap: 8,
    marginTop: 10,
    flexWrap: "wrap",
    justifyContent: "center",
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusFull,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  statusBadgeText: { color: theme.text, fontSize: 12, fontWeight: "600" },
  modeBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusFull,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  modeBadgeText: { color: theme.textSecondary, fontSize: 12, fontWeight: "600" },
  statusTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusSm,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  statusTriggerLabel: { flex: 1, color: theme.text, fontWeight: "600", fontSize: 15 },
  autoBadge: {
    backgroundColor: theme.surfaceHover,
    color: theme.textSecondary,
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: "hidden",
  },
  statusOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: theme.radiusSm,
  },
  statusOptionActive: { backgroundColor: theme.surfaceHover },
  statusOptionLabel: { flex: 1, color: theme.text, fontSize: 15 },
  invisibleDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: theme.textMuted,
  },
  action: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusSm,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  actionText: { color: theme.text, fontWeight: "500", fontSize: 15, flex: 1 },
  enrolledPill: {
    backgroundColor: "rgba(77, 170, 87, 0.15)",
    borderRadius: theme.radiusFull,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  enrolledPillText: { color: theme.success, fontSize: 11, fontWeight: "700" },
  logout: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "rgba(224, 62, 62, 0.1)",
    borderWidth: 1,
    borderColor: "rgba(224, 62, 62, 0.25)",
    borderRadius: theme.radiusSm,
    paddingVertical: 14,
  },
  logoutText: { color: theme.danger, fontWeight: "600", fontSize: 15 },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: theme.bgElevated,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    gap: 6,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  modalTitle: { fontSize: 18, fontWeight: "700", color: theme.text },
  label: {
    fontSize: 11,
    fontWeight: "600",
    color: theme.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 8,
    marginBottom: 6,
  },
  input: {
    backgroundColor: theme.inputBg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: theme.text,
    fontSize: 15,
  },
  submit: {
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 16,
  },
  submitDisabled: { opacity: 0.5 },
  submitText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  switch: {
    width: 44,
    height: 26,
    borderRadius: 13,
    backgroundColor: theme.surfaceHover,
    padding: 3,
    justifyContent: "center",
  },
  switchOn: { backgroundColor: theme.primary },
  knob: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "#fff",
  },
  knobOn: { alignSelf: "flex-end" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusFull,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipActive: { backgroundColor: theme.primaryGlow, borderColor: theme.primary },
  chipText: { color: theme.textSecondary, fontSize: 13, textTransform: "capitalize" },
  chipTextActive: { color: theme.primaryLight, fontWeight: "600" },
});
