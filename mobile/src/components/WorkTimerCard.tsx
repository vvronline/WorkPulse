import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import Svg, { Circle } from "react-native-svg";
import {
  Building2,
  Coffee,
  House,
  LogOut,
  Play,
  Timer,
} from "lucide-react-native";
import type { Theme } from "../theme";
import { useTheme } from "../theme/ThemeProvider";
import { useDialog } from "../hooks/useDialog";
import { formatTime, formatTimeSec } from "../utils/time";
import {
  breakEnd,
  breakStart,
  clockIn,
  clockOut,
  getTrackerStatus,
  type TrackerStatus,
  type WorkState,
} from "../tracker";
import { getCurrentOrg, getFaceStatus } from "../features";
import ClockInVerifyModal from "./ClockInVerifyModal";

const RADIUS = 42;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function stateColor(theme: Theme, state: WorkState) {
  if (state === "on_floor") return theme.success;
  if (state === "on_break") return theme.warning;
  return theme.textMuted;
}

export default function WorkTimerCard() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const { alert, confirm, dialog } = useDialog();
  const [status, setStatus] = useState<TrackerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<string | null>(null);
  const [workMode, setWorkMode] = useState<"office" | "remote">("office");

  // Attendance verification gate (face + geofence/wifi).
  const [verifyEnabled, setVerifyEnabled] = useState(false);
  const [verifyModalOpen, setVerifyModalOpen] = useState(false);

  // Live-ticking seconds seeded from the server snapshot.
  const [floorSec, setFloorSec] = useState(0);
  const [breakSec, setBreakSec] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const { data } = await getTrackerStatus();
      setStatus(data);
      setFloorSec(Math.round((data.floorMinutes || 0) * 60));
      setBreakSec(Math.round((data.breakMinutes || 0) * 60));
      if (data.workMode) setWorkMode(data.workMode);
    } catch {
      /* surfaced via empty card */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    // Detect whether this org enforces face + location verification at clock-in.
    getCurrentOrg()
      .then((r) => setVerifyEnabled(!!r.data?.attendance_verification_enabled))
      .catch(() => setVerifyEnabled(false));
  }, [refresh]);

  // Decide between the one-tap clock-in (verification off) and the
  // verify-modal flow (verification on). For the modal flow we first check the
  // user has enrolled a face — if not, route them to enrollment.
  const handleLogin = useCallback(async () => {
    if (!verifyEnabled) {
      run("clockIn", () => clockIn(workMode));
      return;
    }
    setAction("clockIn");
    try {
      const { data: face } = await getFaceStatus();
      if (!face?.enrolled) {
        setAction(null);
        confirm({
          title: "Face enrollment required",
          message:
            "Please enroll your face before clocking in. Open Face Enrollment now?",
          confirmText: "Enroll",
          isDanger: false,
          onConfirm: () => router.push("/profile/face"),
        });
        return;
      }
      setAction(null);
      setVerifyModalOpen(true);
    } catch {
      setAction(null);
      // If the face-status check fails, still open the modal — the server
      // will return a clear error if enrollment is missing.
      setVerifyModalOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verifyEnabled, workMode, router]);

  // Tick every second while active.
  const stateRef = useRef<WorkState>("logged_out");
  stateRef.current = status?.state ?? "logged_out";
  useEffect(() => {
    const id = setInterval(() => {
      const st = stateRef.current;
      if (st === "on_floor") setFloorSec((s) => s + 1);
      else if (st === "on_break") setBreakSec((s) => s + 1);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  async function run(name: string, fn: () => Promise<unknown>) {
    setAction(name);
    try {
      await fn();
      await refresh();
    } catch (e: any) {
      alert("Error", e?.response?.data?.error || "Action failed");
    } finally {
      setAction(null);
    }
  }

  const onLogout = useCallback(() => {
    confirm({
      title: "Logout",
      message: "Are you sure you want to clock out?",
      confirmText: "Logout",
      isDanger: true,
      onConfirm: () => run("clockOut", clockOut),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <View style={[styles.card, styles.loadingCard]}>
        <ActivityIndicator color={theme.primary} />
      </View>
    );
  }

  const state: WorkState = status?.state ?? "logged_out";
  const targetMinutes = status?.targetMinutes ?? 480;
  const dailyTargetMet = !!status?.dailyTargetMet;
  const floorMinutes = floorSec / 60;
  const breakCount = status?.breakCount ?? 0;
  const remainingMin = Math.max(0, targetMinutes - floorMinutes);
  const pct = Math.min(100, (floorMinutes / targetMinutes) * 100);
  const ringColor = stateColor(theme, state);
  const offset = CIRCUMFERENCE * (1 - pct / 100);

  return (
    <View style={styles.card}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Timer size={14} color={theme.textSecondary} />
          <Text style={styles.headerTitle}>Work Timer</Text>
        </View>
        <View style={[styles.dot, { backgroundColor: ringColor }]} />
      </View>

      {/* Body */}
      <View style={styles.body}>
        {/* Ring */}
        <View style={styles.ringCol}>
          <View style={styles.ringWrap}>
            <Svg width={96} height={96} viewBox="0 0 100 100">
              <Circle
                cx={50}
                cy={50}
                r={RADIUS}
                stroke={theme.surfaceHover}
                strokeWidth={7}
                fill="none"
              />
              <Circle
                cx={50}
                cy={50}
                r={RADIUS}
                stroke={ringColor}
                strokeWidth={7}
                fill="none"
                strokeLinecap="round"
                strokeDasharray={CIRCUMFERENCE}
                strokeDashoffset={offset}
                transform="rotate(-90 50 50)"
              />
            </Svg>
            <View style={styles.ringCenter}>
              <Text style={[styles.ringTime, { color: ringColor }]}>
                {state === "on_floor" && formatTimeSec(floorSec)}
                {state === "on_break" && formatTimeSec(breakSec)}
                {state === "logged_out" && (dailyTargetMet ? "✓" : "—")}
              </Text>
            </View>
          </View>
          <Text style={styles.ringLabel}>
            {state === "on_floor" && "Working"}
            {state === "on_break" && `Break${breakCount > 0 ? ` #${breakCount}` : ""}`}
            {state === "logged_out" && (dailyTargetMet ? "Target Met" : "Logged Out")}
          </Text>
        </View>

        {/* Info + actions */}
        <View style={styles.infoCol}>
          {state !== "logged_out" && (
            <View style={styles.stats}>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Work</Text>
                <Text style={styles.statValue}>{formatTime(floorMinutes)}</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Break</Text>
                <Text style={styles.statValue}>{formatTimeSec(breakSec)}</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Remaining</Text>
                <Text style={styles.statValue}>
                  {dailyTargetMet ? "—" : formatTime(remainingMin)}
                </Text>
              </View>
            </View>
          )}

          {/* Progress */}
          {state !== "logged_out" && (
            <View style={styles.progress}>
              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${pct}%`, backgroundColor: ringColor },
                  ]}
                />
              </View>
              <View style={styles.progressMeta}>
                <Text style={styles.progressPct}>{Math.round(pct)}%</Text>
                <Text style={styles.progressTarget}>
                  {Math.round(targetMinutes / 60)}hr target
                </Text>
              </View>
            </View>
          )}

          {/* Actions */}
          <View style={styles.actions}>
            {state === "logged_out" && !dailyTargetMet && (
              <>
                <View style={styles.modeToggle}>
                  <Pressable
                    style={[styles.modeBtn, workMode === "office" && styles.modeBtnActive]}
                    onPress={() => setWorkMode("office")}
                  >
                    <Building2
                      size={13}
                      color={workMode === "office" ? "#fff" : theme.textSecondary}
                    />
                    <Text
                      style={[
                        styles.modeBtnText,
                        workMode === "office" && styles.modeBtnTextActive,
                      ]}
                    >
                      Office
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[styles.modeBtn, workMode === "remote" && styles.modeBtnActive]}
                    onPress={() => setWorkMode("remote")}
                  >
                    <House
                      size={13}
                      color={workMode === "remote" ? "#fff" : theme.textSecondary}
                    />
                    <Text
                      style={[
                        styles.modeBtnText,
                        workMode === "remote" && styles.modeBtnTextActive,
                      ]}
                    >
                      Remote
                    </Text>
                  </Pressable>
                </View>
                <Pressable
                  style={[styles.btn, styles.btnSuccess]}
                  onPress={handleLogin}
                  disabled={!!action}
                >
                  <Play size={14} color="#fff" />
                  <Text style={styles.btnText}>
                    {action === "clockIn" ? "Logging in..." : "Login"}
                  </Text>
                </Pressable>
              </>
            )}

            {state === "logged_out" && dailyTargetMet && (
              <Text style={styles.targetDone}>✅ Daily target complete!</Text>
            )}

            {state === "on_floor" && (
              <View style={styles.btnRow}>
                <Pressable
                  style={[styles.btn, styles.btnWarning, styles.btnFlex]}
                  onPress={() => run("breakStart", breakStart)}
                  disabled={!!action}
                >
                  <Coffee size={14} color="#fff" />
                  <Text style={styles.btnText}>Break</Text>
                </Pressable>
                <Pressable
                  style={[styles.btn, styles.btnDanger, styles.btnFlex]}
                  onPress={onLogout}
                  disabled={!!action}
                >
                  <LogOut size={14} color="#fff" />
                  <Text style={styles.btnText}>Logout</Text>
                </Pressable>
              </View>
            )}

            {state === "on_break" && (
              <View style={styles.btnRow}>
                <Pressable
                  style={[styles.btn, styles.btnSuccess, styles.btnFlex]}
                  onPress={() => run("breakEnd", breakEnd)}
                  disabled={!!action}
                >
                  <Play size={14} color="#fff" />
                  <Text style={styles.btnText}>Resume</Text>
                </Pressable>
                <Pressable
                  style={[styles.btn, styles.btnDanger, styles.btnFlex]}
                  onPress={onLogout}
                  disabled={!!action}
                >
                  <LogOut size={14} color="#fff" />
                  <Text style={styles.btnText}>Logout</Text>
                </Pressable>
              </View>
            )}
          </View>
        </View>
      </View>

      {/* Face + location verification flow (verification-enabled orgs). */}
      <ClockInVerifyModal
        visible={verifyModalOpen}
        workMode={workMode}
        onClose={() => setVerifyModalOpen(false)}
        onSuccess={() => {
          setVerifyModalOpen(false);
          refresh();
        }}
      />

      {/* Themed confirm / alert dialog (replaces OS-native Alert). */}
      {dialog}
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
  card: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    overflow: "hidden",
  },
  loadingCard: { padding: 32, alignItems: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.glassBorder,
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 6 },
  headerTitle: {
    fontSize: 11,
    fontWeight: "700",
    color: theme.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  body: {
    flexDirection: "row",
    alignItems: "center",
    gap: 18,
    padding: 16,
  },
  ringCol: { alignItems: "center", gap: 6 },
  ringWrap: { width: 96, height: 96, alignItems: "center", justifyContent: "center" },
  ringCenter: { position: "absolute", alignItems: "center", justifyContent: "center" },
  ringTime: { fontSize: 15, fontWeight: "700" },
  ringLabel: { fontSize: 12, color: theme.textSecondary, fontWeight: "500" },
  infoCol: { flex: 1, gap: 12 },
  stats: { flexDirection: "row", alignItems: "center" },
  stat: { flex: 1, alignItems: "center", gap: 2 },
  statLabel: {
    fontSize: 9,
    color: theme.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  statValue: { fontSize: 13, fontWeight: "700", color: theme.text },
  statDivider: { width: 1, height: 24, backgroundColor: theme.border },
  progress: { gap: 5 },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.surfaceHover,
    overflow: "hidden",
  },
  progressFill: { height: "100%", borderRadius: 3 },
  progressMeta: { flexDirection: "row", justifyContent: "space-between" },
  progressPct: { fontSize: 11, fontWeight: "700", color: theme.text },
  progressTarget: { fontSize: 11, color: theme.textMuted },
  actions: { gap: 8 },
  modeToggle: {
    flexDirection: "row",
    backgroundColor: theme.surface,
    borderRadius: theme.radiusSm,
    padding: 3,
    gap: 3,
  },
  modeBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 7,
    borderRadius: 5,
  },
  modeBtnActive: { backgroundColor: theme.primary },
  modeBtnText: { fontSize: 12, fontWeight: "600", color: theme.textSecondary },
  modeBtnTextActive: { color: "#fff" },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 11,
    borderRadius: theme.radiusSm,
  },
  btnFlex: { flex: 1 },
  btnText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  btnSuccess: { backgroundColor: theme.success },
  btnWarning: { backgroundColor: theme.warning },
  btnDanger: { backgroundColor: theme.danger },
  btnRow: { flexDirection: "row", gap: 8 },
  targetDone: {
    textAlign: "center",
    color: theme.success,
    fontWeight: "600",
    paddingVertical: 8,
  },
});
