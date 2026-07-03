import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { setAudioModeAsync, useAudioPlayer } from "expo-audio";
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
  Fingerprint,
  House,
  KeyRound,
  LogOut,
  Minus,
  Pencil,
  Phone,
  Play,
  RefreshCw,
  ScanFace,
  Trash2,
  Video,
  X,
} from "../src/icons";
import { useAuth } from "../src/auth/AuthContext";
import { triggerUpdateCheck } from "../src/components/UpdateChecker";
import { getCurrentVersion } from "../src/updater";
import type { Theme } from "../src/theme";
import { useTheme } from "../src/theme/ThemeProvider";
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
import {
  getNotificationPreviewDataUri,
  type NotificationSoundCategory,
} from "../src/utils/notificationSoundPreview";
import { DEFAULT_NOTIFICATION_PREFS } from "../src/utils/notificationPrefs";
import { makeStyles } from "./profile.styles";

function initials(name?: string) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || ""))
    .toUpperCase()
    .slice(0, 2);
}

/* ─── Status metadata (mirrors client/src/status/constants.ts) ─── */

type StatusGlyph =
  | "check"
  | "dot"
  | "minus"
  | "clock"
  | "phone"
  | "video"
  | "ring";

type StatusMetaEntry = {
  label: string;
  color: string;
  glyph: StatusGlyph;
  pickable: boolean;
  auto?: boolean;
};

const STATUS_META: Record<string, StatusMetaEntry> = {
  available: {
    label: "Available",
    color: "#22c55e",
    glyph: "check",
    pickable: true,
  },
  busy: { label: "Busy", color: "#ef4444", glyph: "dot", pickable: true },
  dnd: {
    label: "Do Not Disturb",
    color: "#ef4444",
    glyph: "minus",
    pickable: true,
  },
  brb: { label: "Away", color: "#f59e0b", glyph: "clock", pickable: true },
  away: {
    label: "Away (idle)",
    color: "#f59e0b",
    glyph: "clock",
    pickable: false,
    auto: true,
  },
  in_call: {
    label: "In a Call",
    color: "#ef4444",
    glyph: "phone",
    pickable: false,
    auto: true,
  },
  in_meeting: {
    label: "In a Meeting",
    color: "#0ea5e9",
    glyph: "video",
    pickable: false,
    auto: true,
  },
  offline: {
    label: "Offline",
    color: "#64748b",
    glyph: "ring",
    pickable: false,
  },
};

const PICKABLE: ManualStatus[] = ["available", "busy", "dnd", "brb"];

function StatusGlyphIcon({
  glyph,
  size = 9,
  color = "#fff",
}: {
  glyph: StatusGlyph;
  size?: number;
  color?: string;
}) {
  if (glyph === "check")
    return <Check size={size} color={color} strokeWidth={3} />;
  if (glyph === "minus")
    return <Minus size={size} color={color} strokeWidth={3} />;
  if (glyph === "clock")
    return <Clock3 size={size} color={color} strokeWidth={2.6} />;
  if (glyph === "phone")
    return <Phone size={size} color={color} strokeWidth={2.6} />;
  if (glyph === "video")
    return <Video size={size} color={color} strokeWidth={2.6} />;
  return null;
}

function StatusDot({
  meta,
  size = 14,
}: {
  meta: StatusMetaEntry;
  size?: number;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
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
      {!isRing && (
        <StatusGlyphIcon glyph={meta.glyph} size={Math.round(size * 0.55)} />
      )}
    </View>
  );
}

export default function Profile() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const {
    user,
    logout,
    refreshUser,
    biometricAvailable,
    biometricEnrolled,
    biometricLabel,
    biometricKind,
    enableBiometric,
    disableBiometric,
  } = useAuth();
  const router = useRouter();
  const { alert, confirm, dialog } = useDialog();
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [soundsOpen, setSoundsOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [status, setStatus] = useState<StatusPayload | null>(null);

  const { data: tracker = null } = useQuery({
    queryKey: ["profile", "tracker"],
    queryFn: async (): Promise<TrackerStatus> =>
      (await getTrackerStatus()).data,
  });
  const { data: face = null } = useQuery({
    queryKey: ["profile", "face"],
    queryFn: async (): Promise<FaceStatus> => (await getFaceStatus()).data,
  });

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

  const performLogout = async () => {
    await logout();
    router.replace("/login");
  };

  const onLogout = () => {
    confirm({
      title: "Sign Out",
      message: "Are you sure you want to sign out?",
      confirmText: "Sign Out",
      isDanger: true,
      onConfirm: () => {
        void performLogout();
      },
    });
  };

  // Toggle "Sign in with Face ID" for this device. Enrolling asks the server
  // for a device secret and stashes it behind the OS biometric; disabling
  // revokes it server-side and wipes the local secret.
  async function toggleBiometric() {
    if (biometricBusy) return;
    setBiometricBusy(true);
    try {
      if (biometricEnrolled) {
        await disableBiometric();
        alert(
          `${biometricLabel} disabled`,
          "You'll sign in with your password next time.",
        );
      } else {
        await enableBiometric();
        alert(
          `${biometricLabel} enabled`,
          `You can now sign in with ${biometricLabel} on this device.`,
        );
      }
    } catch (e: any) {
      alert(
        "Error",
        e?.response?.data?.error || `Couldn't update ${biometricLabel} login.`,
      );
    } finally {
      setBiometricBusy(false);
    }
  }

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
      // The server can fail AFTER persisting the manual status (the write
      // succeeds but a post-write side effect throws → 500). That false
      // negative surfaced as "Failed to set status" even though the picker
      // change DID apply. Verify against the server before alarming.
      try {
        const { data: fresh } = await getMyStatus();
        if (fresh?.manualStatus === key) {
          setStatus(fresh);
          return;
        }
      } catch {
        /* verification failed — fall through to the error alert */
      }
      alert("Error", e?.response?.data?.error || "Failed to set status");
    }
  }

  async function toggleInvisible() {
    setStatusOpen(false);
    const next =
      status?.presencePreference === "invisible" ? "auto" : "invisible";
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
          <Pressable
            style={styles.avatarEdit}
            onPress={pickAvatar}
            disabled={uploading}
          >
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
          <View
            style={[
              styles.statusBadge,
              { borderColor: headerMeta.color + "55" },
            ]}
          >
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
      <Pressable
        style={styles.statusTrigger}
        onPress={() => setStatusOpen(true)}
      >
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
      {biometricAvailable ? (
        <Pressable
          style={styles.action}
          onPress={toggleBiometric}
          disabled={biometricBusy}
        >
          {biometricKind === "fingerprint" ? (
            <Fingerprint size={16} color={theme.text} />
          ) : (
            <ScanFace size={16} color={theme.text} />
          )}
          <Text style={styles.actionText}>Sign in with {biometricLabel}</Text>
          {biometricBusy ? (
            <ActivityIndicator size="small" color={theme.primary} />
          ) : (
            <View style={[styles.switch, biometricEnrolled && styles.switchOn]}>
              <View style={[styles.knob, biometricEnrolled && styles.knobOn]} />
            </View>
          )}
        </Pressable>
      ) : null}
      <Pressable style={styles.action} onPress={() => triggerUpdateCheck()}>
        <RefreshCw size={16} color={theme.text} />
        <Text style={styles.actionText}>Check for Updates</Text>
        <Text style={styles.versionText}>v{getCurrentVersion()}</Text>
      </Pressable>

      <TouchableOpacity
        style={styles.logout}
        onPress={onLogout}
        activeOpacity={0.85}
      >
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
        onChanged={() => {
          void performLogout();
        }}
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
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
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
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
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
      await updateProfile({
        full_name: name.trim(),
        username: username.trim(),
      });
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
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.submitText}>Save</Text>
        )}
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
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
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
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.submitText}>Update</Text>
        )}
      </Pressable>
      {dialog}
    </ModalShell>
  );
}

/* ─── Notification sounds modal ─── */

type TonePreset = { id: string; name: string };

const RINGTONES: TonePreset[] = [
  { id: "classic", name: "Classic" },
  { id: "calm", name: "Calm" },
  { id: "dynamic", name: "Dynamic" },
  { id: "urgent", name: "Urgent" },
  { id: "boop", name: "Boop" },
  { id: "marimba", name: "Marimba" },
  { id: "crystal", name: "Crystal" },
  { id: "vapor", name: "Vapor" },
  { id: "none", name: "None (silent)" },
];

const OUTGOING_TONES: TonePreset[] = [
  { id: "ringback", name: "Ringback (classic)" },
  { id: "pulse", name: "Pulse" },
  { id: "soft", name: "Soft" },
  { id: "echo", name: "Echo" },
  { id: "drift", name: "Drift" },
  { id: "none", name: "None (silent)" },
];

const MESSAGE_TONES: TonePreset[] = [
  { id: "ding", name: "Ding" },
  { id: "pop", name: "Pop" },
  { id: "chime", name: "Chime" },
  { id: "knock", name: "Knock" },
  { id: "subtle", name: "Subtle" },
  { id: "glassy", name: "Glassy" },
  { id: "ripple", name: "Ripple" },
  { id: "none", name: "None (silent)" },
];

const MENTION_TONES: TonePreset[] = [
  { id: "mention", name: "Mention" },
  { id: "chime", name: "Chime" },
  { id: "urgent", name: "Urgent" },
  { id: "spark", name: "Spark" },
  { id: "none", name: "None (silent)" },
];

const REACTION_TONES: TonePreset[] = [
  { id: "subtle", name: "Subtle" },
  { id: "pop", name: "Pop" },
  { id: "click", name: "Click" },
  { id: "none", name: "None (silent)" },
];

function NotificationSoundsModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const previewPlayer = useAudioPlayer();

  const { data, isLoading: loading } = useQuery({
    queryKey: ["profile", "notificationPrefs"],
    queryFn: async (): Promise<NotificationPrefs> => ({
      ...DEFAULT_NOTIFICATION_PREFS,
      ...((await getNotificationPrefs()).data || {}),
    }),
    enabled: visible,
  });
  const prefs = data ?? DEFAULT_NOTIFICATION_PREFS;

  useEffect(() => {
    if (visible) return;
    try {
      previewPlayer.pause();
    } catch {
      /* ignore */
    }
  }, [visible, previewPlayer]);

  useEffect(
    () => () => {
      try {
        previewPlayer.pause();
      } catch {
        /* ignore */
      }
    },
    [previewPlayer],
  );

  async function update(patch: NotificationPrefs) {
    const merged = { ...prefs, ...patch };
    queryClient.setQueryData(["profile", "notificationPrefs"], merged);
    setSaving(true);
    try {
      const { data } = await saveNotificationPrefs(patch);
      queryClient.setQueryData(
        ["profile", "notificationPrefs"],
        data || merged,
      );
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  }

  const preview = useCallback(
    async (category: NotificationSoundCategory, toneId: string) => {
      if (!toneId || toneId === "none" || prefs.muteAll) return;
      const uri = getNotificationPreviewDataUri(category, toneId);
      if (!uri) return;
      try {
        await setAudioModeAsync({
          allowsRecording: false,
          playsInSilentMode: true,
        });
        previewPlayer.replace({ uri });
        previewPlayer.play();
      } catch {
        /* ignore */
      }
    },
    [prefs.muteAll, previewPlayer],
  );

  return (
    <ModalShell title="Notification Sounds" visible={visible} onClose={onClose}>
      {loading ? (
        <ActivityIndicator
          color={theme.primary}
          style={{ marginVertical: 24 }}
        />
      ) : (
        <ScrollView
          style={styles.soundScroll}
          contentContainerStyle={styles.soundContent}
        >
          <Pressable
            style={styles.toggleRow}
            onPress={() => update({ muteAll: !prefs.muteAll })}
          >
            <Text style={styles.actionText}>Mute all sounds</Text>
            <View style={[styles.switch, prefs.muteAll && styles.switchOn]}>
              <View style={[styles.knob, prefs.muteAll && styles.knobOn]} />
            </View>
          </Pressable>

          <View style={styles.soundSection}>
            <Text style={styles.sectionTitle}>Calls</Text>
            <TonePickerRow
              label="Incoming call ringtone"
              presets={RINGTONES}
              value={
                prefs.ringtone ||
                DEFAULT_NOTIFICATION_PREFS.ringtone ||
                "classic"
              }
              onChange={(id) => {
                update({ ringtone: id });
                preview("ringtone", id);
              }}
              onPreview={() =>
                preview(
                  "ringtone",
                  prefs.ringtone ||
                    DEFAULT_NOTIFICATION_PREFS.ringtone ||
                    "classic",
                )
              }
              previewDisabled={
                !!prefs.muteAll || (prefs.ringtone || "classic") === "none"
              }
            />
            <TonePickerRow
              label="Outgoing call tone"
              presets={OUTGOING_TONES}
              value={
                prefs.outgoingTone ||
                DEFAULT_NOTIFICATION_PREFS.outgoingTone ||
                "ringback"
              }
              onChange={(id) => {
                update({ outgoingTone: id });
                preview("outgoing", id);
              }}
              onPreview={() =>
                preview(
                  "outgoing",
                  prefs.outgoingTone ||
                    DEFAULT_NOTIFICATION_PREFS.outgoingTone ||
                    "ringback",
                )
              }
              previewDisabled={
                !!prefs.muteAll || (prefs.outgoingTone || "ringback") === "none"
              }
            />
          </View>

          <View style={styles.soundSection}>
            <Text style={styles.sectionTitle}>Messages</Text>
            <TonePickerRow
              label="New message"
              presets={MESSAGE_TONES}
              value={
                prefs.messageTone ||
                DEFAULT_NOTIFICATION_PREFS.messageTone ||
                "ding"
              }
              onChange={(id) => {
                update({ messageTone: id });
                preview("message", id);
              }}
              onPreview={() =>
                preview(
                  "message",
                  prefs.messageTone ||
                    DEFAULT_NOTIFICATION_PREFS.messageTone ||
                    "ding",
                )
              }
              previewDisabled={
                !!prefs.muteAll || (prefs.messageTone || "ding") === "none"
              }
            />
            <TonePickerRow
              label="Mention / @-tag"
              presets={MENTION_TONES}
              value={
                prefs.mentionTone ||
                DEFAULT_NOTIFICATION_PREFS.mentionTone ||
                "mention"
              }
              onChange={(id) => {
                update({ mentionTone: id });
                preview("mention", id);
              }}
              onPreview={() =>
                preview(
                  "mention",
                  prefs.mentionTone ||
                    DEFAULT_NOTIFICATION_PREFS.mentionTone ||
                    "mention",
                )
              }
              previewDisabled={
                !!prefs.muteAll || (prefs.mentionTone || "mention") === "none"
              }
            />
            <TonePickerRow
              label="Reaction"
              presets={REACTION_TONES}
              value={
                prefs.reactionTone ||
                DEFAULT_NOTIFICATION_PREFS.reactionTone ||
                "subtle"
              }
              onChange={(id) => {
                update({ reactionTone: id });
                preview("reaction", id);
              }}
              onPreview={() =>
                preview(
                  "reaction",
                  prefs.reactionTone ||
                    DEFAULT_NOTIFICATION_PREFS.reactionTone ||
                    "subtle",
                )
              }
              previewDisabled={
                !!prefs.muteAll || (prefs.reactionTone || "subtle") === "none"
              }
            />
          </View>

          <View style={styles.soundSection}>
            <Text style={styles.sectionTitle}>Behavior</Text>
            <Pressable
              style={styles.toggleRow}
              onPress={() =>
                update({ playWhenFocused: !prefs.playWhenFocused })
              }
            >
              <Text style={styles.actionText}>
                Play sounds when app is focused
              </Text>
              <View
                style={[
                  styles.switch,
                  prefs.playWhenFocused && styles.switchOn,
                ]}
              >
                <View
                  style={[styles.knob, prefs.playWhenFocused && styles.knobOn]}
                />
              </View>
            </Pressable>
            <Pressable
              style={styles.toggleRow}
              onPress={() => update({ playOnSend: !prefs.playOnSend })}
            >
              <Text style={styles.actionText}>
                Play sound when sending messages
              </Text>
              <View
                style={[styles.switch, prefs.playOnSend && styles.switchOn]}
              >
                <View
                  style={[styles.knob, prefs.playOnSend && styles.knobOn]}
                />
              </View>
            </Pressable>
            <Pressable
              style={styles.toggleRow}
              onPress={() =>
                update({ hideSensitiveContent: !prefs.hideSensitiveContent })
              }
            >
              <Text style={styles.actionText}>
                Hide sensitive content on lock screen
              </Text>
              <View
                style={[
                  styles.switch,
                  prefs.hideSensitiveContent && styles.switchOn,
                ]}
              >
                <View
                  style={[
                    styles.knob,
                    prefs.hideSensitiveContent && styles.knobOn,
                  ]}
                />
              </View>
            </Pressable>
          </View>

          <Pressable
            style={styles.resetBtn}
            onPress={() => update(DEFAULT_NOTIFICATION_PREFS)}
          >
            <Text style={styles.resetBtnText}>Reset to defaults</Text>
          </Pressable>

          {saving ? <Text style={styles.muted}>Saving…</Text> : null}
        </ScrollView>
      )}
    </ModalShell>
  );
}

function TonePickerRow({
  label,
  presets,
  value,
  onChange,
  onPreview,
  previewDisabled = false,
}: {
  label: string;
  presets: TonePreset[];
  value: string;
  onChange: (id: string) => void;
  onPreview?: () => void;
  previewDisabled?: boolean;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.toneRow}>
      <View style={styles.toneHeader}>
        <Text style={styles.toneLabel}>{label}</Text>
        {onPreview ? (
          <Pressable
            style={[
              styles.previewBtn,
              previewDisabled && styles.previewBtnDisabled,
            ]}
            onPress={onPreview}
            disabled={previewDisabled}
          >
            <Play
              size={14}
              color={previewDisabled ? theme.textMuted : theme.primaryLight}
            />
            <Text
              style={[
                styles.previewBtnText,
                previewDisabled && styles.previewBtnTextDisabled,
              ]}
            >
              Preview
            </Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.chipRow}>
        {presets.map((t) => (
          <Pressable
            key={t.id}
            style={[styles.chip, value === t.id && styles.chipActive]}
            onPress={() => onChange(t.id)}
          >
            <Text
              style={[styles.chipText, value === t.id && styles.chipTextActive]}
            >
              {t.name}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
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
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
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
