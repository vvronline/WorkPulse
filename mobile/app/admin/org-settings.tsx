import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { WebView } from "react-native-webview";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import NetInfo from "@react-native-community/netinfo";
import {
  Building2,
  Lock,
  MapPin,
  Mail,
  Palette,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  UserCog,
  UserPlus,
  Wifi,
  X,
} from "lucide-react-native";
import type { Theme } from "../../src/theme";
import {
  useKeyboardInset,
  scrollFocusedIntoView,
} from "../../src/hooks/useKeyboardInset";
import { Dropdown } from "../../src/components/Dropdown";
import { ColorPicker } from "../../src/components/ColorPicker";
import { useBranding, useTheme } from "../../src/theme/ThemeProvider";
import { useAuth } from "../../src/auth/AuthContext";
import { uploadUrl } from "../../src/config";
import {
  createInviteCode,
  createOrgRole,
  deactivateInviteCode,
  deleteBrandingLogo,
  deleteOrgRole,
  getBranding,
  getEmailTemplates,
  getInviteCodes,
  getOrgRoles,
  getRegistrationSettings,
  revertEmailTemplate,
  updateBrandingAccent,
  updateEmailTemplate,
  updateOrgRole,
  updateOrgSettings,
  updateRegistrationSettings,
  uploadBrandingLogo,
  type EmailTemplate,
  type InviteCode,
  type OrgRole,
} from "../../src/admin";
import { getCurrentOrg } from "../../src/features";

const REGISTRATION_MODES = [
  { value: "open", label: "Open — anyone can register" },
  { value: "invite", label: "Invite only" },
  { value: "closed", label: "Closed — admins create users" },
];

const ACCENT_PRESETS = [
  "#2383e2",
  "#4daa57",
  "#cb912f",
  "#e03e3e",
  "#9b59b6",
  "#1abc9c",
];

const PERMISSION_LEVELS = [
  { value: 1, label: "Standard member (level 1)" },
  { value: 2, label: "Team lead (level 2)" },
  { value: 3, label: "Manager (level 3)" },
  { value: 4, label: "HR admin (level 4)" },
];

const TEMPLATE_LABELS: Record<string, string> = {
  leaveApproved: "Leave approved",
  leaveRejected: "Leave rejected",
  leaveRevoked: "Leave revoked",
  taskAssigned: "Task assigned",
  mention: "You were mentioned",
  manualEntryApproved: "Manual entry approved",
  manualEntryRejected: "Manual entry rejected",
  meetingScheduled: "Meeting scheduled",
  meetingUpdated: "Meeting updated",
  meetingCancelled: "Meeting cancelled",
};

const ROLE_COLORS = [
  "#6b7280",
  "#0ea5e9",
  "#8b5cf6",
  "#f59e0b",
  "#10b981",
  "#ef4444",
];

// Top-level system roles — not editable here, shown read-only for context
// (mirrors the web OrgRoleLabels system-role cards).
const SYSTEM_ROLES = [
  {
    role_key: "super_admin",
    label: "Super Admin",
    color: "#ef4444",
    level: "L5 · Org admin",
    note: "Org-wide admin with access to all settings and billing. Always present in every organisation.",
  },
  {
    role_key: "platform_admin",
    label: "Platform Admin",
    color: "#0f172a",
    level: "L6 · Platform",
    note: "Cross-organisation system operator. Not assignable from inside an organisation.",
  },
];

// Wi-Fi access point entry stored in organizations.office_wifi_bssids.
interface WifiAp {
  bssid: string;
  label?: string | null;
  ssid?: string | null;
  added_at?: string;
  [k: string]: unknown;
}

/**
 * Build the Leaflet map HTML for the WebView. Tapping the map posts the
 * picked coordinates back to RN via window.ReactNativeWebView.postMessage.
 */
function buildMapHtml(
  lat: number | null,
  lng: number | null,
  radius: number,
): string {
  const hasLoc = lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng);
  const centreLat = hasLoc ? lat : 19.076;
  const centreLng = hasLoc ? lng : 72.8777;
  const zoom = hasLoc ? 16 : 12;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  html, body, #map { height: 100%; margin: 0; padding: 0; background: #191919; }
</style>
</head>
<body>
<div id="map"></div>
<script>
  var map = L.map('map').setView([${centreLat}, ${centreLng}], ${zoom});
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);
  var icon = L.icon({
    iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
    iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
    shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
    iconSize: [25, 41], iconAnchor: [12, 41]
  });
  var marker = null, circle = null;
  function place(lat, lng) {
    if (marker) { marker.setLatLng([lat, lng]); } else { marker = L.marker([lat, lng], { icon: icon }).addTo(map); }
    if (circle) { circle.setLatLng([lat, lng]); } else {
      circle = L.circle([lat, lng], { radius: ${radius || 150}, color: '#2383e2', fillColor: '#2383e2', fillOpacity: 0.12 }).addTo(map);
    }
  }
  ${hasLoc ? `place(${centreLat}, ${centreLng});` : ""}
  map.on('click', function (e) {
    place(e.latlng.lat, e.latlng.lng);
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ lat: e.latlng.lat, lng: e.latlng.lng }));
    }
  });
  setTimeout(function () { map.invalidateSize(); }, 300);
</script>
</body>
</html>`;
}

// jsDow matches JavaScript's Date#getDay() (0=Sunday … 6=Saturday) — the same
// convention the server stores in organizations.work_days.
const WEEK_DAYS = [
  { jsDow: 1, short: "Mon" },
  { jsDow: 2, short: "Tue" },
  { jsDow: 3, short: "Wed" },
  { jsDow: 4, short: "Thu" },
  { jsDow: 5, short: "Fri" },
  { jsDow: 6, short: "Sat" },
  { jsDow: 0, short: "Sun" },
];

function parseWorkDays(value?: string | null): Set<number> {
  const raw = value && typeof value === "string" ? value : "1,2,3,4,5";
  const nums = raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return new Set(nums.length > 0 ? nums : [1, 2, 3, 4, 5]);
}

function workDaysToCsv(set: Set<number>): string {
  return Array.from(set)
    .sort((a, b) => a - b)
    .join(",");
}

export default function OrgSettingsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const kbInset = useKeyboardInset();
  const { user } = useAuth();
  const { refreshBranding } = useBranding();
  const isSuper =
    user?.role === "super_admin" || user?.role === "platform_admin";

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const canEditAttendance = isSuper || user?.role === "hr_admin";

  // General
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("");
  const [workHours, setWorkHours] = useState("");
  const [officeStart, setOfficeStart] = useState("");
  const [workDays, setWorkDays] = useState<Set<number>>(
    parseWorkDays("1,2,3,4,5"),
  );
  const [fiscalStart, setFiscalStart] = useState("");
  const [minHours, setMinHours] = useState("");

  // Attendance verification
  const [attEnabled, setAttEnabled] = useState(false);
  const [officeLat, setOfficeLat] = useState("");
  const [officeLng, setOfficeLng] = useState("");
  const [officeRadius, setOfficeRadius] = useState("");
  const [officeAddress, setOfficeAddress] = useState("");
  const [locating, setLocating] = useState(false);

  // Office Wi-Fi allow-list (Wi-Fi-first attendance).
  const [wifiVerifyOn, setWifiVerifyOn] = useState(false);
  const [wifiBssids, setWifiBssids] = useState<WifiAp[]>([]);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualBssid, setManualBssid] = useState("");
  const [manualLabel, setManualLabel] = useState("");
  const [wifiErr, setWifiErr] = useState<string | null>(null);
  const [editingBssid, setEditingBssid] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState("");
  const [wifiScanning, setWifiScanning] = useState(false);

  // Branding
  const [accent, setAccent] = useState("#2383e2");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);

  // Registration
  const [regMode, setRegMode] = useState("open");
  const [inviteCodes, setInviteCodes] = useState<InviteCode[]>([]);

  // Roles
  const [roles, setRoles] = useState<OrgRole[]>([]);
  const [roleModal, setRoleModal] = useState(false);
  const [editingRole, setEditingRole] = useState<OrgRole | null>(null);
  const [roleKey, setRoleKey] = useState("");
  const [roleLabel, setRoleLabel] = useState("");
  const [roleColor, setRoleColor] = useState(ROLE_COLORS[0]);
  const [roleLevel, setRoleLevel] = useState<string | number | null>(1);

  // Email templates
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [tmplModal, setTmplModal] = useState(false);
  const [editingTmpl, setEditingTmpl] = useState<EmailTemplate | null>(null);
  const [tmplSubject, setTmplSubject] = useState("");
  const [tmplBody, setTmplBody] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const [orgR, brandR, regR, codesR, rolesR, tmplR] =
      await Promise.allSettled([
        getCurrentOrg(),
        getBranding(),
        getRegistrationSettings(),
        getInviteCodes(),
        getOrgRoles(),
        getEmailTemplates(),
      ]);
    if (orgR.status === "fulfilled" && orgR.value.data) {
      const o = orgR.value.data;
      setName(o.name ?? "");
      setTimezone(o.timezone ?? "");
      setWorkHours(o.work_hours_per_day ? String(o.work_hours_per_day) : "");
      setOfficeStart(o.office_start_time ?? "");
      setWorkDays(parseWorkDays(o.work_days));
      setFiscalStart(
        o.fiscal_year_start != null ? String(o.fiscal_year_start) : "",
      );
      setMinHours(
        o.min_hours_present != null ? String(o.min_hours_present) : "",
      );
      setAttEnabled(!!o.attendance_verification_enabled);
      setOfficeLat(o.office_latitude != null ? String(o.office_latitude) : "");
      setOfficeLng(
        o.office_longitude != null ? String(o.office_longitude) : "",
      );
      setOfficeRadius(
        o.office_radius_m != null ? String(o.office_radius_m) : "",
      );
      setOfficeAddress(o.office_address ?? "");
      setWifiVerifyOn(!!o.office_wifi_verification_enabled);
      setWifiBssids(
        Array.isArray(o.office_wifi_bssids)
          ? (o.office_wifi_bssids as WifiAp[])
          : [],
      );
    }
    if (brandR.status === "fulfilled" && brandR.value.data) {
      if (brandR.value.data.accent_color)
        setAccent(brandR.value.data.accent_color);
      setLogoUrl(brandR.value.data.logo_url ?? null);
    }
    if (regR.status === "fulfilled" && regR.value.data?.mode)
      setRegMode(regR.value.data.mode);
    if (codesR.status === "fulfilled")
      setInviteCodes(
        Array.isArray(codesR.value.data) ? codesR.value.data : [],
      );
    if (rolesR.status === "fulfilled")
      setRoles(rolesR.value.data?.roles ?? []);
    if (tmplR.status === "fulfilled")
      setTemplates(tmplR.value.data?.templates ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /* ── General ── */

  function toggleWorkDay(jsDow: number) {
    setWorkDays((prev) => {
      const next = new Set(prev);
      if (next.has(jsDow)) {
        if (next.size === 1) {
          Alert.alert("Required", "Pick at least one working day");
          return prev;
        }
        next.delete(jsDow);
      } else {
        next.add(jsDow);
      }
      return next;
    });
  }

  async function saveGeneral() {
    if (fiscalStart) {
      const fm = Number(fiscalStart);
      if (!Number.isInteger(fm) || fm < 1 || fm > 12) {
        Alert.alert("Invalid", "Fiscal year start must be a month (1-12)");
        return;
      }
    }
    setBusy(true);
    try {
      await updateOrgSettings({
        name: name.trim() || undefined,
        timezone: timezone.trim() || undefined,
        work_hours_per_day: workHours ? Number(workHours) : undefined,
        work_days: workDaysToCsv(workDays),
        fiscal_year_start: fiscalStart ? Number(fiscalStart) : undefined,
        min_hours_present: minHours === "" ? null : Number(minHours),
        office_start_time: officeStart.trim() === "" ? null : officeStart.trim(),
      });
      Alert.alert("Saved", "Organization settings updated");
      load();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  /* ── Attendance verification ── */

  async function useMyLocation() {
    setLocating(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert(
          "Permission needed",
          "Location permission is required to set the office coordinates.",
        );
        return;
      }
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      setOfficeLat(pos.coords.latitude.toFixed(6));
      setOfficeLng(pos.coords.longitude.toFixed(6));
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Failed to read current location");
    } finally {
      setLocating(false);
    }
  }

  async function saveAttendance() {
    if (attEnabled) {
      const lat = Number(officeLat);
      const lng = Number(officeLng);
      if (
        officeLat.trim() === "" ||
        officeLng.trim() === "" ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lng)
      ) {
        Alert.alert(
          "Office location required",
          "Set the office latitude and longitude before enabling verification.",
        );
        return;
      }
    }
    setBusy(true);
    try {
      await updateOrgSettings({
        attendance_verification_enabled: attEnabled,
        office_latitude: officeLat.trim() === "" ? null : Number(officeLat),
        office_longitude: officeLng.trim() === "" ? null : Number(officeLng),
        office_radius_m: officeRadius ? Number(officeRadius) : undefined,
        office_address:
          officeAddress.trim() === "" ? null : officeAddress.trim(),
        office_wifi_verification_enabled: wifiVerifyOn,
        office_wifi_bssids: wifiBssids.map((b) => ({
          bssid: b.bssid,
          label: b.label ?? null,
          ssid: b.ssid ?? null,
        })),
      });
      Alert.alert("Saved", "Attendance verification updated");
      load();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  /* ── Office Wi-Fi allow-list ── */

  function submitManualBssid() {
    setWifiErr(null);
    const cleaned = manualBssid.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
    if (cleaned.length !== 12) {
      setWifiErr("Invalid MAC. Expected 12 hex digits (e.g. AA:BB:CC:DD:EE:FF).");
      return;
    }
    const mac = cleaned.match(/.{2}/g)!.join(":");
    if (wifiBssids.some((b) => (b.bssid || "").toUpperCase() === mac)) {
      setWifiErr("This access point is already registered.");
      return;
    }
    const label = (manualLabel.trim() || `Office AP (${mac.slice(-5)})`).slice(
      0,
      100,
    );
    setWifiBssids((prev) => [
      ...prev,
      { bssid: mac, label, added_at: new Date().toISOString() },
    ]);
    setManualBssid("");
    setManualLabel("");
    setManualOpen(false);
  }

  function removeBssid(mac: string) {
    setWifiBssids((prev) =>
      prev.filter((b) => (b.bssid || "").toUpperCase() !== mac.toUpperCase()),
    );
    if (editingBssid && editingBssid.toUpperCase() === mac.toUpperCase()) {
      setEditingBssid(null);
    }
  }

  function startEditLabel(ap: WifiAp) {
    setEditingBssid(ap.bssid);
    setEditingLabel(ap.label || "");
  }

  function commitEditLabel() {
    const trimmed = (editingLabel || "").trim().slice(0, 100);
    setWifiBssids((prev) =>
      prev.map((b) =>
        (b.bssid || "").toUpperCase() === (editingBssid || "").toUpperCase()
          ? { ...b, label: trimmed || b.label || "Office AP" }
          : b,
      ),
    );
    setEditingBssid(null);
  }

  /**
   * Auto-detect the BSSID of the Wi-Fi the device is currently connected to and
   * add it to the office allow-list (mirrors the web desktop's "Add this
   * network's Wi-Fi"). Reading the BSSID requires location permission on
   * Android (and Location Services to be ON); iOS additionally needs the
   * NEHotspotConfiguration / location-when-in-use entitlement which is only
   * present in a dev/EAS build. On Expo Go / web the BSSID is unavailable, so
   * we surface a clear message and the admin can still use manual entry.
   */
  async function addCurrentWifi() {
    setWifiErr(null);
    setWifiScanning(true);
    try {
      // BSSID is only exposed once location permission is granted.
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== "granted") {
        setWifiErr(
          "Location permission is required to read the current Wi-Fi BSSID.",
        );
        return;
      }
      const state = await NetInfo.fetch("wifi");
      const details = (state?.details ?? {}) as {
        bssid?: string | null;
        ssid?: string | null;
      };
      const rawBssid = details?.bssid;
      if (state?.type !== "wifi" || !rawBssid || rawBssid === "02:00:00:00:00:00") {
        setWifiErr(
          state?.type !== "wifi"
            ? "You're not connected to Wi-Fi. Connect to the office network first."
            : "Could not read the Wi-Fi BSSID. Make sure Location Services is on and you're on a dev build (BSSID is unavailable in Expo Go).",
        );
        return;
      }
      const mac = rawBssid.toUpperCase();
      if (wifiBssids.some((b) => (b.bssid || "").toUpperCase() === mac)) {
        setWifiErr("This access point is already registered.");
        return;
      }
      const ssid = details?.ssid && details.ssid !== "<unknown ssid>"
        ? details.ssid
        : null;
      const defaultLabel = (
        ssid ? `${ssid} (${mac.slice(-5)})` : `Office AP (${mac.slice(-5)})`
      ).slice(0, 100);
      setWifiBssids((prev) => [
        ...prev,
        {
          bssid: mac,
          label: defaultLabel,
          ssid,
          added_at: new Date().toISOString(),
        },
      ]);
      // Open the inline label editor so the admin can rename immediately.
      setEditingBssid(mac);
      setEditingLabel(defaultLabel);
    } catch (e: any) {
      setWifiErr(e?.message || "Failed to read the current Wi-Fi network.");
    } finally {
      setWifiScanning(false);
    }
  }

  /* ── Branding ── */

  async function saveAccent(color: string) {
    setAccent(color);
    try {
      await updateBrandingAccent(color);
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save accent");
    }
  }

  async function pickLogo() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      quality: 0.9,
    });
    if (result.canceled || !result.assets?.[0]?.uri) return;
    setBusy(true);
    try {
      const r = await uploadBrandingLogo(result.assets[0].uri);
      setLogoUrl(r.data?.logo_url ?? null);
      Alert.alert("Saved", "Logo updated");
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to upload logo");
    } finally {
      setBusy(false);
    }
  }

  function removeLogo() {
    Alert.alert("Remove logo", "Remove the organization logo?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () =>
          deleteBrandingLogo()
            .then(() => setLogoUrl(null))
            .catch((e: any) =>
              Alert.alert("Error", e?.response?.data?.error || "Failed"),
            ),
      },
    ]);
  }

  /* ── Registration ── */

  async function saveRegMode(mode: string | number | null) {
    if (!mode) return;
    setRegMode(String(mode));
    try {
      await updateRegistrationSettings(String(mode));
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to update");
    }
  }

  async function newInviteCode() {
    setBusy(true);
    try {
      await createInviteCode({ expires_in_days: 7 });
      const r = await getInviteCodes();
      setInviteCodes(Array.isArray(r.data) ? r.data : []);
    } catch (e: any) {
      Alert.alert(
        "Error",
        e?.response?.data?.error || "Failed to create invite code",
      );
    } finally {
      setBusy(false);
    }
  }

  function removeInviteCode(c: InviteCode) {
    Alert.alert("Deactivate code", `Deactivate "${c.code}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Deactivate",
        style: "destructive",
        onPress: () =>
          deactivateInviteCode(c.id)
            .then(() => getInviteCodes())
            .then((r) => setInviteCodes(Array.isArray(r.data) ? r.data : []))
            .catch((e: any) =>
              Alert.alert("Error", e?.response?.data?.error || "Failed"),
            ),
      },
    ]);
  }

  /* ── Roles ── */

  function openCreateRole() {
    setEditingRole(null);
    setRoleKey("");
    setRoleLabel("");
    setRoleColor(ROLE_COLORS[0]);
    setRoleLevel(1);
    setRoleModal(true);
  }

  function openEditRole(r: OrgRole) {
    setEditingRole(r);
    setRoleKey(r.role_key);
    setRoleLabel(r.label);
    setRoleColor(r.color || ROLE_COLORS[0]);
    setRoleLevel(r.permission_level);
    setRoleModal(true);
  }

  async function saveRole() {
    if (!roleLabel.trim()) {
      Alert.alert("Required", "Label is required");
      return;
    }
    setBusy(true);
    try {
      if (editingRole) {
        const r = await updateOrgRole(editingRole.role_key, {
          label: roleLabel.trim(),
          color: roleColor,
          permission_level: Number(roleLevel) || 1,
        });
        setRoles(r.data?.roles ?? []);
      } else {
        const key = roleKey.trim().toLowerCase();
        if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) {
          Alert.alert(
            "Invalid key",
            "Role key must be lowercase letters, numbers or underscores, starting with a letter.",
          );
          setBusy(false);
          return;
        }
        const r = await createOrgRole({
          role_key: key,
          label: roleLabel.trim(),
          color: roleColor,
          permission_level: Number(roleLevel) || 1,
        });
        setRoles(r.data?.roles ?? []);
      }
      setRoleModal(false);
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save role");
    } finally {
      setBusy(false);
    }
  }

  function confirmDeleteRole(r: OrgRole) {
    if ((r.user_count ?? 0) > 0) {
      Alert.alert(
        "Role in use",
        `${r.user_count} user(s) still hold "${r.label}". Reassign them first.`,
      );
      return;
    }
    Alert.alert("Delete role", `Delete "${r.label}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          deleteOrgRole(r.role_key)
            .then((res) => setRoles(res.data?.roles ?? []))
            .catch((e: any) =>
              Alert.alert(
                "Error",
                e?.response?.data?.error || "Failed to delete",
              ),
            ),
      },
    ]);
  }

  /* ── Email templates ── */

  function openEditTemplate(t: EmailTemplate) {
    setEditingTmpl(t);
    setTmplSubject(t.subject);
    setTmplBody(t.body_html);
    setTmplModal(true);
  }

  async function saveTemplate() {
    if (!editingTmpl) return;
    setBusy(true);
    try {
      await updateEmailTemplate(editingTmpl.template_key, {
        subject: tmplSubject,
        body_html: tmplBody,
      });
      setTmplModal(false);
      const r = await getEmailTemplates();
      setTemplates(r.data?.templates ?? []);
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  async function toggleTemplate(t: EmailTemplate, enabled: boolean) {
    // Optimistic toggle.
    setTemplates((list) =>
      list.map((x) =>
        x.template_key === t.template_key ? { ...x, enabled } : x,
      ),
    );
    try {
      await updateEmailTemplate(t.template_key, { enabled });
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to update");
      const r = await getEmailTemplates().catch(() => null);
      if (r) setTemplates(r.data?.templates ?? []);
    }
  }

  function revertTemplate(t: EmailTemplate) {
    Alert.alert(
      "Revert template",
      `Revert "${TEMPLATE_LABELS[t.template_key] || t.template_key}" to the built-in version?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Revert",
          style: "destructive",
          onPress: () =>
            revertEmailTemplate(t.template_key)
              .then(() => getEmailTemplates())
              .then((r) => setTemplates(r.data?.templates ?? []))
              .catch((e: any) =>
                Alert.alert("Error", e?.response?.data?.error || "Failed"),
              ),
        },
      ],
    );
  }

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Org Settings" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  const logoAbs = uploadUrl(logoUrl);
  const accentValid = /^#[0-9a-fA-F]{6}$/.test(accent);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.container, { paddingBottom: 48 + kbInset }]}
    >
      <Stack.Screen options={{ title: "Org Settings" }} />

      {/* ── General ── */}
      <View style={styles.section}>
        <View style={styles.sectionTitleRow}>
          <Building2 size={15} color={theme.textSecondary} />
          <Text style={styles.sectionTitle}>General</Text>
        </View>
        <Text style={styles.fieldLabel}>Name</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          onFocus={scrollFocusedIntoView}
          placeholder="Organization name"
          placeholderTextColor={theme.textMuted}
        />
        <Text style={styles.fieldLabel}>Timezone</Text>
        <TextInput
          style={styles.input}
          value={timezone}
          onChangeText={setTimezone}
          onFocus={scrollFocusedIntoView}
          placeholder="e.g. Asia/Kolkata"
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
        />
        <Text style={styles.fieldLabel}>Work hours per day</Text>
        <TextInput
          style={styles.input}
          value={workHours}
          onChangeText={setWorkHours}
          onFocus={scrollFocusedIntoView}
          placeholder="8"
          placeholderTextColor={theme.textMuted}
          keyboardType="numeric"
        />
        <Text style={styles.fieldLabel}>Working days</Text>
        <View style={styles.dayRow}>
          {WEEK_DAYS.map((d) => {
            const on = workDays.has(d.jsDow);
            return (
              <Pressable
                key={d.jsDow}
                style={[styles.dayChip, on && styles.dayChipActive]}
                onPress={() => toggleWorkDay(d.jsDow)}
              >
                <Text
                  style={[styles.dayChipText, on && styles.dayChipTextActive]}
                >
                  {d.short}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.hint}>
          Unselected days are treated as weekend holidays.
        </Text>
        <Text style={styles.fieldLabel}>Fiscal year start month (1-12)</Text>
        <TextInput
          style={styles.input}
          value={fiscalStart}
          onChangeText={setFiscalStart}
          onFocus={scrollFocusedIntoView}
          placeholder="e.g. 4 for April"
          placeholderTextColor={theme.textMuted}
          keyboardType="numeric"
        />
        <Text style={styles.fieldLabel}>
          Minimum hours to be marked present (optional)
        </Text>
        <TextInput
          style={styles.input}
          value={minHours}
          onChangeText={setMinHours}
          onFocus={scrollFocusedIntoView}
          placeholder={
            workHours ? `Default: ${Number(workHours) / 2}h` : "Default: half day"
          }
          placeholderTextColor={theme.textMuted}
          keyboardType="numeric"
        />
        <Text style={styles.fieldLabel}>Office start time (HH:MM, optional)</Text>
        <TextInput
          style={styles.input}
          value={officeStart}
          onChangeText={setOfficeStart}
          onFocus={scrollFocusedIntoView}
          placeholder="09:00"
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
        />
        <Pressable style={styles.saveBtn} onPress={saveGeneral} disabled={busy}>
          <Text style={styles.saveBtnText}>
            {busy ? "Saving…" : "Save organization"}
          </Text>
        </Pressable>
      </View>

      {/* ── Attendance Verification ── */}
      {canEditAttendance ? (
        <View style={styles.section}>
          <View style={styles.sectionTitleRow}>
            <MapPin size={15} color={theme.textSecondary} />
            <Text style={styles.sectionTitle}>Attendance Verification</Text>
          </View>
          <Text style={styles.hint}>
            When enabled, employees must pass a face match and (for office mode)
            be within the geofence to clock in.
          </Text>
          <View style={styles.toggleRow}>
            <Text style={styles.toggleLabel}>Require face + location check</Text>
            <Switch
              value={attEnabled}
              onValueChange={setAttEnabled}
              trackColor={{ true: theme.primary, false: theme.surface }}
              thumbColor="#fff"
            />
          </View>
          <Text style={styles.fieldLabel}>Office address (optional)</Text>
          <TextInput
            style={styles.input}
            value={officeAddress}
            onChangeText={setOfficeAddress}
            onFocus={scrollFocusedIntoView}
            placeholder="123 Main St, City"
            placeholderTextColor={theme.textMuted}
          />
          <View style={styles.latLngRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.fieldLabel}>Latitude</Text>
              <TextInput
                style={styles.input}
                value={officeLat}
                onChangeText={setOfficeLat}
                onFocus={scrollFocusedIntoView}
                placeholder="12.971599"
                placeholderTextColor={theme.textMuted}
                keyboardType="numbers-and-punctuation"
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.fieldLabel}>Longitude</Text>
              <TextInput
                style={styles.input}
                value={officeLng}
                onChangeText={setOfficeLng}
                onFocus={scrollFocusedIntoView}
                placeholder="77.594566"
                placeholderTextColor={theme.textMuted}
                keyboardType="numbers-and-punctuation"
              />
            </View>
          </View>
          <View style={styles.locBtnRow}>
            <Pressable
              style={[styles.smallBtn, { flex: 1 }]}
              onPress={useMyLocation}
              disabled={locating}
            >
              <Text style={styles.smallBtnText}>
                {locating ? "Locating…" : "Use my current location"}
              </Text>
            </Pressable>
          </View>
          <Text style={styles.fieldLabel}>Geofence radius (metres)</Text>
          <TextInput
            style={styles.input}
            value={officeRadius}
            onChangeText={setOfficeRadius}
            onFocus={scrollFocusedIntoView}
            placeholder="100"
            placeholderTextColor={theme.textMuted}
            keyboardType="numeric"
          />

          {/* Interactive map — tap to set the office location. */}
          <View style={styles.mapHintRow}>
            <MapPin size={13} color={theme.textMuted} />
            <Text style={styles.hint}>Tap the map to set the office location</Text>
          </View>
          {(() => {
            const lat = Number(officeLat);
            const lng = Number(officeLng);
            const valid =
              officeLat.trim() !== "" &&
              officeLng.trim() !== "" &&
              Number.isFinite(lat) &&
              Number.isFinite(lng);
            const html = buildMapHtml(
              valid ? lat : null,
              valid ? lng : null,
              Number(officeRadius) || 150,
            );
            return (
              <View style={styles.mapWebWrap}>
                <WebView
                  // Re-mount when coords change so the marker/circle reflect the
                  // latest values (e.g. after "Use my current location").
                  key={`${valid ? lat.toFixed(5) : "x"}-${valid ? lng.toFixed(5) : "y"}`}
                  originWhitelist={["*"]}
                  source={{ html }}
                  style={styles.mapWeb}
                  scrollEnabled={false}
                  onMessage={(e) => {
                    try {
                      const d = JSON.parse(e.nativeEvent.data);
                      if (
                        d &&
                        Number.isFinite(d.lat) &&
                        Number.isFinite(d.lng)
                      ) {
                        setOfficeLat(Number(d.lat).toFixed(6));
                        setOfficeLng(Number(d.lng).toFixed(6));
                      }
                    } catch {
                      /* ignore malformed messages */
                    }
                  }}
                />
              </View>
            );
          })()}

          {/* Coordinate summary + external map link. */}
          {(() => {
            const lat = Number(officeLat);
            const lng = Number(officeLng);
            const valid =
              officeLat.trim() !== "" &&
              officeLng.trim() !== "" &&
              Number.isFinite(lat) &&
              Number.isFinite(lng);
            if (!valid) return null;
            return (
              <View style={styles.mapPreview}>
                <View style={styles.mapPreviewRow}>
                  <MapPin size={16} color={theme.primary} />
                  <Text style={styles.mapPreviewCoord}>
                    {lat.toFixed(6)}, {lng.toFixed(6)}
                  </Text>
                </View>
                <Text style={styles.mapPreviewMeta}>
                  Geofence radius:{" "}
                  {officeRadius ? `${officeRadius} m` : "not set"}
                </Text>
                <Pressable
                  style={styles.smallBtn}
                  onPress={() =>
                    Linking.openURL(
                      `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
                    )
                  }
                >
                  <Text style={styles.smallBtnText}>View on map</Text>
                </Pressable>
              </View>
            );
          })()}

          {/* Office Wi-Fi allow-list (recommended). */}
          <View style={styles.wifiSection}>
            <View style={styles.wifiHeaderRow}>
              <View style={styles.sectionTitleRow}>
                <Wifi size={15} color={theme.textSecondary} />
                <Text style={styles.wifiTitle}>Office Wi-Fi (recommended)</Text>
              </View>
            </View>
            <View style={styles.toggleRow}>
              <Text style={styles.toggleLabel}>
                Trust office Wi-Fi for clock-in
              </Text>
              <Switch
                value={wifiVerifyOn}
                onValueChange={setWifiVerifyOn}
                trackColor={{ true: theme.primary, false: theme.surface }}
                thumbColor="#fff"
              />
            </View>
            <Text style={styles.hint}>
              When an employee is connected to one of these access points, they're
              treated as at the office regardless of GPS accuracy. The geofence
              above acts as a fallback.
            </Text>

            {wifiBssids.length === 0 ? (
              <Text style={styles.hint}>
                No office access points registered yet. Add the office router's
                BSSID (MAC) below.
              </Text>
            ) : (
              wifiBssids.map((ap) => {
                const isEditing =
                  editingBssid &&
                  editingBssid.toUpperCase() === (ap.bssid || "").toUpperCase();
                return (
                  <View key={ap.bssid} style={styles.itemRow}>
                    <Wifi size={15} color={theme.textSecondary} />
                    <View style={{ flex: 1 }}>
                      {isEditing ? (
                        <TextInput
                          style={styles.input}
                          value={editingLabel}
                          onChangeText={setEditingLabel}
                          onBlur={commitEditLabel}
                          onSubmitEditing={commitEditLabel}
                          maxLength={100}
                          autoFocus
                          placeholder="Label"
                          placeholderTextColor={theme.textMuted}
                        />
                      ) : (
                        <Pressable onPress={() => startEditLabel(ap)}>
                          <Text style={styles.itemName}>
                            {ap.label || "Office AP"}
                          </Text>
                        </Pressable>
                      )}
                      <Text style={styles.itemMeta}>
                        {ap.bssid}
                        {ap.ssid ? ` · SSID: ${ap.ssid}` : ""}
                      </Text>
                    </View>
                    <Pressable
                      style={styles.iconBtn}
                      onPress={() => removeBssid(ap.bssid)}
                      hitSlop={6}
                    >
                      <Trash2 size={15} color={theme.danger} />
                    </Pressable>
                  </View>
                );
              })
            )}

            {manualOpen ? (
              <View style={styles.wifiManualForm}>
                <TextInput
                  style={styles.input}
                  value={manualBssid}
                  onChangeText={setManualBssid}
                  onFocus={scrollFocusedIntoView}
                  placeholder="BSSID (AA:BB:CC:DD:EE:FF)"
                  placeholderTextColor={theme.textMuted}
                  autoCapitalize="characters"
                  autoCorrect={false}
                />
                <TextInput
                  style={styles.input}
                  value={manualLabel}
                  onChangeText={setManualLabel}
                  onFocus={scrollFocusedIntoView}
                  placeholder="Label (e.g. Floor 5 AP)"
                  placeholderTextColor={theme.textMuted}
                  maxLength={100}
                />
                {wifiErr ? <Text style={styles.wifiErr}>{wifiErr}</Text> : null}
                <View style={styles.wifiManualActions}>
                  <Pressable
                    style={[styles.smallBtn, { flex: 1 }]}
                    onPress={submitManualBssid}
                  >
                    <Text style={styles.smallBtnText}>Add</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.smallBtn, { flex: 1 }]}
                    onPress={() => {
                      setManualOpen(false);
                      setManualBssid("");
                      setManualLabel("");
                      setWifiErr(null);
                    }}
                  >
                    <Text style={styles.smallBtnText}>Cancel</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <View style={styles.wifiActionRow}>
                <Pressable
                  style={[styles.smallBtn, { flex: 1 }]}
                  onPress={addCurrentWifi}
                  disabled={wifiScanning}
                >
                  <Text style={styles.smallBtnText}>
                    {wifiScanning ? "Reading…" : "Add this network's Wi-Fi"}
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.smallBtn, { flex: 1 }]}
                  onPress={() => {
                    setManualOpen(true);
                    setWifiErr(null);
                  }}
                >
                  <Text style={styles.smallBtnText}>Enter BSSID manually</Text>
                </Pressable>
              </View>
            )}
            {!manualOpen && wifiErr ? (
              <Text style={styles.wifiErr}>{wifiErr}</Text>
            ) : null}
          </View>

          <Pressable
            style={styles.saveBtn}
            onPress={saveAttendance}
            disabled={busy}
          >
            <Text style={styles.saveBtnText}>
              {busy ? "Saving…" : "Save attendance settings"}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* ── Registration ── */}
      {isSuper ? (
        <View style={styles.section}>
          <View style={styles.sectionTitleRow}>
            <UserPlus size={15} color={theme.textSecondary} />
            <Text style={styles.sectionTitle}>Registration</Text>
          </View>
          <Dropdown
            label="Registration mode"
            value={regMode}
            options={REGISTRATION_MODES}
            onChange={saveRegMode}
          />
          <View style={styles.subHeaderRow}>
            <Text style={styles.subHeader}>Invite codes</Text>
            <Pressable style={styles.addBtn} onPress={newInviteCode}>
              <Plus size={14} color={theme.primary} />
              <Text style={styles.addBtnText}>Generate</Text>
            </Pressable>
          </View>
          {inviteCodes.length === 0 ? (
            <Text style={styles.hint}>No invite codes.</Text>
          ) : (
            inviteCodes.map((c) => (
              <View key={c.id} style={styles.itemRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.codeText}>{c.code}</Text>
                  <Text style={styles.itemMeta}>
                    {c.is_active === false ? "inactive · " : ""}
                    {c.uses ?? 0}
                    {c.max_uses ? `/${c.max_uses}` : ""} uses
                    {c.expires_at
                      ? ` · expires ${new Date(c.expires_at).toLocaleDateString()}`
                      : ""}
                  </Text>
                </View>
                {c.is_active !== false ? (
                  <Pressable
                    style={styles.iconBtn}
                    onPress={() => removeInviteCode(c)}
                    hitSlop={6}
                  >
                    <Trash2 size={15} color={theme.danger} />
                  </Pressable>
                ) : null}
              </View>
            ))
          )}
        </View>
      ) : null}

      {/* ── Roles ── */}
      <View style={styles.section}>
        <View style={styles.subHeaderRow}>
          <View style={styles.sectionTitleRow}>
            <UserCog size={15} color={theme.textSecondary} />
            <Text style={styles.sectionTitle}>Roles</Text>
          </View>
          {isSuper ? (
            <Pressable style={styles.addBtn} onPress={openCreateRole}>
              <Plus size={14} color={theme.primary} />
              <Text style={styles.addBtnText}>Add</Text>
            </Pressable>
          ) : null}
        </View>
        {roles.length === 0 ? (
          <Text style={styles.hint}>No roles defined.</Text>
        ) : (
          roles.map((r) => (
            <View key={r.role_key} style={styles.itemRow}>
              <View
                style={[
                  styles.colorDot,
                  { backgroundColor: r.color || "#888" },
                ]}
              />
              <View style={{ flex: 1 }}>
                <Text style={styles.itemName}>{r.label}</Text>
                <Text style={styles.itemMeta}>
                  {r.role_key} · level {r.permission_level}
                  {r.user_count != null ? ` · ${r.user_count} users` : ""}
                </Text>
              </View>
              {isSuper ? (
                <>
                  <Pressable
                    style={styles.iconBtn}
                    onPress={() => openEditRole(r)}
                    hitSlop={6}
                  >
                    <Pencil size={15} color={theme.textSecondary} />
                  </Pressable>
                  {!r.is_system ? (
                    <Pressable
                      style={styles.iconBtn}
                      onPress={() => confirmDeleteRole(r)}
                      hitSlop={6}
                    >
                      <Trash2 size={15} color={theme.danger} />
                    </Pressable>
                  ) : null}
                </>
              ) : null}
            </View>
          ))
        )}

        {/* System roles — read-only context (mirrors web). */}
        {SYSTEM_ROLES.map((sr) => (
          <View key={sr.role_key} style={styles.systemRoleRow}>
            <View
              style={[styles.colorDot, { backgroundColor: sr.color }]}
            />
            <View style={{ flex: 1 }}>
              <View style={styles.systemRoleHeader}>
                <Text style={styles.itemName}>{sr.role_key}</Text>
                <View style={styles.systemBadge}>
                  <Lock size={10} color={theme.textMuted} />
                  <Text style={styles.systemBadgeText}>system</Text>
                </View>
                <Text style={styles.levelBadge}>{sr.level}</Text>
              </View>
              <Text style={styles.itemMeta}>{sr.note}</Text>
            </View>
          </View>
        ))}
      </View>

      {/* ── Branding ── */}
      <View style={styles.section}>
        <View style={styles.sectionTitleRow}>
          <Palette size={15} color={theme.textSecondary} />
          <Text style={styles.sectionTitle}>Branding</Text>
        </View>
        <Text style={styles.fieldLabel}>Logo</Text>
        <View style={styles.logoRow}>
          {logoAbs ? (
            <Image source={{ uri: logoAbs }} style={styles.logoPreview} />
          ) : (
            <View style={[styles.logoPreview, styles.logoPlaceholder]}>
              <Text style={styles.hint}>No logo</Text>
            </View>
          )}
          <View style={{ gap: 8, flex: 1 }}>
            <Pressable style={styles.smallBtn} onPress={pickLogo}>
              <Text style={styles.smallBtnText}>
                {logoAbs ? "Replace" : "Choose logo"}
              </Text>
            </Pressable>
            {logoAbs ? (
              <Pressable style={styles.smallBtnDanger} onPress={removeLogo}>
                <Text style={styles.smallBtnDangerText}>Remove</Text>
              </Pressable>
            ) : null}
            <Text style={styles.hint}>
              PNG, JPG, SVG, GIF or WebP — max 2 MB. Recommended height 40 px.
            </Text>
          </View>
        </View>
        <Text style={styles.fieldLabel}>Accent color</Text>
        <ColorPicker
          value={accent}
          onChange={setAccent}
          presets={ACCENT_PRESETS}
        />
        <Text style={styles.hint}>
          The accent color is applied to buttons, links, badges, and outgoing
          email templates.
        </Text>

        {/* Live preview */}
        <Text style={styles.previewLabel}>Live preview</Text>
        <View style={styles.previewCard}>
          {logoAbs ? (
            <Image source={{ uri: logoAbs }} style={styles.previewLogo} />
          ) : null}
          <Text style={styles.previewHeading}>Sample heading</Text>
          <Text style={styles.previewText}>
            This is how content will look with your accent color. The button
            below uses the same hue.
          </Text>
          <View
            style={[
              styles.previewBtn,
              { backgroundColor: accentValid ? accent : theme.primary },
            ]}
          >
            <Text style={styles.previewBtnText}>Primary action</Text>
          </View>
        </View>

        <Pressable
          style={[styles.saveBtn, !accentValid && { opacity: 0.5 }]}
          disabled={!accentValid}
          onPress={async () => {
            if (!accentValid) {
              Alert.alert("Invalid color", "Accent must be a 6-digit hex (e.g. #2383e2)");
              return;
            }
            try {
              await updateBrandingAccent(accent);
              // Re-fetch branding so the new accent re-themes the whole app.
              await refreshBranding();
              Alert.alert("Saved", "Branding updated");
            } catch (e: any) {
              Alert.alert(
                "Error",
                e?.response?.data?.error || "Failed to save branding",
              );
            }
          }}
        >
          <Text style={styles.saveBtnText}>Save branding</Text>
        </Pressable>
      </View>

      {/* ── Email templates ── */}
      <View style={styles.section}>
        <View style={styles.sectionTitleRow}>
          <Mail size={15} color={theme.textSecondary} />
          <Text style={styles.sectionTitle}>Email templates</Text>
        </View>
        {templates.length === 0 ? (
          <Text style={styles.hint}>No email templates available.</Text>
        ) : (
          templates.map((t) => (
            <View key={t.template_key} style={styles.itemRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.itemName}>
                  {TEMPLATE_LABELS[t.template_key] || t.template_key}
                  {t.is_overridden ? "  ·  customised" : ""}
                </Text>
                <Text style={styles.itemMeta} numberOfLines={1}>
                  {t.subject}
                </Text>
              </View>
              <Switch
                value={t.enabled}
                onValueChange={(v) => toggleTemplate(t, v)}
                trackColor={{ true: theme.primary, false: theme.surface }}
                thumbColor="#fff"
              />
              <Pressable
                style={styles.iconBtn}
                onPress={() => openEditTemplate(t)}
                hitSlop={6}
              >
                <Pencil size={15} color={theme.textSecondary} />
              </Pressable>
              {t.is_overridden ? (
                <Pressable
                  style={styles.iconBtn}
                  onPress={() => revertTemplate(t)}
                  hitSlop={6}
                >
                  <RotateCcw size={15} color={theme.warning} />
                </Pressable>
              ) : null}
            </View>
          ))
        )}
      </View>

      {/* ── Role modal ── */}
      <Modal
        visible={roleModal}
        transparent
        animationType="slide"
        onRequestClose={() => setRoleModal(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Pressable
            style={styles.modalScrim}
            onPress={() => setRoleModal(false)}
          />
          <View style={[styles.sheet, { marginBottom: kbInset }]}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>
                {editingRole ? "Edit role" : "New role"}
              </Text>
              <Pressable onPress={() => setRoleModal(false)} hitSlop={8}>
                <X size={22} color={theme.textSecondary} />
              </Pressable>
            </View>
            {!editingRole ? (
              <>
                <Text style={styles.fieldLabel}>Role key</Text>
                <TextInput
                  style={styles.input}
                  value={roleKey}
                  onChangeText={(t) => setRoleKey(t.toLowerCase())}
                  placeholder="e.g. principal_engineer"
                  placeholderTextColor={theme.textMuted}
                  autoCapitalize="none"
                />
              </>
            ) : null}
            <Text style={styles.fieldLabel}>Label</Text>
            <TextInput
              style={styles.input}
              value={roleLabel}
              onChangeText={setRoleLabel}
              placeholder="e.g. Principal Engineer"
              placeholderTextColor={theme.textMuted}
            />
            <Text style={styles.fieldLabel}>Permission level</Text>
            <Dropdown
              label="Permission level"
              value={roleLevel}
              options={PERMISSION_LEVELS}
              onChange={setRoleLevel}
            />
            <Text style={styles.fieldLabel}>Color</Text>
            <View style={styles.swatchRow}>
              {ROLE_COLORS.map((c) => (
                <Pressable
                  key={c}
                  style={[
                    styles.swatch,
                    { backgroundColor: c },
                    roleColor === c && styles.swatchActive,
                  ]}
                  onPress={() => setRoleColor(c)}
                />
              ))}
            </View>
            <Pressable style={styles.saveBtn} onPress={saveRole} disabled={busy}>
              <Text style={styles.saveBtnText}>
                {busy ? "Saving…" : editingRole ? "Save changes" : "Create role"}
              </Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Email template modal ── */}
      <Modal
        visible={tmplModal}
        transparent
        animationType="slide"
        onRequestClose={() => setTmplModal(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Pressable
            style={styles.modalScrim}
            onPress={() => setTmplModal(false)}
          />
          <View style={[styles.sheet, { marginBottom: kbInset }]}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle} numberOfLines={1}>
                {editingTmpl
                  ? TEMPLATE_LABELS[editingTmpl.template_key] ||
                    editingTmpl.template_key
                  : "Template"}
              </Text>
              <Pressable onPress={() => setTmplModal(false)} hitSlop={8}>
                <X size={22} color={theme.textSecondary} />
              </Pressable>
            </View>
            <Text style={styles.fieldLabel}>Subject</Text>
            <TextInput
              style={styles.input}
              value={tmplSubject}
              onChangeText={setTmplSubject}
              placeholder="Email subject"
              placeholderTextColor={theme.textMuted}
            />
            <Text style={styles.fieldLabel}>Body (HTML)</Text>
            <TextInput
              style={[styles.input, styles.inputTall]}
              value={tmplBody}
              onChangeText={setTmplBody}
              placeholder="<p>Hello…</p>"
              placeholderTextColor={theme.textMuted}
              multiline
            />
            <Pressable
              style={styles.saveBtn}
              onPress={saveTemplate}
              disabled={busy}
            >
              <Text style={styles.saveBtnText}>
                {busy ? "Saving…" : "Save template"}
              </Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </ScrollView>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: "center", justifyContent: "center" },
  container: { padding: 16, gap: 16, paddingBottom: 48 },
  section: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    padding: 16,
    gap: 10,
  },
  sectionTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: theme.text },
  subHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 4,
  },
  subHeader: { fontSize: 13, fontWeight: "600", color: theme.textSecondary },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.primaryGlow,
  },
  addBtnText: { fontSize: 12, fontWeight: "600", color: theme.primary },
  fieldLabel: { fontSize: 12, color: theme.textSecondary, fontWeight: "500" },
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
  inputTall: { minHeight: 120, textAlignVertical: "top" },
  dayRow: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  dayChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  dayChipActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  dayChipText: { fontSize: 12, color: theme.textSecondary, fontWeight: "600" },
  dayChipTextActive: { color: "#fff" },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  toggleLabel: { fontSize: 14, color: theme.text, flex: 1, marginRight: 12 },
  latLngRow: { flexDirection: "row", gap: 12 },
  saveBtn: {
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 4,
  },
  saveBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  swatchRow: { flexDirection: "row", gap: 12, flexWrap: "wrap" },
  swatch: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 3,
    borderColor: "transparent",
  },
  swatchActive: { borderColor: theme.text },
  hint: { fontSize: 12, color: theme.textMuted },
  mapPreview: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusSm,
    padding: 12,
    gap: 8,
    marginTop: 4,
  },
  mapPreviewRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  mapPreviewCoord: { fontSize: 14, fontWeight: "600", color: theme.text },
  mapPreviewMeta: { fontSize: 12, color: theme.textMuted },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  colorDot: { width: 12, height: 12, borderRadius: 6 },
  itemName: { fontSize: 14, fontWeight: "600", color: theme.text },
  itemMeta: { fontSize: 11, color: theme.textMuted, marginTop: 1 },
  codeText: {
    fontSize: 14,
    fontWeight: "700",
    color: theme.text,
    letterSpacing: 1,
  },
  iconBtn: { padding: 6 },
  logoRow: { flexDirection: "row", alignItems: "center", gap: 16 },
  logoPreview: {
    width: 72,
    height: 72,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.surface,
  },
  logoPlaceholder: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  smallBtn: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  smallBtnText: { color: theme.text, fontSize: 13, fontWeight: "600" },
  smallBtnDanger: {
    borderWidth: 1,
    borderColor: theme.danger,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  smallBtnDangerText: { color: theme.danger, fontSize: 13, fontWeight: "600" },
  modalOverlay: { flex: 1, justifyContent: "flex-end" },
  modalScrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  sheet: {
    backgroundColor: theme.bgElevated,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    gap: 10,
  },
  sheetHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
    gap: 12,
  },
  sheetTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: "700",
    color: theme.text,
  },
  // Attendance: location + map
  locBtnRow: { flexDirection: "row", gap: 12 },
  mapHintRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
  },
  mapWebWrap: {
    height: 240,
    borderRadius: theme.radiusSm,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    overflow: "hidden",
    backgroundColor: theme.surface,
  },
  mapWeb: { flex: 1, backgroundColor: theme.surface },
  // Office Wi-Fi allow-list
  wifiSection: {
    marginTop: 8,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
    gap: 8,
  },
  wifiHeaderRow: { flexDirection: "row", alignItems: "center" },
  wifiTitle: { fontSize: 14, fontWeight: "700", color: theme.text },
  wifiManualForm: { gap: 8, marginTop: 4 },
  wifiManualActions: { flexDirection: "row", gap: 12 },
  wifiActionRow: { flexDirection: "row", gap: 12, marginTop: 4 },
  wifiErr: { fontSize: 12, color: theme.danger },
  // System role cards
  systemRoleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 10,
    marginTop: 8,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  systemRoleHeader: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
  },
  systemBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: theme.radiusFull,
    backgroundColor: theme.surfaceHover,
  },
  systemBadgeText: { fontSize: 10, color: theme.textMuted, fontWeight: "600" },
  levelBadge: {
    fontSize: 10,
    color: theme.textSecondary,
    fontWeight: "600",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: theme.radiusFull,
    backgroundColor: theme.surfaceHover,
  },
  // Branding: hex input + live preview
  hexRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  hexSwatch: {
    width: 40,
    height: 40,
    borderRadius: theme.radiusSm,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  previewLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: theme.textSecondary,
    marginTop: 4,
  },
  previewCard: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusSm,
    padding: 16,
    gap: 8,
  },
  previewLogo: { height: 40, width: 120, resizeMode: "contain" },
  previewHeading: { fontSize: 16, fontWeight: "700", color: theme.text },
  previewText: { fontSize: 13, color: theme.textSecondary },
  previewBtn: {
    alignSelf: "flex-start",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: theme.radiusSm,
    marginTop: 4,
  },
  previewBtnText: { color: "#fff", fontSize: 13, fontWeight: "600" },
});
