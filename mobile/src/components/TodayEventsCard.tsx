import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { CalendarDays, Video } from "../icons";
import type { Theme } from "../theme";
import { useTheme } from "../theme/ThemeProvider";
import type { CalendarEvent } from "../features";

function fmtTime(iso?: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? "—"
    : d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function isHappeningNow(start: string, end: string) {
  const now = new Date();
  return new Date(start) <= now && now < new Date(end);
}

function isStartingSoon(start: string) {
  const now = Date.now();
  const startMs = new Date(start).getTime();
  return startMs > now && startMs - now <= 30 * 60 * 1000;
}

function isJoinable(start: string, end: string) {
  const now = Date.now();
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  return now < endMs && startMs - now <= 5 * 60 * 1000;
}

function minutesUntil(iso: string) {
  return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
}

function isPast(iso: string) {
  return new Date(iso) <= new Date();
}

const OTHER_EVENTS_LIMIT = 4;

/**
 * Mirrors client/src/components/dashboard/TodayEventsCard.tsx ("Today's Events"):
 * count badge, Upcoming Meetings (with Join), Other Events (start–end + "+N more"),
 * and a Tomorrow preview.
 */
export default function TodayEventsCard({
  events,
  tomorrowEvents,
}: {
  events: CalendarEvent[];
  tomorrowEvents: CalendarEvent[];
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const accent = theme.primary;

  // Tick every 30s so join-button visibility / "Live" updates.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const todaySorted = useMemo(
    () =>
      [...(events || [])].sort(
        (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime(),
      ),
    [events],
  );
  const tomorrowSorted = useMemo(
    () =>
      [...(tomorrowEvents || [])].sort(
        (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime(),
      ),
    [tomorrowEvents],
  );

  const upcomingMeetings = useMemo(() => {
    const now = new Date();
    return todaySorted
      .filter((ev) => ev.meeting_code && new Date(ev.end_time) > now)
      .slice(0, 4);
  }, [todaySorted]);

  const meetingIds = useMemo(
    () => new Set(upcomingMeetings.map((m) => m.id)),
    [upcomingMeetings],
  );
  const allOther = useMemo(
    () => todaySorted.filter((ev) => !meetingIds.has(ev.id)),
    [todaySorted, meetingIds],
  );
  const otherEvents = allOther.slice(0, OTHER_EVENTS_LIMIT);
  const hiddenCount = allOther.length - otherEvents.length;

  const joinMeeting = (code: string) => router.push(`/meeting/${code}` as never);

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <CalendarDays size={16} color={accent} />
          <Text style={styles.title}>Today&apos;s Events</Text>
          {todaySorted.length > 0 ? (
            <View style={styles.countBadge}>
              <Text style={styles.countText}>{todaySorted.length}</Text>
            </View>
          ) : null}
        </View>
        <Pressable onPress={() => router.push("/calendar")} hitSlop={8}>
          <Text style={styles.chevron}>›</Text>
        </Pressable>
      </View>

      {/* Upcoming meetings */}
      {upcomingMeetings.length > 0 ? (
        <View style={styles.section}>
          <View style={styles.sectionLabelRow}>
            <Video size={14} color={theme.textSecondary} />
            <Text style={styles.sectionLabel}>Upcoming Meetings</Text>
          </View>
          {upcomingMeetings.map((ev) => {
            const active = isHappeningNow(ev.start_time, ev.end_time);
            const soon = !active && isStartingSoon(ev.start_time);
            const mins = !active ? minutesUntil(ev.start_time) : 0;
            const joinable = ev.meeting_code && isJoinable(ev.start_time, ev.end_time);
            return (
              <View
                key={ev.id}
                style={[
                  styles.meetingItem,
                  active && styles.meetingLive,
                  soon && styles.meetingSoon,
                ]}
              >
                <View style={styles.meetingTimeCol}>
                  <Text style={styles.meetingStart}>{fmtTime(ev.start_time)}</Text>
                  <Text style={styles.meetingEnd}>{fmtTime(ev.end_time)}</Text>
                </View>
                <View style={styles.meetingInfo}>
                  <Text style={styles.meetingName} numberOfLines={1}>
                    {ev.title}
                  </Text>
                  <View style={styles.meetingMeta}>
                    {active ? (
                      <View style={styles.liveBadge}>
                        <View style={styles.liveDot} />
                        <Text style={styles.liveText}>Live</Text>
                      </View>
                    ) : soon ? (
                      <Text style={styles.soonText}>Soon · {mins}m</Text>
                    ) : (
                      <Text style={styles.inText}>
                        in {mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`}
                      </Text>
                    )}
                  </View>
                </View>
                {joinable ? (
                  <Pressable
                    style={[styles.joinBtn, active && styles.joinBtnLive]}
                    onPress={() => joinMeeting(ev.meeting_code!)}
                  >
                    <Video size={13} color="#fff" />
                    <Text style={styles.joinText}>Join</Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}

      {/* Other events */}
      {otherEvents.length > 0 ? (
        <View style={styles.section}>
          {upcomingMeetings.length > 0 ? (
            <Text style={styles.sectionLabel}>Other Events</Text>
          ) : null}
          {otherEvents.map((ev) => (
            <View key={ev.id} style={[styles.eventRow, isPast(ev.end_time) && styles.eventPast]}>
              <View
                style={[styles.colorDot, { backgroundColor: ev.color || accent }]}
              />
              <View style={styles.eventBody}>
                <Text style={styles.eventName} numberOfLines={1}>
                  {ev.title}
                </Text>
                <Text style={styles.eventTime}>
                  {ev.all_day
                    ? "All day"
                    : `${fmtTime(ev.start_time)} – ${fmtTime(ev.end_time)}`}
                </Text>
              </View>
            </View>
          ))}
          {hiddenCount > 0 ? (
            <Pressable onPress={() => router.push("/calendar")}>
              <Text style={styles.moreLink}>+{hiddenCount} more</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {todaySorted.length === 0 ? (
        <Text style={styles.empty}>No events scheduled for today.</Text>
      ) : null}

      {/* Tomorrow preview */}
      {tomorrowSorted.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.tomorrowTitle}>Tomorrow</Text>
          {tomorrowSorted.slice(0, 3).map((ev) => (
            <View key={ev.id} style={[styles.eventRow, styles.eventPast]}>
              <View
                style={[styles.colorDot, { backgroundColor: ev.color || accent }]}
              />
              <View style={styles.eventBody}>
                <Text style={styles.eventName} numberOfLines={1}>
                  {ev.title}
                </Text>
                <Text style={styles.eventTime}>
                  {ev.all_day
                    ? "All day"
                    : `${fmtTime(ev.start_time)} – ${fmtTime(ev.end_time)}`}
                </Text>
              </View>
            </View>
          ))}
          {tomorrowSorted.length > 3 ? (
            <Text style={styles.moreLink}>+{tomorrowSorted.length - 3} more</Text>
          ) : null}
        </View>
      ) : null}
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
    padding: 16,
    gap: 12,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { fontSize: 15, fontWeight: "700", color: theme.text },
  countBadge: {
    backgroundColor: theme.primaryGlow,
    borderRadius: theme.radiusFull,
    paddingHorizontal: 8,
    paddingVertical: 1,
  },
  countText: { color: theme.primaryLight, fontSize: 11, fontWeight: "700" },
  chevron: { fontSize: 20, color: theme.textMuted },
  section: { gap: 8 },
  sectionLabelRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: theme.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  meetingItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    padding: 10,
  },
  meetingLive: {
    borderColor: "rgba(77,170,87,0.4)",
    backgroundColor: "rgba(77,170,87,0.08)",
  },
  meetingSoon: { borderColor: "rgba(203,145,47,0.35)" },
  meetingTimeCol: { alignItems: "center", minWidth: 52 },
  meetingStart: { fontSize: 13, fontWeight: "700", color: theme.text },
  meetingEnd: { fontSize: 11, color: theme.textMuted },
  meetingInfo: { flex: 1, gap: 3 },
  meetingName: { fontSize: 14, fontWeight: "600", color: theme.text },
  meetingMeta: { flexDirection: "row", alignItems: "center" },
  liveBadge: { flexDirection: "row", alignItems: "center", gap: 4 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.success },
  liveText: { fontSize: 11, fontWeight: "700", color: theme.success },
  soonText: { fontSize: 11, fontWeight: "600", color: theme.warning },
  inText: { fontSize: 11, color: theme.textMuted },
  joinBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  joinBtnLive: { backgroundColor: theme.success },
  joinText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  eventRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  eventPast: { opacity: 0.55 },
  colorDot: { width: 8, height: 8, borderRadius: 4 },
  eventBody: { flex: 1 },
  eventName: { fontSize: 14, color: theme.text },
  eventTime: { fontSize: 12, color: theme.textSecondary },
  moreLink: { fontSize: 12, color: theme.primaryLight, fontWeight: "600" },
  empty: { fontSize: 13, color: theme.textMuted },
  tomorrowTitle: {
    fontSize: 11,
    fontWeight: "700",
    color: theme.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
});