import React, { useState, useEffect, useRef } from "react";
import { AlertTriangle, Video, X } from "lucide-react";
import { searchChatUsers, getMeeting, checkMeetingConflicts } from "../../api";
import { useFeatures } from "../../FeaturesContext";
import s from "./Calendar.module.css";

export interface CalendarForm {
    title: string;
    description: string;
    start_time: string;
    end_time: string;
    all_day: boolean;
    color: string;
    task_id: string | number;
    schedule_mode: string;
    weekdays: number[];
}

interface ParticipantUser {
    id: number | string;
    name?: string;
    full_name?: string;
    username?: string;
    email?: string;
    [key: string]: unknown;
}

interface ConflictEvent {
    title?: string;
    [key: string]: unknown;
}

interface ConflictEntry {
    name: string;
    events: ConflictEvent[];
}

type ConflictMap = Record<string | number, ConflictEntry>;

interface MeetingSettings {
    muteOnJoin: boolean;
    allowScreenShare: boolean;
}

export interface MeetingOptions {
    required: ParticipantUser[];
    optional: ParticipantUser[];
    settings: MeetingSettings;
}

interface TimeOption {
    value: string;
    label: string;
}

function pad(n: number): string { return String(n).padStart(2, "0"); }

const TIME_OPTIONS: TimeOption[] = [];
const WEEKDAY_OPTIONS = [
    { value: 0, label: "Mon" },
    { value: 1, label: "Tue" },
    { value: 2, label: "Wed" },
    { value: 3, label: "Thu" },
    { value: 4, label: "Fri" },
    { value: 5, label: "Sat" },
    { value: 6, label: "Sun" },
];
for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) {
        const ampm = h < 12 ? "AM" : "PM";
        const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
        TIME_OPTIONS.push({ value: `${pad(h)}:${pad(m)}`, label: `${h12}:${pad(m)} ${ampm}` });
    }
}

function getDatePart(iso: string): string { return iso ? iso.slice(0, 10) : ""; }
function getTimePart(iso: string): string { return iso ? iso.slice(11, 16) : ""; }
function combineDatetime(date: string, time: string): string { return date && time ? `${date}T${time}` : ""; }
function toMonDayIndex(iso: string): number {
    if (!iso) return 0;
    return (new Date(iso).getDay() + 6) % 7;
}
function isPastLocalSlot(datePart: string, timePart: string, nowMin: string): boolean {
    if (!datePart || !timePart || !nowMin) return false;
    return `${datePart}T${timePart}` < nowMin;
}
function getFirstValidEndTime({
    datePart,
    startDatePart,
    startTimePart,
    nowMin,
    isCreating,
    preferredTimePart,
}: {
    datePart: string;
    startDatePart: string;
    startTimePart: string;
    nowMin: string;
    isCreating: boolean;
    preferredTimePart?: string;
}): string {
    const options = getTimeOptions(preferredTimePart || "00:00");
    const nowDatePart = getDatePart(nowMin);
    const nowTimePart = getTimePart(nowMin);
    const first = options.find(o => {
        if (isCreating && datePart === nowDatePart && o.value < nowTimePart) return false;
        if (datePart === startDatePart && o.value <= startTimePart) return false;
        return true;
    });
    return first?.value || preferredTimePart || "23:59";
}
function getTimeOptions(timePart: string): TimeOption[] {
    if (!timePart) return TIME_OPTIONS;
    const [, m] = timePart.split(":").map(Number);
    if (m % 15 === 0) return TIME_OPTIONS;
    const [h2] = timePart.split(":").map(Number);
    const ampm = h2 < 12 ? "AM" : "PM";
    const h12 = h2 === 0 ? 12 : h2 > 12 ? h2 - 12 : h2;
    const extra: TimeOption = { value: timePart, label: `${h12}:${pad(m)} ${ampm}` };
    return [...TIME_OPTIONS.filter(o => o.value < timePart), extra, ...TIME_OPTIONS.filter(o => o.value > timePart)];
}

interface MeetingParticipantPickerProps {
    participants: ParticipantUser[];
    excludeIds?: (number | string)[];
    onChange: (next: ParticipantUser[]) => void;
    conflicts?: ConflictMap;
}

function MeetingParticipantPicker({ participants, excludeIds = [], onChange, conflicts = {} }: MeetingParticipantPickerProps) {
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<ParticipantUser[]>([]);
    const [loading, setLoading] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const allExcluded = new Set<number | string>([...participants.map(p => p.id), ...excludeIds]);

    useEffect(() => {
        if (query.trim().length < 2) { setResults([]); return; }
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(async () => {
            setLoading(true);
            try {
                const r = await searchChatUsers(query.trim());
                setResults(((r.data as ParticipantUser[]) || []).filter(u => !allExcluded.has(u.id)));
            } catch { setResults([]); }
            finally { setLoading(false); }
        }, 300);
        return () => { if (timerRef.current) clearTimeout(timerRef.current); };
    }, [query, participants, excludeIds]);

    const add = (user: ParticipantUser) => {
        onChange([...participants, user]);
        setQuery("");
        setResults([]);
    };
    const remove = (id: number | string) => onChange(participants.filter(p => p.id !== id));

    return (
        <div className={s.participantPicker}>
            <div className={s.participantChips}>
                {participants.map(p => {
                    const hasConflict = !!conflicts[p.id];
                    const conflictEvt = hasConflict ? conflicts[p.id].events[0] : null;
                    return (
                        <span
                            key={p.id}
                            className={`${s.participantChip} ${hasConflict ? s.participantChipConflict : ""}`}
                            title={hasConflict ? `Conflicts with "${conflictEvt?.title}"` : undefined}
                        >
                            {hasConflict && <span className={s.conflictChipIcon} aria-label="conflict"><AlertTriangle size={12} /></span>}
                            {p.name || p.full_name || p.username}
                            <button type="button" onClick={() => remove(p.id)} aria-label="Remove"><X size={12} /></button>
                        </span>
                    );
                })}
            </div>
            <div className={s.participantSearch}>
                <input
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder="Search people to invite…"
                    className={s.participantInput}
                />
                {loading && <span className={s.participantLoading}>…</span>}
                {results.length > 0 && (
                    <ul className={s.participantResults}>
                        {results.map(u => (
                            <li key={u.id} onClick={() => add(u)}>
                                {u.name || u.full_name || u.username}
                                {u.email && <span className={s.participantEmail}> — {u.email}</span>}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}

interface EventFormModalProps {
    modal: string | number | null;
    form: CalendarForm;
    setForm: React.Dispatch<React.SetStateAction<CalendarForm>>;
    nowMin: string;
    tasks: Array<{ id: number | string; title: string;[key: string]: unknown }>;
    onSave: (meetingOptions: MeetingOptions | null) => void;
    onDelete: () => void;
    onClose: () => void;
    onStartChange: (val: string) => void;
    existingMeetingCode?: string | null;
    isOrganizer?: boolean;
}

/**
 * Modal for creating or editing a calendar event.
 */
export default function EventFormModal({ modal, form, setForm, nowMin, tasks, onSave, onDelete, onClose, onStartChange, existingMeetingCode, isOrganizer = true }: EventFormModalProps) {
    const { hasFeature } = useFeatures();
    const [addMeeting, setAddMeeting] = useState(false);
    const [requiredParticipants, setRequiredParticipants] = useState<ParticipantUser[]>([]);
    const [optionalParticipants, setOptionalParticipants] = useState<ParticipantUser[]>([]);
    const [meetingSettings, setMeetingSettings] = useState<MeetingSettings>({ muteOnJoin: false, allowScreenShare: true });
    const [meetingInfo, setMeetingInfo] = useState<Record<string, unknown> | null>(null);
    const [conflicts, setConflicts] = useState<ConflictMap>({});
    const conflictTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Reset meeting state when modal opens/closes
    useEffect(() => {
        if (modal === null) {
            setAddMeeting(false);
            setRequiredParticipants([]);
            setOptionalParticipants([]);
            setMeetingSettings({ muteOnJoin: false, allowScreenShare: true });
            setMeetingInfo(null);
            setConflicts({});
        }
    }, [modal]);

    // Debounce conflict check when participants or times change
    useEffect(() => {
        if (!addMeeting || modal !== "create") return;
        const allParticipants = [...requiredParticipants, ...optionalParticipants];
        if (!allParticipants.length || !form.start_time || !form.end_time) {
            setConflicts({});
            return;
        }
        if (conflictTimerRef.current) clearTimeout(conflictTimerRef.current);
        conflictTimerRef.current = setTimeout(async () => {
            try {
                const r = await checkMeetingConflicts({
                    user_ids: allParticipants.map(p => p.id),
                    start_time: new Date(form.start_time).toISOString(),
                    end_time: new Date(form.end_time).toISOString(),
                });
                const data = r.data as { conflicts?: Array<{ userId: number | string; name: string; events: ConflictEvent[] }> };
                const map: ConflictMap = {};
                for (const c of (data.conflicts || [])) {
                    map[c.userId] = { name: c.name, events: c.events };
                }
                setConflicts(map);
            } catch { setConflicts({}); }
        }, 500);
        return () => { if (conflictTimerRef.current) clearTimeout(conflictTimerRef.current); };
    }, [requiredParticipants, optionalParticipants, form.start_time, form.end_time, addMeeting, modal]);

    // Fetch meeting participants when viewing an existing meeting event
    useEffect(() => {
        if (modal !== null && modal !== "create" && existingMeetingCode) {
            getMeeting(existingMeetingCode)
                .then(r => setMeetingInfo(r.data as Record<string, unknown>))
                .catch(() => {});
        }
    }, [modal, existingMeetingCode]);

    useEffect(() => {
        if (modal !== "create" || !form.start_time) return;
        const currentDays = Array.isArray(form.weekdays) ? form.weekdays : [];
        if (form.schedule_mode === "multi" && currentDays.length > 0) return;
        const startDay = toMonDayIndex(form.start_time);
        if (form.schedule_mode === "single" && currentDays.length === 1 && currentDays[0] === startDay) return;
        setForm(prev => ({
            ...prev,
            schedule_mode: prev.schedule_mode || "single",
            weekdays: [startDay],
        }));
    }, [modal, form.start_time, form.schedule_mode, form.weekdays, setForm]);

    if (modal === null) return null;

    const isEditing = modal !== "create";
    const hasMeeting = isEditing && !!existingMeetingCode;
    const isCreating = modal === "create";
    const readOnly = isEditing && hasMeeting && !isOrganizer;
    const nowDatePart = getDatePart(nowMin);
    const nowTimePart = getTimePart(nowMin);
    const startDatePart = getDatePart(form.start_time);
    const startTimePart = getTimePart(form.start_time);
    const endDatePart = getDatePart(form.end_time);
    const endTimePart = getTimePart(form.end_time);

    const meetingParticipants = (meetingInfo?.participants as Array<Record<string, unknown>> | undefined) || [];

    const handleSave = () => {
        if (addMeeting && !isEditing) {
            onSave({ required: requiredParticipants, optional: optionalParticipants, settings: meetingSettings });
        } else {
            onSave(null);
        }
    };

    return (
        <div className={s.modalOverlay} onClick={onClose}>
            <div className={s.modal} onClick={e => e.stopPropagation()}>
                <div className={s.modalHeader}>
                    <div>
                        <h3>{modal === "create" ? "New Event" : readOnly ? "Event Details" : "Edit Event"}</h3>
                        <p className={s.modalSubtitle}>
                            {modal === "create" ? "Capture the details and keep your schedule in sync."
                                : readOnly ? "Only the meeting organizer can edit or cancel this event."
                                    : "Update details for this scheduled item."}
                        </p>
                    </div>
                    <button
                        type="button"
                        className={s.modalCloseBtn}
                        onClick={onClose}
                        aria-label="Close event form"
                    >
                        <X size={16} />
                    </button>
                </div>

                <div className={s.formGroup}>
                    <label>Title</label>
                    <input
                        value={form.title}
                        onChange={e => setForm({ ...form, title: e.target.value })}
                        placeholder="Event title"
                        autoFocus
                        disabled={readOnly}
                    />
                </div>

                <div className={s.formGroup}>
                    <label>Description</label>
                    <textarea
                        value={form.description}
                        onChange={e => setForm({ ...form, description: e.target.value })}
                        placeholder="Optional description"
                        rows={2}
                        disabled={readOnly}
                    />
                </div>

                <div className={s.formRow}>
                    <div className={s.formGroup}>
                        <label>Start</label>
                        <div className={s.datetimePicker}>
                            <input
                                type="date"
                                value={startDatePart}
                                min={modal === "create" ? getDatePart(nowMin) : undefined}
                                onChange={e => {
                                    const nextDate = e.target.value;
                                    const currentTime = getTimePart(form.start_time) || "00:00";
                                    const nextTime = isCreating && isPastLocalSlot(nextDate, currentTime, nowMin)
                                        ? getFirstValidEndTime({
                                            datePart: nextDate,
                                            startDatePart: nextDate,
                                            startTimePart: nowTimePart,
                                            nowMin,
                                            isCreating,
                                            preferredTimePart: currentTime,
                                        })
                                        : currentTime;
                                    onStartChange(combineDatetime(nextDate, nextTime));
                                }}
                            />
                            {(!form.all_day || addMeeting) && (
                                <select
                                    value={startTimePart}
                                    onChange={e => onStartChange(combineDatetime(startDatePart, e.target.value))}
                                >
                                    {getTimeOptions(startTimePart).map(o => (
                                        <option
                                            key={o.value}
                                            value={o.value}
                                            disabled={isCreating && startDatePart === nowDatePart && o.value < nowTimePart}
                                        >
                                            {o.label}
                                        </option>
                                    ))}
                                </select>
                            )}
                        </div>
                    </div>

                    <div className={s.formGroup}>
                        <label>End</label>
                        <div className={s.datetimePicker}>
                            <input
                                type="date"
                                value={endDatePart}
                                min={startDatePart}
                                onChange={e => {
                                    const nextDate = e.target.value;
                                    const nextTime = getFirstValidEndTime({
                                        datePart: nextDate,
                                        startDatePart,
                                        startTimePart,
                                        nowMin,
                                        isCreating,
                                        preferredTimePart: endTimePart,
                                    });
                                    setForm({ ...form, end_time: combineDatetime(nextDate, nextTime) });
                                }}
                            />
                            {(!form.all_day || addMeeting) && (
                                <select
                                    value={endTimePart}
                                    onChange={e => setForm({ ...form, end_time: combineDatetime(endDatePart, e.target.value) })}
                                >
                                    {getTimeOptions(endTimePart).map(o => (
                                        <option
                                            key={o.value}
                                            value={o.value}
                                            disabled={
                                                (isCreating && endDatePart === nowDatePart && o.value < nowTimePart) ||
                                                (endDatePart === startDatePart && o.value <= startTimePart)
                                            }
                                        >
                                            {o.label}
                                        </option>
                                    ))}
                                </select>
                            )}
                        </div>
                    </div>
                </div>

                <div className={s.formRow}>
                    <label className={s.checkbox} title={addMeeting ? "Meetings require specific times" : undefined}>
                        <input
                            type="checkbox"
                            checked={form.all_day}
                            disabled={addMeeting}
                            onChange={e => setForm({ ...form, all_day: e.target.checked })}
                        />
                        All day {addMeeting && <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>(disabled for meetings)</span>}
                    </label>
                </div>

                {isCreating && (
                    <div className={s.formGroup}>
                        <label>Schedule</label>
                        <div className={s.scheduleModeRow}>
                            <button
                                type="button"
                                className={`${s.scheduleModeBtn} ${form.schedule_mode !== "multi" ? s.scheduleModeBtnActive : ""}`}
                                onClick={() => setForm({ ...form, schedule_mode: "single", weekdays: [toMonDayIndex(form.start_time)] })}
                            >
                                Single day
                            </button>
                            <button
                                type="button"
                                className={`${s.scheduleModeBtn} ${form.schedule_mode === "multi" ? s.scheduleModeBtnActive : ""}`}
                                onClick={() => setForm({ ...form, schedule_mode: "multi", weekdays: (form.weekdays?.length ? form.weekdays : [toMonDayIndex(form.start_time)]) })}
                            >
                                Custom days this week
                            </button>
                        </div>

                        {form.schedule_mode === "multi" && (
                            <div className={s.weekdayPicker}>
                                {WEEKDAY_OPTIONS.map(day => {
                                    const selected = (form.weekdays || []).includes(day.value);
                                    return (
                                        <button
                                            type="button"
                                            key={day.value}
                                            className={`${s.weekdayBtn} ${selected ? s.weekdayBtnActive : ""}`}
                                            onClick={() => {
                                                const current = Array.isArray(form.weekdays) ? form.weekdays : [];
                                                if (selected && current.length === 1) return;
                                                const next = selected
                                                    ? current.filter(d => d !== day.value)
                                                    : [...current, day.value].sort((a, b) => a - b);
                                                setForm({ ...form, weekdays: next });
                                            }}
                                        >
                                            {day.label}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}

                {tasks.length > 0 && (
                    <div className={s.formGroup}>
                        <label>Link to Task</label>
                        <select value={form.task_id} onChange={e => setForm({ ...form, task_id: e.target.value })}>
                            <option value="">None</option>
                            {tasks.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
                        </select>
                    </div>
                )}

                {/* Meeting section — only available when meetings feature is enabled */}
                {hasFeature("meetings") && (hasMeeting ? (
                    <div className={s.meetingBanner}>
                        <span className={s.meetingIcon}><Video size={16} /></span>
                        <span>Online meeting</span>
                        <a
                            href={`${window.location.origin}/meeting/${existingMeetingCode}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={s.meetingLink}
                        >
                            {`${window.location.origin}/meeting/${existingMeetingCode}`}
                        </a>
                        <a
                            href={`/meeting/${existingMeetingCode}`}
                            className={s.joinMeetingBtn}
                            onClick={e => { e.preventDefault(); onClose(); window.location.href = `/meeting/${existingMeetingCode}`; }}
                        >
                            Join
                        </a>
                        {meetingParticipants.length > 0 && (
                            <div className={s.meetingParticipantList}>
                                <div className={s.meetingParticipantGroup}>
                                    <span className={s.meetingParticipantGroupLabel}>Required</span>
                                    {meetingParticipants
                                        .filter(p => p.role === "organizer" || p.participant_type === "required")
                                        .map(p => (
                                            <span key={String(p.user_id)} className={s.meetingParticipantBadge}>
                                                {String(p.full_name || p.username)}
                                                {p.role === "organizer" && <span className={s.organizerTag}> (organizer)</span>}
                                            </span>
                                        ))}
                                </div>
                                {meetingParticipants.some(p => p.participant_type === "optional") && (
                                    <div className={s.meetingParticipantGroup}>
                                        <span className={s.meetingParticipantGroupLabel}>Optional</span>
                                        {meetingParticipants
                                            .filter(p => p.participant_type === "optional")
                                            .map(p => (
                                                <span key={String(p.user_id)} className={s.meetingParticipantBadge + " " + s.meetingParticipantOptional}>
                                                    {String(p.full_name || p.username)}
                                                </span>
                                            ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                ) : modal === "create" && (
                    <div className={s.meetingToggleRow}>
                        <label className={s.toggleLabel}>
                            <span className={s.meetingIcon}><Video size={16} /></span>
                            Add online meeting
                        </label>
                        <button
                            type="button"
                            className={`${s.toggleSwitch} ${addMeeting ? s.toggleSwitchOn : ""}`}
                            onClick={() => {
                                const next = !addMeeting;
                                setAddMeeting(next);
                                // Meetings need specific times — turn off all-day when enabling meeting
                                if (next && form.all_day) {
                                    const startDate = getDatePart(form.start_time) || getDatePart(nowMin);
                                    const now = new Date();
                                    const h = now.getHours();
                                    const m = Math.ceil(now.getMinutes() / 15) * 15;
                                    const startTime = `${pad(m >= 60 ? h + 1 : h)}:${pad(m % 60)}`;
                                    const endH = m >= 60 ? h + 2 : h + 1;
                                    const endTime = `${pad(endH)}:${pad(m % 60)}`;
                                    const start = combineDatetime(startDate, startTime);
                                    const end = combineDatetime(startDate, endTime);
                                    setForm(prev => ({ ...prev, all_day: false, start_time: start, end_time: end }));
                                }
                            }}
                            aria-pressed={addMeeting}
                        >
                            <span className={s.toggleThumb} />
                        </button>
                    </div>
                ))}

                {hasFeature("meetings") && modal === "create" && addMeeting && (
                    <div className={s.meetingOptions}>
                        <div className={s.formGroup}>
                            <label>Required participants</label>
                            <MeetingParticipantPicker
                                participants={requiredParticipants}
                                excludeIds={optionalParticipants.map(p => p.id)}
                                onChange={setRequiredParticipants}
                                conflicts={conflicts}
                            />
                        </div>
                        <div className={s.formGroup}>
                            <label>Optional participants</label>
                            <MeetingParticipantPicker
                                participants={optionalParticipants}
                                excludeIds={requiredParticipants.map(p => p.id)}
                                onChange={setOptionalParticipants}
                                conflicts={conflicts}
                            />
                        </div>
                        {Object.keys(conflicts).length > 0 && (
                            <div className={s.conflictWarning} role="alert">
                                <span className={s.conflictWarningIcon}><AlertTriangle size={16} /></span>
                                <div>
                                    {Object.values(conflicts).map((c, i) => (
                                        <div key={i}>
                                            <strong>{c.name}</strong> has a scheduling conflict: &quot;{c.events[0]?.title}&quot;
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                        <div className={s.meetingSettingsRow}>
                            <label className={s.checkbox}>
                                <input
                                    type="checkbox"
                                    checked={meetingSettings.muteOnJoin}
                                    onChange={e => setMeetingSettings(p => ({ ...p, muteOnJoin: e.target.checked }))}
                                />
                                Mute participants on join
                            </label>
                            <label className={s.checkbox}>
                                <input
                                    type="checkbox"
                                    checked={meetingSettings.allowScreenShare}
                                    onChange={e => setMeetingSettings(p => ({ ...p, allowScreenShare: e.target.checked }))}
                                />
                                Allow screen sharing
                            </label>
                        </div>
                    </div>
                )}

                <div className={s.formActions}>
                    {modal !== "create" && isOrganizer && (
                        <button className={s.deleteBtn} onClick={onDelete}>{hasMeeting ? "Cancel Event" : "Delete"}</button>
                    )}
                    <div className={s.formActionsRight}>
                        <button className={s.cancelBtn} onClick={onClose}>Close</button>
                        {isOrganizer && <button className={s.saveBtn} onClick={handleSave}>Save</button>}
                    </div>
                </div>
            </div>
        </div>
    );
}