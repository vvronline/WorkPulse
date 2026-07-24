import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { AlertTriangle, Clock, MapPin, ScanFace } from "../icons";
import type { Theme } from "../theme";
import { useTheme } from "../theme/ThemeProvider";
import type { ClockInErrorInfo } from "../utils/clockInError";

// Face-attempt lockout window enforced by the server (see
// server/routes/tracker.ts — "Please wait 15 minutes"). The server does not
// return a precise unlock timestamp, so we count down from this default the
// moment the lockout error is shown.
const LOCKOUT_SECONDS = 15 * 60;

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

type Props = {
  info: ClockInErrorInfo;
};

/**
 * Shared, themed error block for the mobile attendance verification modals.
 * Renders a kind-specific icon + title + the server's exact detail message,
 * plus a live "try again in mm:ss" countdown for FACE_ATTEMPTS_LOCKED.
 */
export default function VerifyError({ info }: Props) {
  const theme = useTheme();
  const styles = makeStyles(theme);

  const isLocked = info.code === "FACE_ATTEMPTS_LOCKED";
  const [remaining, setRemaining] = useState(isLocked ? LOCKOUT_SECONDS : 0);

  useEffect(() => {
    if (!isLocked) return;
    setRemaining(LOCKOUT_SECONDS);
    const id = setInterval(() => {
      setRemaining((r) => (r <= 1 ? 0 : r - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [isLocked, info.message]);

  const Icon = isLocked
    ? Clock
    : info.kind === "location"
      ? MapPin
      : info.kind === "face"
        ? ScanFace
        : AlertTriangle;

  const locked = isLocked && remaining > 0;

  return (
    <View style={styles.wrap}>
      <Icon size={16} color={theme.danger} />
      <View style={styles.textWrap}>
        <Text style={styles.title}>{info.title}</Text>
        <Text style={styles.text}>{info.message}</Text>
        {isLocked ? (
          <Text style={styles.countdown}>
            {locked
              ? `You can try again in ${fmt(remaining)}`
              : "You can try again now."}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    wrap: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 8,
      backgroundColor: "rgba(224, 62, 62, 0.1)",
      borderRadius: theme.radiusSm,
      padding: 10,
    },
    textWrap: { flex: 1, gap: 2 },
    title: { color: theme.danger, fontSize: 13, fontWeight: "700" },
    text: { color: theme.danger, fontSize: 12 },
    countdown: {
      color: theme.warning,
      fontSize: 12,
      fontWeight: "700",
      marginTop: 2,
    },
  });
}
