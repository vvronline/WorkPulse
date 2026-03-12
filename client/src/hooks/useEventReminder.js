import { useEffect, useRef, useState } from 'react';

const REMINDER_BEFORE_MS = 10 * 60 * 1000; // 10 minutes
const AUTO_CLOSE_MS = 15 * 1000;            // auto-dismiss after 15 seconds

export function useEventReminder(events) {
    const [reminders, setReminders] = useState([]); // [{ id, event }]
    const firedRef = useRef(new Set()); // tracks event IDs already notified this session
    const timersRef = useRef([]);

    // Dismiss a single reminder
    const dismiss = (reminderId) => {
        setReminders((prev) => prev.filter((r) => r.id !== reminderId));
    };

    useEffect(() => {
        // Clear existing scheduled timers
        timersRef.current.forEach(clearTimeout);
        timersRef.current = [];

        if (!events || events.length === 0) return;

        const now = Date.now();

        events.forEach((ev) => {
            if (ev.all_day) return; // skip all-day events
            const startMs = new Date(ev.start_time).getTime();
            const reminderMs = startMs - REMINDER_BEFORE_MS;
            const delay = reminderMs - now;

            // Already fired this session, or the reminder window is already more than 1 min past
            if (firedRef.current.has(ev.id)) return;
            if (delay < -60000) return; // more than 1 min ago — skip silently

            // If we're within 10 min but not yet past, fire now (e.g. page load mid-window)
            const fireDelay = Math.max(0, delay);

            const timer = setTimeout(() => {
                if (firedRef.current.has(ev.id)) return;
                firedRef.current.add(ev.id);

                const reminderId = `${ev.id}-${Date.now()}`;
                setReminders((prev) => [...prev, { id: reminderId, event: ev }]);

                // Auto-close after 15s
                const autoClose = setTimeout(() => {
                    setReminders((prev) => prev.filter((r) => r.id !== reminderId));
                }, AUTO_CLOSE_MS);
                timersRef.current.push(autoClose);
            }, fireDelay);

            timersRef.current.push(timer);
        });

        return () => {
            timersRef.current.forEach(clearTimeout);
            timersRef.current = [];
        };
    }, [events]);

    return { reminders, dismiss };
}
