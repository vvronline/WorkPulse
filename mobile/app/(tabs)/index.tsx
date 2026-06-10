import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useFocusEffect } from "expo-router";
import { useAuth } from "../../src/auth/AuthContext";
import { theme } from "../../src/theme";
import WorkTimerCard from "../../src/components/WorkTimerCard";
import TodayEventsCard from "../../src/components/TodayEventsCard";
import TasksSummaryCard from "../../src/components/TasksSummaryCard";
import SprintProgressCard from "../../src/components/SprintProgressCard";
import PendingApprovalsCard from "../../src/components/PendingApprovalsCard";
import {
  getActiveAnnouncements,
  getCalendarEvents,
  getTaskSummary,
  type Announcement,
  type CalendarEvent,
  type TaskSummary,
} from "../../src/features";

const ROLE_LEVELS: Record<string, number> = {
  employee: 1,
  user: 1,
  team_lead: 2,
  manager: 3,
  hr_admin: 4,
  super_admin: 5,
  platform_admin: 6,
};

const ANNOUNCEMENT_ROTATION = 8000;

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good Morning";
  if (hour < 17) return "Good Afternoon";
  return "Good Evening";
}

function dayBounds(offsetDays = 0) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

export default function Dashboard() {
  const { user } = useAuth();
  const [todayEvents, setTodayEvents] = useState<CalendarEvent[]>([]);
  const [tomorrowEvents, setTomorrowEvents] = useState<CalendarEvent[]>([]);
  const [summary, setSummary] = useState<TaskSummary | null>(null);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [announcementIndex, setAnnouncementIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const level = ROLE_LEVELS[user?.role ?? "user"] || 1;
  const isManager = level >= 2 || !!user?.has_reports;

  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const load = useCallback(async () => {
    const today = dayBounds(0);
    const tomorrow = dayBounds(1);
    const [tRes, tmRes, sRes, aRes] = await Promise.allSettled([
      getCalendarEvents(today.from, today.to),
      getCalendarEvents(tomorrow.from, tomorrow.to),
      getTaskSummary(),
      getActiveAnnouncements(),
    ]);
    if (tRes.status === "fulfilled") setTodayEvents(tRes.value.data || []);
    if (tmRes.status === "fulfilled") setTomorrowEvents(tmRes.value.data || []);
    if (sRes.status === "fulfilled") setSummary(sRes.value.data || null);
    if (aRes.status === "fulfilled") {
      const payload = aRes.value.data;
      const list = Array.isArray(payload) ? payload : payload?.data || [];
      setAnnouncements(list);
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  // Rotate announcements every few seconds.
  useEffect(() => {
    if (announcements.length <= 1) return;
    const id = setInterval(() => {
      setAnnouncementIndex((prev) => (prev + 1) % announcements.length);
    }, ANNOUNCEMENT_ROTATION);
    return () => clearInterval(id);
  }, [announcements.length]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={theme.primary}
        />
      }
    >
      {/* Greeting banner */}
      <View style={styles.greetingBanner}>
        <Text style={styles.greetingText}>
          {getGreeting()}, {user?.full_name || user?.username || "there"}!
        </Text>
        <Text style={styles.greetingDate}>{dateStr}</Text>

        {announcements.length > 0 ? (
          <View style={styles.announcement}>
            <Text style={styles.announcementText}>
              {announcements[announcementIndex]?.type === "quote"
                ? `"${announcements[announcementIndex]?.message}"`
                : announcements[announcementIndex]?.message}
            </Text>
            {announcements.length > 1 ? (
              <View style={styles.dots}>
                {announcements.map((_, i) => (
                  <Pressable
                    key={i}
                    hitSlop={6}
                    onPress={() => setAnnouncementIndex(i)}
                  >
                    <View
                      style={[
                        styles.dotDim,
                        i === announcementIndex && styles.dotActive,
                      ]}
                    />
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}
      </View>

      {/* Work timer */}
      <WorkTimerCard />

      {loading ? (
        <ActivityIndicator color={theme.primary} style={{ marginTop: 12 }} />
      ) : (
        <>
          {/* Today's Events (meetings + events + tomorrow) */}
          <TodayEventsCard events={todayEvents} tomorrowEvents={tomorrowEvents} />

          {/* Today's Planner */}
          <TasksSummaryCard taskSummary={summary} />

          {/* Sprint progress (or backlog fallback when no active sprint) */}
          <SprintProgressCard />

          {/* Pending approvals (managers only — hides itself when empty) */}
          {isManager ? <PendingApprovalsCard /> : null}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  container: { padding: 16, gap: 12, paddingBottom: 32 },
  greetingBanner: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    padding: 18,
    gap: 4,
  },
  greetingText: {
    fontSize: 20,
    fontWeight: "800",
    color: theme.text,
    letterSpacing: -0.5,
  },
  greetingDate: { fontSize: 13, color: theme.textMuted, fontWeight: "500" },
  announcement: {
    marginTop: 12,
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    padding: 12,
    gap: 8,
  },
  announcementText: {
    fontSize: 13,
    color: theme.textSecondary,
    lineHeight: 18,
    fontStyle: "italic",
  },
  dots: { flexDirection: "row", gap: 6, alignSelf: "center" },
  dotDim: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.textMuted,
    opacity: 0.4,
  },
  dotActive: { backgroundColor: theme.primary, opacity: 1 },
});