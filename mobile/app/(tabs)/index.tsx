import { useCallback, useEffect, useMemo, useState } from "react";
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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../src/auth/AuthContext";
import { socket } from "../../src/realtime/socket";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
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
  const start = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + offsetDays,
  );
  const end = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + offsetDays + 1,
  );
  return { from: start.toISOString(), to: end.toISOString() };
}

const DASHBOARD_QUERY_KEY = ["dashboard", "home"] as const;

type DashboardData = {
  todayEvents: CalendarEvent[];
  tomorrowEvents: CalendarEvent[];
  summary: TaskSummary | null;
  announcements: Announcement[];
};

async function fetchDashboard(): Promise<DashboardData> {
  const today = dayBounds(0);
  const tomorrow = dayBounds(1);
  const [tRes, tmRes, sRes, aRes] = await Promise.allSettled([
    getCalendarEvents(today.from, today.to),
    getCalendarEvents(tomorrow.from, tomorrow.to),
    getTaskSummary(),
    getActiveAnnouncements(),
  ]);
  const announcementsPayload =
    aRes.status === "fulfilled" ? aRes.value.data : null;
  return {
    todayEvents: tRes.status === "fulfilled" ? tRes.value.data || [] : [],
    tomorrowEvents: tmRes.status === "fulfilled" ? tmRes.value.data || [] : [],
    summary: sRes.status === "fulfilled" ? sRes.value.data || null : null,
    announcements: Array.isArray(announcementsPayload)
      ? announcementsPayload
      : announcementsPayload?.data || [],
  };
}

export default function Dashboard() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Stale-while-revalidate: cached data (restored from MMKV on a cold start)
  // renders instantly while a background refetch keeps it fresh. The full-card
  // spinner only shows on the very first load when there is nothing cached yet.
  const { data, isLoading, refetch } = useQuery({
    queryKey: DASHBOARD_QUERY_KEY,
    queryFn: fetchDashboard,
  });
  const todayEvents = data?.todayEvents ?? [];
  const tomorrowEvents = data?.tomorrowEvents ?? [];
  const summary = data?.summary ?? null;
  const announcements = data?.announcements ?? [];
  const [announcementIndex, setAnnouncementIndex] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const level = ROLE_LEVELS[user?.role ?? "user"] || 1;
  const isManager = level >= 2 || !!user?.has_reports;

  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  // Rotate announcements every few seconds.
  useEffect(() => {
    if (announcements.length <= 1) return;
    const id = setInterval(() => {
      setAnnouncementIndex((prev) => (prev + 1) % announcements.length);
    }, ANNOUNCEMENT_ROTATION);
    return () => clearInterval(id);
  }, [announcements.length]);

  // Background-refresh on focus: marks the query stale so it refetches while the
  // already-rendered cached data stays visible — no spinner, no blank flash.
  useFocusEffect(
    useCallback(() => {
      queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY });
    }, [queryClient]),
  );

  // Real-time refresh: refetch events when a calendar/meeting change is
  // broadcast (mirrors the web Dashboard's useWebSocket subscription).
  useEffect(() => {
    const off = socket.subscribe((msg) => {
      if (
        msg.type === "calendar_refresh" ||
        msg.type === "meeting_updated" ||
        msg.type === "meeting_cancelled"
      ) {
        queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY });
      }
    });
    return off;
  }, [queryClient]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }, [refetch]);

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

      {isLoading ? (
        <ActivityIndicator color={theme.primary} style={{ marginTop: 12 }} />
      ) : (
        <>
          {/* Today's Events (meetings + events + tomorrow) */}
          <TodayEventsCard
            events={todayEvents}
            tomorrowEvents={tomorrowEvents}
          />

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

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
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
