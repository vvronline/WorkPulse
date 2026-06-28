import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Clock,
  Plus,
  Trash2,
  Video,
  X,
} from "lucide-react-native";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { useAuth, userHasFeature } from "../../src/auth/AuthContext";
import {
  checkMeetingConflicts,
  createCalendarEvent,
  createMeeting,
  deleteCalendarEvent,
  getCalendarEvents,
  getMeeting,
  searchChatUsers,
  updateCalendarEvent,
  type CalendarEvent,
  type MeetingConflict,
  type MeetingParticipant,
} from "../../src/features";
import { SERVER_ORIGIN } from "../../src/config";
import { Linking } from "react-native";
import { useRouter } from "expo-router";
import { useFocusEffect } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { socket } from "../../src/realtime/socket";
import { makeStyles } from "./calendar.styles";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function eventLocalDay(ev: CalendarEvent) {
  return ymd(new Date(ev.start_time));
}

function fmtEventTime(ev: CalendarEvent) {
  if (ev.all_day) return "All day";
  const s = new Date(ev.start_time);
  return s.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** Build the 6x7 grid of dates for the month containing `cursor`. */
function buildMonthGrid(cursor: Date): Date[] {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const startOffset = first.getDay(); // 0 = Sunday
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - startOffset);
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    days.push(d);
  }
  return days;
}

// Stable empty reference so memoized derivations don't recompute while the
// query is still resolving (data is undefined until the first fetch lands).
const EMPTY_EVENTS: CalendarEvent[] = [];

async function fetchCalendarEvents(cursor: Date): Promise<CalendarEvent[]> {
  // Fetch a generous range (month grid +/-) so week/day views within the
  // visible window are covered.
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const grid = buildMonthGrid(first);
  const from = grid[0].toISOString();
  const to = new Date(grid[41].getTime() + 24 * 3600 * 1000).toISOString();
  const { data } = await getCalendarEvents(from, to);
  return data || [];
}

export default function CalendarScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const queryClient = useQueryClient();
  const [view, setView] = useState<"month" | "week" | "day">("month");
  const [cursor, setCursor] = useState(new Date());
  const [selected, setSelected] = useState(ymd(new Date()));
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<CalendarEvent | null>(null);

  const monthDays = useMemo(() => buildMonthGrid(cursor), [cursor]);

  // Stale-while-revalidate per visible month. Cached events (restored from MMKV
  // on a cold start, or a previous visit) render the grid instantly while a
  // background refetch keeps it current — no spinner blocking the calendar.
  const calendarKey = useMemo(
    () => ["calendar", "events", cursor.getFullYear(), cursor.getMonth()],
    [cursor],
  );
  const { data, isFetching } = useQuery({
    queryKey: calendarKey,
    queryFn: () => fetchCalendarEvents(cursor),
  });
  const events = data ?? EMPTY_EVENTS;
  const loading = isFetching;

  // Background-refresh on focus + on real-time calendar/meeting broadcasts
  // (new event, edit, or cancel — including from another device). Cached data
  // stays visible; mirrors the web Calendar's useWebSocket subscription.
  useFocusEffect(
    useCallback(() => {
      queryClient.invalidateQueries({ queryKey: calendarKey });
    }, [queryClient, calendarKey]),
  );

  useEffect(() => {
    const off = socket.subscribe((msg) => {
      if (
        msg.type === "calendar_refresh" ||
        msg.type === "meeting_updated" ||
        msg.type === "meeting_cancelled"
      ) {
        queryClient.invalidateQueries({ queryKey: calendarKey });
      }
    });
    return off;
  }, [queryClient, calendarKey]);

  // Map day -> events for quick lookup.
  const byDay = useMemo(() => {
    const m: Record<string, CalendarEvent[]> = {};
    for (const ev of events) {
      const k = eventLocalDay(ev);
      (m[k] ??= []).push(ev);
    }
    return m;
  }, [events]);

  // Week containing the selected day (Sun..Sat).
  const weekDays = useMemo(() => {
    const base = new Date(selected);
    const start = new Date(base);
    start.setDate(base.getDate() - base.getDay());
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [selected]);

  const selectedEvents = byDay[selected] || [];
  const todayKey = ymd(new Date());

  const headerLabel =
    view === "month"
      ? cursor.toLocaleDateString("en-US", { month: "long", year: "numeric" })
      : view === "week"
        ? `${weekDays[0].toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${weekDays[6].toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
        : new Date(selected).toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
          });

  function shift(delta: number) {
    if (view === "month") {
      setCursor((c) => new Date(c.getFullYear(), c.getMonth() + delta, 1));
    } else {
      const step = view === "week" ? 7 : 1;
      const d = new Date(selected);
      d.setDate(d.getDate() + delta * step);
      const key = ymd(d);
      setSelected(key);
      setCursor(new Date(d.getFullYear(), d.getMonth(), 1));
    }
  }

  function goToday() {
    const now = new Date();
    setCursor(new Date(now.getFullYear(), now.getMonth(), 1));
    setSelected(ymd(now));
  }

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Header */}
        <View style={styles.monthHeader}>
          <Text style={styles.monthLabel}>{headerLabel}</Text>
          <View style={styles.monthNav}>
            <Pressable
              style={styles.navBtn}
              onPress={() => shift(-1)}
              hitSlop={6}
            >
              <ChevronLeft size={20} color={theme.textSecondary} />
            </Pressable>
            <Pressable style={styles.todayBtn} onPress={goToday}>
              <Text style={styles.todayText}>Today</Text>
            </Pressable>
            <Pressable
              style={styles.navBtn}
              onPress={() => shift(1)}
              hitSlop={6}
            >
              <ChevronRight size={20} color={theme.textSecondary} />
            </Pressable>
          </View>
        </View>

        {/* View switcher */}
        <View style={styles.viewSwitch}>
          {(["day", "week", "month"] as const).map((v) => (
            <Pressable
              key={v}
              style={[styles.viewBtn, view === v && styles.viewBtnActive]}
              onPress={() => setView(v)}
            >
              <Text
                style={[styles.viewText, view === v && styles.viewTextActive]}
              >
                {v[0].toUpperCase() + v.slice(1)}
              </Text>
            </Pressable>
          ))}
        </View>

        {view === "month" ? (
          <MonthView
            monthDays={monthDays}
            cursor={cursor}
            byDay={byDay}
            selected={selected}
            todayKey={todayKey}
            onSelect={setSelected}
          />
        ) : view === "week" ? (
          <WeekView
            weekDays={weekDays}
            byDay={byDay}
            selected={selected}
            todayKey={todayKey}
            onSelect={setSelected}
            onEvent={(ev) => {
              setEditing(ev);
              setModal(true);
            }}
          />
        ) : (
          <DayView
            dayEvents={selectedEvents}
            onEvent={(ev) => {
              setEditing(ev);
              setModal(true);
            }}
          />
        )}

        {/* Selected-day events (month + week only) */}
        {view !== "day" ? (
          <>
            <View style={styles.dayHeader}>
              <Text style={styles.dayTitle}>
                {new Date(selected).toLocaleDateString("en-US", {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}
              </Text>
              {loading ? (
                <ActivityIndicator color={theme.primary} size="small" />
              ) : null}
            </View>

            {selectedEvents.length === 0 ? (
              <Text style={styles.emptyDay}>No events on this day</Text>
            ) : (
              <View style={{ gap: 10 }}>
                {selectedEvents.map((item) => (
                  <Pressable
                    key={item.id}
                    style={({ pressed }) => [styles.event, pressed && { opacity: 0.6 }]}
                    onPress={() => {
                      setEditing(item);
                      setModal(true);
                    }}
                  >
                    <View
                      style={[
                        styles.colorBar,
                        { backgroundColor: item.color || theme.primary },
                      ]}
                    />
                    <View style={styles.eventBody}>
                      <View style={styles.eventTitleRow}>
                        {item.meeting_code ? (
                          <Video size={13} color={theme.primary} />
                        ) : null}
                        <Text style={styles.eventTitle} numberOfLines={1}>
                          {item.title}
                        </Text>
                      </View>
                      <View style={styles.eventMeta}>
                        <Clock size={12} color={theme.textMuted} />
                        <Text style={styles.eventTime}>
                          {fmtEventTime(item)}
                        </Text>
                      </View>
                      {item.description ? (
                        <Text style={styles.eventDesc} numberOfLines={2}>
                          {item.description}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                ))}
              </View>
            )}
          </>
        ) : null}
      </ScrollView>

      <Pressable
        style={styles.fab}
        onPress={() => {
          setEditing(null);
          setModal(true);
        }}
      >
        <Plus size={24} color="#fff" />
      </Pressable>

      <EventModal
        visible={modal}
        selectedDay={selected}
        editing={editing}
        onClose={() => {
          setModal(false);
          setEditing(null);
        }}
        onSaved={() => {
          setModal(false);
          setEditing(null);
          queryClient.invalidateQueries({ queryKey: calendarKey });
        }}
      />
    </View>
  );
}

/* ───────────────────────── Month view ───────────────────────── */
function MonthView({
  monthDays,
  cursor,
  byDay,
  selected,
  todayKey,
  onSelect,
}: {
  monthDays: Date[];
  cursor: Date;
  byDay: Record<string, CalendarEvent[]>;
  selected: string;
  todayKey: string;
  onSelect: (key: string) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <>
      <View style={styles.weekRow}>
        {WEEKDAYS.map((w, i) => (
          <Text key={i} style={styles.weekday}>
            {w}
          </Text>
        ))}
      </View>
      <View style={styles.grid}>
        {monthDays.map((d) => {
          const key = ymd(d);
          const inMonth = d.getMonth() === cursor.getMonth();
          const isToday = key === todayKey;
          const isSelected = key === selected;
          const dayEvents = byDay[key] || [];
          return (
            <Pressable
              key={key}
              style={styles.cell}
              onPress={() => onSelect(key)}
            >
              <View
                style={[
                  styles.cellInner,
                  isSelected && styles.cellSelected,
                  isToday && !isSelected && styles.cellToday,
                ]}
              >
                <Text
                  style={[
                    styles.cellNum,
                    !inMonth && styles.cellNumMuted,
                    (isSelected || isToday) && styles.cellNumActive,
                  ]}
                >
                  {d.getDate()}
                </Text>
                <View style={styles.dots}>
                  {dayEvents.slice(0, 3).map((ev, i) => (
                    <View
                      key={i}
                      style={[
                        styles.dayDot,
                        {
                          backgroundColor: ev.meeting_code
                            ? theme.primary
                            : ev.color || theme.primary,
                        },
                      ]}
                    />
                  ))}
                </View>
              </View>
            </Pressable>
          );
        })}
      </View>
    </>
  );
}

/* ───────────────────────── Week view ───────────────────────── */
function WeekView({
  weekDays,
  byDay,
  selected,
  todayKey,
  onSelect,
  onEvent,
}: {
  weekDays: Date[];
  byDay: Record<string, CalendarEvent[]>;
  selected: string;
  todayKey: string;
  onSelect: (key: string) => void;
  onEvent: (ev: CalendarEvent) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={{ gap: 10 }}>
      {/* Day selector strip */}
      <View style={styles.weekStrip}>
        {weekDays.map((d) => {
          const key = ymd(d);
          const isSelected = key === selected;
          const isToday = key === todayKey;
          const count = (byDay[key] || []).length;
          return (
            <Pressable
              key={key}
              style={[styles.weekDayBtn, isSelected && styles.weekDayBtnActive]}
              onPress={() => onSelect(key)}
            >
              <Text
                style={[
                  styles.weekDayName,
                  (isSelected || isToday) && styles.weekDayActiveText,
                ]}
              >
                {d.toLocaleDateString("en-US", { weekday: "short" })[0]}
              </Text>
              <Text
                style={[
                  styles.weekDayNum,
                  isSelected && styles.weekDayActiveText,
                  isToday && !isSelected && { color: theme.primary },
                ]}
              >
                {d.getDate()}
              </Text>
              {count > 0 ? (
                <View
                  style={[
                    styles.weekCountDot,
                    { backgroundColor: isSelected ? "#fff" : theme.primary },
                  ]}
                />
              ) : (
                <View style={styles.weekCountSpacer} />
              )}
            </Pressable>
          );
        })}
      </View>
      <HourlyGrid dayEvents={byDay[selected] || []} onEvent={onEvent} />
    </View>
  );
}

/* ───────────────────────── Day view ───────────────────────── */
function DayView({
  dayEvents,
  onEvent,
}: {
  dayEvents: CalendarEvent[];
  onEvent: (ev: CalendarEvent) => void;
}) {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return <HourlyGrid dayEvents={dayEvents} onEvent={onEvent} />;
}

/* Shared 12 AM .. 11 PM hourly timeline for week/day views. */
function HourlyGrid({
  dayEvents,
  onEvent,
}: {
  dayEvents: CalendarEvent[];
  onEvent: (ev: CalendarEvent) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const byHour: Record<number, CalendarEvent[]> = {};
  for (const ev of dayEvents) {
    const h = ev.all_day ? -1 : new Date(ev.start_time).getHours();
    (byHour[h] ??= []).push(ev);
  }
  const allDay = byHour[-1] || [];
  const label = (h: number) => {
    const ampm = h < 12 ? "AM" : "PM";
    const hh = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${hh} ${ampm}`;
  };

  return (
    <View style={styles.hourly}>
      {allDay.length > 0 ? (
        <View style={styles.hourRow}>
          <Text style={styles.hourLabel}>All day</Text>
          <View style={styles.hourCell}>
            {allDay.map((ev) => {
              const evColor = ev.meeting_code
                ? theme.primary
                : ev.color || theme.primary;
              return (
                <Pressable
                  key={ev.id}
                  style={[
                    styles.hourEvent,
                    { backgroundColor: evColor + "33", borderColor: evColor },
                  ]}
                  onPress={() => onEvent(ev)}
                >
                  {ev.meeting_code ? (
                    <Video size={11} color={theme.primary} />
                  ) : null}
                  <Text style={styles.hourEventText} numberOfLines={1}>
                    {ev.title}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}
      {Array.from({ length: 24 }, (_, h) => (
        <View key={h} style={styles.hourRow}>
          <Text style={styles.hourLabel}>{label(h)}</Text>
          <View style={styles.hourCell}>
            {(byHour[h] || []).map((ev) => {
              const evColor = ev.meeting_code
                ? theme.primary
                : ev.color || theme.primary;
              return (
                <Pressable
                  key={ev.id}
                  style={[
                    styles.hourEvent,
                    { backgroundColor: evColor + "33", borderColor: evColor },
                  ]}
                  onPress={() => onEvent(ev)}
                >
                  {ev.meeting_code ? (
                    <Video size={11} color={theme.primary} />
                  ) : null}
                  <Text style={styles.hourEventText} numberOfLines={1}>
                    {ev.title}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
    </View>
  );
}

const EVENT_COLORS = [
  "#2383e2",
  "#4daa57",
  "#cb912f",
  "#e03e3e",
  "#9b59b6",
  "#0ea5e9",
];

function toISOLocal(day: string, hour: number, minute: number) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, hour, minute, 0, 0).toISOString();
}

type Invitee = { id: number; full_name: string; username?: string };

function EventModal({
  visible,
  selectedDay,
  editing,
  onClose,
  onSaved,
}: {
  visible: boolean;
  selectedDay: string;
  editing: CalendarEvent | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const { user } = useAuth();
  const meetingsEnabled = userHasFeature(user, "meetings");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [startHour, setStartHour] = useState(9);
  const [durationHrs, setDurationHrs] = useState(1);
  const [color, setColor] = useState(EVENT_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Meeting scheduling state (create-mode only, mirrors the web EventFormModal).
  const [addMeeting, setAddMeeting] = useState(false);
  // Separate required / optional participant lists (matches the web modal).
  const [requiredParticipants, setRequiredParticipants] = useState<Invitee[]>(
    [],
  );
  const [optionalParticipants, setOptionalParticipants] = useState<Invitee[]>(
    [],
  );
  const [pickerTarget, setPickerTarget] = useState<"required" | "optional">(
    "required",
  );
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Invitee[]>([]);
  const [searching, setSearching] = useState(false);
  const [muteOnJoin, setMuteOnJoin] = useState(false);
  const [allowScreenShare, setAllowScreenShare] = useState(true);
  const [conflicts, setConflicts] = useState<MeetingConflict[]>([]);
  // Participant roster for an existing meeting-linked event (edit mode).
  const [meetingParticipants, setMeetingParticipants] = useState<
    MeetingParticipant[]
  >([]);

  const allParticipants = useMemo(
    () => [...requiredParticipants, ...optionalParticipants],
    [requiredParticipants, optionalParticipants],
  );

  // The current user can only edit/cancel a meeting-linked event when they are
  // the organizer. Plain (non-meeting) events are always editable. Mirrors the
  // web `isOrganizer` gate that makes the modal read-only for invitees.
  const isOrganizer =
    !editing?.meeting_code ||
    editing?.meeting_created_by == null ||
    editing?.meeting_created_by === user?.id;
  const readOnly = !!editing?.meeting_code && !isOrganizer;
  const hasMeeting = !!editing?.meeting_code;

  // Hydrate fields from the editing event (or defaults) when opened.
  useEffect(() => {
    if (!visible) return;
    // Reset meeting state each time the modal opens.
    setAddMeeting(false);
    setRequiredParticipants([]);
    setOptionalParticipants([]);
    setPickerTarget("required");
    setQuery("");
    setResults([]);
    setMuteOnJoin(false);
    setAllowScreenShare(true);
    setConflicts([]);
    setMeetingParticipants([]);
    if (editing) {
      setTitle(editing.title);
      setDescription(editing.description || "");
      setAllDay(editing.all_day);
      const s = new Date(editing.start_time);
      const e = new Date(editing.end_time);
      setStartHour(s.getHours());
      setDurationHrs(
        Math.max(1, Math.round((e.getTime() - s.getTime()) / 3600000)),
      );
      setColor(editing.color || EVENT_COLORS[0]);
    } else {
      setTitle("");
      setDescription("");
      setAllDay(false);
      const now = new Date();
      const isToday = selectedDay === ymd(now);
      setStartHour(isToday ? Math.min(23, now.getHours() + 1) : 9);
      setDurationHrs(1);
      setColor(EVENT_COLORS[0]);
    }
  }, [visible, editing, selectedDay]);

  // Debounced people search for the participant picker.
  useEffect(() => {
    if (!addMeeting) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await searchChatUsers(q);
        const chosen = new Set(allParticipants.map((p) => p.id));
        setResults(
          (r.data || [])
            .filter((u) => !chosen.has(u.id) && u.id !== user?.id)
            .map((u) => ({
              id: u.id,
              full_name: u.full_name || u.username,
              username: u.username,
            })),
        );
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [query, addMeeting, allParticipants, user?.id]);

  // Load the participant roster for an existing meeting-linked event so the
  // banner can show Required/Optional badges + the organizer tag (mirrors web).
  useEffect(() => {
    if (!visible || !editing?.meeting_code) {
      setMeetingParticipants([]);
      return;
    }
    let cancelled = false;
    getMeeting(editing.meeting_code)
      .then((r) => {
        if (!cancelled) setMeetingParticipants(r.data?.participants || []);
      })
      .catch(() => {
        if (!cancelled) setMeetingParticipants([]);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, editing?.meeting_code]);

  const day = editing ? ymd(new Date(editing.start_time)) : selectedDay;
  const startISO = allDay
    ? toISOLocal(day, 0, 0)
    : toISOLocal(day, startHour, 0);
  const endISO = allDay
    ? toISOLocal(day, 23, 59)
    : toISOLocal(day, Math.min(23, startHour + durationHrs), 0);

  // Debounced conflict check whenever participants/time change.
  useEffect(() => {
    if (!addMeeting || allParticipants.length === 0) {
      setConflicts([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const r = await checkMeetingConflicts({
          user_ids: allParticipants.map((p) => p.id),
          start_time: startISO,
          end_time: endISO,
        });
        setConflicts(r.data?.conflicts || []);
      } catch {
        setConflicts([]);
      }
    }, 500);
    return () => clearTimeout(t);
  }, [addMeeting, allParticipants, startISO, endISO]);

  const hour12 = (h: number) => {
    const ampm = h < 12 ? "AM" : "PM";
    const hh = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${hh}:00 ${ampm}`;
  };

  // Add a person to the currently-targeted (required/optional) list.
  function addParticipant(u: Invitee) {
    if (pickerTarget === "optional") {
      setOptionalParticipants((prev) => [...prev, u]);
    } else {
      setRequiredParticipants((prev) => [...prev, u]);
    }
    setQuery("");
    setResults([]);
  }

  function removeParticipant(id: number) {
    setRequiredParticipants((prev) => prev.filter((p) => p.id !== id));
    setOptionalParticipants((prev) => prev.filter((p) => p.id !== id));
  }

  async function submit() {
    if (!title.trim()) return;
    setBusy(true);
    const start_time = startISO;
    const end_time = endISO;
    try {
      if (editing) {
        await updateCalendarEvent(editing.id, {
          title: title.trim(),
          description: description.trim() || undefined,
          start_time,
          end_time,
          all_day: allDay,
          color,
        });
      } else if (addMeeting && meetingsEnabled) {
        // Create the meeting first, then link it to the calendar event so the
        // server fans the event out to every invited participant.
        const mtg = await createMeeting({
          title: title.trim(),
          description: description.trim() || undefined,
          required_participant_ids: requiredParticipants.map((p) => p.id),
          optional_participant_ids: optionalParticipants.map((p) => p.id),
          settings: { muteOnJoin, allowScreenShare },
          start_time,
          end_time,
        });
        await createCalendarEvent({
          title: title.trim(),
          description: description.trim() || undefined,
          start_time,
          end_time,
          all_day: false,
          color,
          meeting_id: mtg.data.id,
        });
      } else {
        await createCalendarEvent({
          title: title.trim(),
          description: description.trim() || undefined,
          start_time,
          end_time,
          all_day: allDay,
          color,
        });
      }
      onSaved();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save event");
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete() {
    if (!editing) return;
    Alert.alert("Delete Event", `Delete "${editing.title}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setDeleting(true);
          try {
            await deleteCalendarEvent(editing.id);
            onSaved();
          } catch (e: any) {
            Alert.alert(
              "Error",
              e?.response?.data?.error || "Failed to delete",
            );
          } finally {
            setDeleting(false);
          }
        },
      },
    ]);
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={styles.modalOverlay}>
        <ScrollView
          style={styles.modalScroll}
          contentContainerStyle={styles.modalCard}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>
              {!editing
                ? "New Event"
                : readOnly
                  ? "Event Details"
                  : "Edit Event"}
            </Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <X size={22} color={theme.textSecondary} />
            </Pressable>
          </View>

          {/* Invitees can only view a meeting-linked event. */}
          {readOnly ? (
            <Text style={styles.readOnlyNote}>
              Only the meeting organizer can edit or cancel this event.
            </Text>
          ) : null}

          <Text style={styles.label}>Title</Text>
          <TextInput
            style={[styles.input, readOnly && styles.inputDisabled]}
            placeholder="Event title"
            placeholderTextColor={theme.textMuted}
            value={title}
            onChangeText={setTitle}
            editable={!readOnly}
          />

          <Text style={styles.label}>Description (optional)</Text>
          <TextInput
            style={[
              styles.input,
              styles.textarea,
              readOnly && styles.inputDisabled,
            ]}
            placeholder="Details"
            placeholderTextColor={theme.textMuted}
            value={description}
            onChangeText={setDescription}
            multiline
            editable={!readOnly}
          />

          {/* All-day toggle */}
          <Pressable
            style={styles.toggleRow}
            onPress={() => !readOnly && setAllDay((v) => !v)}
            disabled={readOnly}
          >
            <Text style={styles.toggleLabel}>All day</Text>
            <View style={[styles.toggle, allDay && styles.toggleOn]}>
              <View style={[styles.knob, allDay && styles.knobOn]} />
            </View>
          </Pressable>

          {/* Time steppers (hidden when all-day) */}
          {!allDay ? (
            <>
              <Text style={styles.label}>Start</Text>
              <View style={styles.stepper}>
                <Pressable
                  style={styles.stepBtn}
                  onPress={() => setStartHour((h) => Math.max(0, h - 1))}
                >
                  <Text style={styles.stepBtnText}>−</Text>
                </Pressable>
                <Text style={styles.stepValue}>{hour12(startHour)}</Text>
                <Pressable
                  style={styles.stepBtn}
                  onPress={() => setStartHour((h) => Math.min(23, h + 1))}
                >
                  <Text style={styles.stepBtnText}>+</Text>
                </Pressable>
              </View>

              <Text style={styles.label}>Duration</Text>
              <View style={styles.stepper}>
                <Pressable
                  style={styles.stepBtn}
                  onPress={() => setDurationHrs((d) => Math.max(1, d - 1))}
                >
                  <Text style={styles.stepBtnText}>−</Text>
                </Pressable>
                <Text style={styles.stepValue}>
                  {durationHrs} hour{durationHrs > 1 ? "s" : ""}
                </Text>
                <Pressable
                  style={styles.stepBtn}
                  onPress={() => setDurationHrs((d) => Math.min(12, d + 1))}
                >
                  <Text style={styles.stepBtnText}>+</Text>
                </Pressable>
              </View>
            </>
          ) : null}

          {/* Color */}
          <Text style={styles.label}>Color</Text>
          <View style={styles.colorRow}>
            {EVENT_COLORS.map((c) => (
              <Pressable
                key={c}
                style={[
                  styles.swatch,
                  { backgroundColor: c },
                  color === c && styles.swatchActive,
                ]}
                onPress={() => !readOnly && setColor(c)}
                disabled={readOnly}
              />
            ))}
          </View>

          {/* Online meeting banner for an existing meeting-linked event */}
          {editing && editing.meeting_code ? (
            <View style={styles.meetingBanner}>
              <View style={styles.meetingBannerHead}>
                <Video size={16} color={theme.primary} />
                <Text style={styles.meetingBannerTitle}>Online meeting</Text>
              </View>
              <Text style={styles.meetingCodeText} selectable>
                {SERVER_ORIGIN}/meeting/{editing.meeting_code}
              </Text>
              <Pressable
                style={styles.joinBtn}
                onPress={() => {
                  const code = editing.meeting_code;
                  onClose();
                  // Open the in-app WebRTC meeting room (reuses the
                  // authenticated session) instead of bouncing to the browser.
                  router.push(`/meeting/${code}` as never);
                }}
              >
                <Video size={15} color="#fff" />
                <Text style={styles.joinBtnText}>Join Meeting</Text>
              </Pressable>

              {/* Participant roster (Required / Optional + organizer tag) */}
              {meetingParticipants.length > 0 ? (
                <View style={styles.rosterWrap}>
                  <View style={styles.rosterGroup}>
                    <Text style={styles.rosterGroupLabel}>Required</Text>
                    <View style={styles.rosterChips}>
                      {meetingParticipants
                        .filter(
                          (p) =>
                            p.role === "organizer" ||
                            p.participant_type === "required",
                        )
                        .map((p) => (
                          <View
                            key={String(p.user_id)}
                            style={styles.rosterBadge}
                          >
                            <Text style={styles.rosterBadgeText}>
                              {String(p.full_name || p.username || "User")}
                              {p.role === "organizer" ? " (organizer)" : ""}
                            </Text>
                          </View>
                        ))}
                    </View>
                  </View>
                  {meetingParticipants.some(
                    (p) => p.participant_type === "optional",
                  ) ? (
                    <View style={styles.rosterGroup}>
                      <Text style={styles.rosterGroupLabel}>Optional</Text>
                      <View style={styles.rosterChips}>
                        {meetingParticipants
                          .filter((p) => p.participant_type === "optional")
                          .map((p) => (
                            <View
                              key={String(p.user_id)}
                              style={[
                                styles.rosterBadge,
                                styles.rosterBadgeOptional,
                              ]}
                            >
                              <Text style={styles.rosterBadgeText}>
                                {String(p.full_name || p.username || "User")}
                              </Text>
                            </View>
                          ))}
                      </View>
                    </View>
                  ) : null}
                </View>
              ) : null}
            </View>
          ) : null}

          {/* Add-online-meeting toggle + participant picker (create mode only) */}
          {!editing && meetingsEnabled ? (
            <>
              <Pressable
                style={styles.toggleRow}
                onPress={() => {
                  const next = !addMeeting;
                  setAddMeeting(next);
                  // Meetings need a specific time slot — turn off all-day.
                  if (next && allDay) setAllDay(false);
                }}
              >
                <View style={styles.meetingToggleLabel}>
                  <Video size={16} color={theme.primary} />
                  <Text style={styles.toggleLabel}>Add online meeting</Text>
                </View>
                <View style={[styles.toggle, addMeeting && styles.toggleOn]}>
                  <View style={[styles.knob, addMeeting && styles.knobOn]} />
                </View>
              </Pressable>

              {addMeeting ? (
                <View style={styles.meetingOptions}>
                  {/* Required participants */}
                  <Text style={styles.label}>Required participants</Text>
                  {requiredParticipants.length > 0 ? (
                    <View style={styles.chipWrap}>
                      {requiredParticipants.map((p) => {
                        const hasConflict = conflicts.some(
                          (c) => c.userId === p.id,
                        );
                        return (
                          <View
                            key={p.id}
                            style={[
                              styles.chip,
                              hasConflict && styles.chipConflict,
                            ]}
                          >
                            {hasConflict ? (
                              <AlertTriangle size={11} color={theme.danger} />
                            ) : null}
                            <Text style={styles.chipText} numberOfLines={1}>
                              {p.full_name}
                            </Text>
                            <Pressable
                              onPress={() => removeParticipant(p.id)}
                              hitSlop={6}
                            >
                              <X size={12} color={theme.textSecondary} />
                            </Pressable>
                          </View>
                        );
                      })}
                    </View>
                  ) : null}

                  {/* Optional participants */}
                  <Text style={styles.label}>Optional participants</Text>
                  {optionalParticipants.length > 0 ? (
                    <View style={styles.chipWrap}>
                      {optionalParticipants.map((p) => {
                        const hasConflict = conflicts.some(
                          (c) => c.userId === p.id,
                        );
                        return (
                          <View
                            key={p.id}
                            style={[
                              styles.chip,
                              styles.chipOptional,
                              hasConflict && styles.chipConflict,
                            ]}
                          >
                            {hasConflict ? (
                              <AlertTriangle size={11} color={theme.danger} />
                            ) : null}
                            <Text style={styles.chipText} numberOfLines={1}>
                              {p.full_name}
                            </Text>
                            <Pressable
                              onPress={() => removeParticipant(p.id)}
                              hitSlop={6}
                            >
                              <X size={12} color={theme.textSecondary} />
                            </Pressable>
                          </View>
                        );
                      })}
                    </View>
                  ) : null}

                  {/* Required/Optional target switch for the search box */}
                  <View style={styles.pickerTargetRow}>
                    <Pressable
                      style={[
                        styles.pickerTargetBtn,
                        pickerTarget === "required" &&
                          styles.pickerTargetBtnActive,
                      ]}
                      onPress={() => setPickerTarget("required")}
                    >
                      <Text
                        style={[
                          styles.pickerTargetText,
                          pickerTarget === "required" &&
                            styles.pickerTargetTextActive,
                        ]}
                      >
                        Required
                      </Text>
                    </Pressable>
                    <Pressable
                      style={[
                        styles.pickerTargetBtn,
                        pickerTarget === "optional" &&
                          styles.pickerTargetBtnActive,
                      ]}
                      onPress={() => setPickerTarget("optional")}
                    >
                      <Text
                        style={[
                          styles.pickerTargetText,
                          pickerTarget === "optional" &&
                            styles.pickerTargetTextActive,
                        ]}
                      >
                        Optional
                      </Text>
                    </Pressable>
                  </View>
                  <TextInput
                    style={styles.input}
                    placeholder={`Search people to invite (${pickerTarget})…`}
                    placeholderTextColor={theme.textMuted}
                    value={query}
                    onChangeText={setQuery}
                    autoCapitalize="none"
                  />
                  {searching ? (
                    <ActivityIndicator
                      color={theme.primary}
                      size="small"
                      style={{ marginTop: 6 }}
                    />
                  ) : null}
                  {results.length > 0 ? (
                    <View style={styles.resultsList}>
                      {results.map((u) => (
                        <Pressable
                          key={u.id}
                          style={styles.resultRow}
                          onPress={() => addParticipant(u)}
                        >
                          <Text style={styles.resultName}>{u.full_name}</Text>
                          {u.username ? (
                            <Text style={styles.resultUser}>@{u.username}</Text>
                          ) : null}
                        </Pressable>
                      ))}
                    </View>
                  ) : null}

                  {conflicts.length > 0 ? (
                    <View style={styles.conflictBox}>
                      <AlertTriangle size={14} color={theme.danger} />
                      <View style={{ flex: 1 }}>
                        {conflicts.map((c) => (
                          <Text key={c.userId} style={styles.conflictText}>
                            <Text style={styles.conflictName}>{c.name}</Text>{" "}
                            has a conflict: “{c.events[0]?.title}”
                          </Text>
                        ))}
                      </View>
                    </View>
                  ) : null}

                  <Pressable
                    style={styles.settingRow}
                    onPress={() => setMuteOnJoin((v) => !v)}
                  >
                    <View
                      style={[styles.checkbox, muteOnJoin && styles.checkboxOn]}
                    >
                      {muteOnJoin ? (
                        <Text style={styles.checkMark}>✓</Text>
                      ) : null}
                    </View>
                    <Text style={styles.settingText}>
                      Mute participants on join
                    </Text>
                  </Pressable>
                  <Pressable
                    style={styles.settingRow}
                    onPress={() => setAllowScreenShare((v) => !v)}
                  >
                    <View
                      style={[
                        styles.checkbox,
                        allowScreenShare && styles.checkboxOn,
                      ]}
                    >
                      {allowScreenShare ? (
                        <Text style={styles.checkMark}>✓</Text>
                      ) : null}
                    </View>
                    <Text style={styles.settingText}>Allow screen sharing</Text>
                  </Pressable>
                </View>
              ) : null}
            </>
          ) : null}

          {/* Invitees can't save — only the organizer sees the Save button. */}
          {!readOnly ? (
            <Pressable
              style={[
                styles.submit,
                (!title.trim() || busy) && styles.submitDisabled,
              ]}
              onPress={submit}
              disabled={!title.trim() || busy}
            >
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.submitText}>
                  {editing ? "Save Changes" : "Create Event"}
                </Text>
              )}
            </Pressable>
          ) : null}

          {/* Delete/Cancel is organizer-only. Meeting events read "Cancel Event". */}
          {editing && !readOnly ? (
            <Pressable
              style={styles.deleteBtn}
              onPress={confirmDelete}
              disabled={deleting}
            >
              <Trash2 size={16} color={theme.danger} />
              <Text style={styles.deleteText}>
                {deleting
                  ? hasMeeting
                    ? "Cancelling..."
                    : "Deleting..."
                  : hasMeeting
                    ? "Cancel Event"
                    : "Delete Event"}
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}
