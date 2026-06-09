import { useEffect, useRef, useState } from "react";
import type { CalendarEvent } from "../types";

const REMINDER_SCHEDULE = [
    { offsetMs: 10 * 60 * 1000, label: "~10 min" }, // 10 min before
    { offsetMs: 5 * 60 * 1000, label: "~5 min" }, //  5 min before
    { offsetMs: 2 * 60 * 1000, label: "~2 min" }, //  2 min before
];
const AUTO_CLOSE_MS = 15 * 1000;

interface Reminder {
    id: string;
    event: CalendarEvent;
    timeLabel: string;
}

export function useEventReminder(events: CalendarEvent[] | null | undefined) {
    const [reminders, setReminders] = useState<Reminder[]>([]);
    const firedRef = useRef<Set<string>>(new Set()); // tracks "eventId-offsetMs" keys
    const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

    const dismiss = (reminderId: string) => {
        setReminders((prev) => prev.filter((r) => r.id !== reminderId));
    };

    useEffect(() => {
        timersRef.current.forEach(clearTimeout);
        timersRef.current = [];

        if (!events || events.length === 0) return;

        const now = Date.now();

        events.forEach((ev) => {
            if (ev.all_day) return;
            const startMs = new Date(ev.start_time as string).getTime();

            REMINDER_SCHEDULE.forEach(({ offsetMs, label }) => {
                const fireKey = `${ev.id}-${offsetMs}`;
                if (firedRef.current.has(fireKey)) return;

                const reminderMs = startMs - offsetMs;
                const delay = reminderMs - now;

                // Skip if the reminder window is already more than 1 min past
                if (delay < -60000) return;

                const fireDelay = Math.max(0, delay);

                const timer = setTimeout(() => {
                    if (firedRef.current.has(fireKey)) return;
                    firedRef.current.add(fireKey);

                    const reminderId = `${ev.id}-${offsetMs}-${Date.now()}`;
                    setReminders((prev) => [
                        ...prev,
                        { id: reminderId, event: ev, timeLabel: label },
                    ]);

                    const autoClose = setTimeout(() => {
                        setReminders((prev) =>
                            prev.filter((r) => r.id !== reminderId),
                        );
                    }, AUTO_CLOSE_MS);
                    timersRef.current.push(autoClose);
                }, fireDelay);

                timersRef.current.push(timer);
            });
        });

        return () => {
            timersRef.current.forEach(clearTimeout);
            timersRef.current = [];
        };
    }, [events]);

    return { reminders, dismiss };
}