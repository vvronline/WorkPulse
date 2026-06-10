import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { ChevronLeft, ChevronRight, Clock, Plus, Trash2, X } from "lucide-react-native";
import { theme } from "../../src/theme";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  getCalendarEvents,
  updateCalendarEvent,
  type CalendarEvent,
} from "../../src/features";

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

export default function CalendarScreen() {
  const [view, setView] = useState<"month" | "week" | "day">("month");
  const [cursor, setCursor] = useState(new Date());
  const [selected, setSelected] = useState(ymd(new Date()));
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<CalendarEvent | null>(null);

  const monthDays = useMemo(() => buildMonthGrid(cursor), [cursor]);

  const load = useCallback(async (forCursor: Date) => {
    setLoading(true);
    // Fetch a generous range (month grid +/-) so week/day views within the
    // visible window are covered.
    const first = new Date(forCursor.getFullYear(), forCursor.getMonth(), 1);
    const grid = buildMonthGrid(first);
    const from = grid[0].toISOString();
    const to = new Date(grid[41].getTime() + 24 * 3600 * 1000).toISOString();
    try {
      const { data } = await getCalendarEvents(from, to);
      setEvents(data || []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(cursor);
  }, [cursor, load]);

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
            <Pressable style={styles.navBtn} onPress={() => shift(-1)} hitSlop={6}>
              <ChevronLeft size={20} color={theme.textSecondary} />
            </Pressable>
            <Pressable style={styles.todayBtn} onPress={goToday}>
              <Text style={styles.todayText}>Today</Text>
            </Pressable>
            <Pressable style={styles.navBtn} onPress={() => shift(1)} hitSlop={6}>
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
              <Text style={[styles.viewText, view === v && styles.viewTextActive]}>
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
              {loading ? <ActivityIndicator color={theme.primary} size="small" /> : null}
            </View>

            {selectedEvents.length === 0 ? (
              <Text style={styles.emptyDay}>No events on this day</Text>
            ) : (
              <View style={{ gap: 10 }}>
                {selectedEvents.map((item) => (
                  <Pressable
                    key={item.id}
                    style={styles.event}
                    onPress={() => {
                      setEditing(item);
                      setModal(true);
                    }}
                    android_ripple={{ color: theme.surfaceHover }}
                  >
                    <View
                      style={[styles.colorBar, { backgroundColor: item.color || theme.primary }]}
                    />
                    <View style={styles.eventBody}>
                      <Text style={styles.eventTitle} numberOfLines={1}>
                        {item.title}
                      </Text>
                      <View style={styles.eventMeta}>
                        <Clock size={12} color={theme.textMuted} />
                        <Text style={styles.eventTime}>{fmtEventTime(item)}</Text>
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
          load(cursor);
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
            <Pressable key={key} style={styles.cell} onPress={() => onSelect(key)}>
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
                      style={[styles.dayDot, { backgroundColor: ev.color || theme.primary }]}
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
            {allDay.map((ev) => (
              <Pressable
                key={ev.id}
                style={[styles.hourEvent, { backgroundColor: (ev.color || theme.primary) + "33", borderColor: ev.color || theme.primary }]}
                onPress={() => onEvent(ev)}
              >
                <Text style={styles.hourEventText} numberOfLines={1}>
                  {ev.title}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
      {Array.from({ length: 24 }, (_, h) => (
        <View key={h} style={styles.hourRow}>
          <Text style={styles.hourLabel}>{label(h)}</Text>
          <View style={styles.hourCell}>
            {(byHour[h] || []).map((ev) => (
              <Pressable
                key={ev.id}
                style={[styles.hourEvent, { backgroundColor: (ev.color || theme.primary) + "33", borderColor: ev.color || theme.primary }]}
                onPress={() => onEvent(ev)}
              >
                <Text style={styles.hourEventText} numberOfLines={1}>
                  {ev.title}
                </Text>
              </Pressable>
            ))}
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
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [startHour, setStartHour] = useState(9);
  const [durationHrs, setDurationHrs] = useState(1);
  const [color, setColor] = useState(EVENT_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Hydrate fields from the editing event (or defaults) when opened.
  useEffect(() => {
    if (!visible) return;
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

  const hour12 = (h: number) => {
    const ampm = h < 12 ? "AM" : "PM";
    const hh = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${hh}:00 ${ampm}`;
  };

  async function submit() {
    if (!title.trim()) return;
    setBusy(true);
    const day = editing ? ymd(new Date(editing.start_time)) : selectedDay;
    const start_time = allDay
      ? toISOLocal(day, 0, 0)
      : toISOLocal(day, startHour, 0);
    const end_time = allDay
      ? toISOLocal(day, 23, 59)
      : toISOLocal(day, Math.min(23, startHour + durationHrs), 0);
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
            Alert.alert("Error", e?.response?.data?.error || "Failed to delete");
          } finally {
            setDeleting(false);
          }
        },
      },
    ]);
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <ScrollView
          style={styles.modalScroll}
          contentContainerStyle={styles.modalCard}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>
              {editing ? "Edit Event" : "New Event"}
            </Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <X size={22} color={theme.textSecondary} />
            </Pressable>
          </View>

          <Text style={styles.label}>Title</Text>
          <TextInput
            style={styles.input}
            placeholder="Event title"
            placeholderTextColor={theme.textMuted}
            value={title}
            onChangeText={setTitle}
          />

          <Text style={styles.label}>Description (optional)</Text>
          <TextInput
            style={[styles.input, styles.textarea]}
            placeholder="Details"
            placeholderTextColor={theme.textMuted}
            value={description}
            onChangeText={setDescription}
            multiline
          />

          {/* All-day toggle */}
          <Pressable style={styles.toggleRow} onPress={() => setAllDay((v) => !v)}>
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
                onPress={() => setColor(c)}
              />
            ))}
          </View>

          <Pressable
            style={[styles.submit, (!title.trim() || busy) && styles.submitDisabled]}
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

          {editing ? (
            <Pressable
              style={styles.deleteBtn}
              onPress={confirmDelete}
              disabled={deleting}
            >
              <Trash2 size={16} color={theme.danger} />
              <Text style={styles.deleteText}>
                {deleting ? "Deleting..." : "Delete Event"}
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  scroll: { padding: 16, paddingBottom: 100 },
  monthHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 14,
  },
  monthLabel: { fontSize: 20, fontWeight: "800", color: theme.text, letterSpacing: -0.5 },
  monthNav: { flexDirection: "row", alignItems: "center", gap: 6 },
  viewSwitch: {
    flexDirection: "row",
    backgroundColor: theme.surface,
    borderRadius: theme.radiusSm,
    padding: 3,
    gap: 3,
    marginBottom: 14,
  },
  viewBtn: { flex: 1, paddingVertical: 8, borderRadius: 5, alignItems: "center" },
  viewBtnActive: { backgroundColor: theme.primary },
  viewText: { fontSize: 13, color: theme.textSecondary, fontWeight: "600" },
  viewTextActive: { color: "#fff" },
  weekStrip: { flexDirection: "row", gap: 4 },
  weekDayBtn: {
    flex: 1,
    alignItems: "center",
    gap: 3,
    paddingVertical: 8,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  weekDayBtnActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  weekDayName: { fontSize: 10, color: theme.textMuted, fontWeight: "600" },
  weekDayNum: { fontSize: 15, color: theme.text, fontWeight: "700" },
  weekDayActiveText: { color: "#fff" },
  weekCountDot: { width: 5, height: 5, borderRadius: 2.5 },
  weekCountSpacer: { height: 5 },
  hourly: {
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    overflow: "hidden",
  },
  hourRow: {
    flexDirection: "row",
    minHeight: 38,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  hourLabel: {
    width: 56,
    paddingTop: 6,
    paddingHorizontal: 8,
    fontSize: 11,
    color: theme.textMuted,
    textAlign: "right",
  },
  hourCell: {
    flex: 1,
    paddingVertical: 4,
    paddingHorizontal: 6,
    gap: 4,
    borderLeftWidth: 1,
    borderLeftColor: theme.border,
  },
  hourEvent: {
    borderRadius: 6,
    borderLeftWidth: 3,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  hourEventText: { fontSize: 12, color: theme.text, fontWeight: "500" },
  navBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  todayBtn: {
    paddingHorizontal: 12,
    height: 34,
    borderRadius: 8,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  todayText: { color: theme.textSecondary, fontSize: 13, fontWeight: "600" },
  weekRow: { flexDirection: "row", marginBottom: 4 },
  weekday: {
    flex: 1,
    textAlign: "center",
    fontSize: 11,
    fontWeight: "700",
    color: theme.textMuted,
  },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { width: `${100 / 7}%`, aspectRatio: 1, padding: 2 },
  cellInner: {
    flex: 1,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  cellSelected: { backgroundColor: theme.primary },
  cellToday: { backgroundColor: theme.primaryGlow },
  cellNum: { fontSize: 14, color: theme.text, fontWeight: "500" },
  cellNumMuted: { color: theme.textMuted, opacity: 0.5 },
  cellNumActive: { fontWeight: "700" },
  dots: { flexDirection: "row", gap: 2, height: 5 },
  dayDot: { width: 5, height: 5, borderRadius: 2.5 },
  dayHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 18,
    marginBottom: 10,
  },
  dayTitle: { fontSize: 15, fontWeight: "700", color: theme.text },
  emptyDay: { color: theme.textMuted, fontSize: 13, paddingVertical: 12 },
  event: {
    flexDirection: "row",
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    overflow: "hidden",
  },
  colorBar: { width: 4 },
  eventBody: { flex: 1, padding: 14, gap: 4 },
  eventTitle: { fontSize: 15, fontWeight: "600", color: theme.text },
  eventMeta: { flexDirection: "row", alignItems: "center", gap: 5 },
  eventTime: { fontSize: 12, color: theme.textSecondary },
  eventDesc: { fontSize: 12, color: theme.textMuted },
  fab: {
    position: "absolute",
    right: 20,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
    elevation: 4,
  },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  modalScroll: { maxHeight: "90%" },
  modalCard: {
    backgroundColor: theme.bgElevated,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 32,
    gap: 8,
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
    marginTop: 6,
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
  textarea: { minHeight: 70, textAlignVertical: "top" },
  hint: { fontSize: 12, color: theme.textMuted, marginTop: 4 },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
  },
  toggleLabel: { fontSize: 15, color: theme.text, fontWeight: "500" },
  toggle: {
    width: 46,
    height: 28,
    borderRadius: 14,
    backgroundColor: theme.surfaceHover,
    padding: 3,
    justifyContent: "center",
  },
  toggleOn: { backgroundColor: theme.primary },
  knob: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#fff",
    alignSelf: "flex-start",
  },
  knobOn: { alignSelf: "flex-end" },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: theme.inputBg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 8,
  },
  stepBtn: {
    width: 40,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  stepBtnText: { color: theme.primary, fontSize: 24, fontWeight: "600" },
  stepValue: { color: theme.text, fontSize: 15, fontWeight: "600" },
  colorRow: { flexDirection: "row", gap: 10, marginTop: 4 },
  swatch: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 2,
    borderColor: "transparent",
  },
  swatchActive: { borderColor: theme.text },
  submit: {
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 16,
  },
  submitDisabled: { opacity: 0.4 },
  submitText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    marginTop: 8,
  },
  deleteText: { color: theme.danger, fontSize: 14, fontWeight: "600" },
});
