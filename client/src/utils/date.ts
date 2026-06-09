/**
 * Formats a YYYY-MM-DD date string as a short readable date.
 * @example fmtDate('2026-01-15') → "Wed, Jan 15"
 */
export function fmtDate(str: string): string {
    return new Date(str + "T00:00:00").toLocaleDateString("en-US", {
        weekday: "short", month: "short", day: "numeric",
    });
}

/**
 * Formats a Date object or ISO string as a short time string.
 * @example fmtTime(new Date()) → "09:30 AM"
 */
export function fmtTime(dateOrStr: Date | string | number): string {
    return new Date(dateOrStr).toLocaleTimeString([], {
        hour: "2-digit", minute: "2-digit",
    });
}

/**
 * Generates all YYYY-MM-DD date strings between from and to (inclusive),
 * optionally skipping Saturday and Sunday.
 */
export function getDateRange(from: string, to: string, skipWeekends = true): string[] {
    const dates: string[] = [];
    const end = new Date(to + "T00:00:00");
    for (let d = new Date(from + "T00:00:00"); d <= end; d.setDate(d.getDate() + 1)) {
        const dow = d.getDay();
        if (skipWeekends && (dow === 0 || dow === 6)) continue;
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        dates.push(`${yyyy}-${mm}-${dd}`);
    }
    return dates;
}