// Convert a UTC timestamp string (SQLite or ISO format) to local HH:MM
export function tsToLocalTime(ts) {
    if (!ts) return '--:--';
    // If already ISO format (has 'T'), use as-is; otherwise convert SQLite space format
    const normalized = ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z';
    const d = new Date(normalized);
    if (isNaN(d.getTime())) return '--:--';
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

// Parse raw time_entries into form fields: clockIn, clockOut, breaks, workMode
export function parseEntries(entries) {
    const clockInEntry = entries.find(e => e.entry_type === 'clock_in');
    const clockOutEntry = entries.find(e => e.entry_type === 'clock_out');
    const breakStarts = entries.filter(e => e.entry_type === 'break_start');
    const breakEnds = entries.filter(e => e.entry_type === 'break_end');

    const parsedBreaks = breakStarts.map((bs, i) => ({
        start: tsToLocalTime(bs.timestamp),
        end: breakEnds[i] ? tsToLocalTime(breakEnds[i].timestamp) : '',
    }));

    return {
        clockIn: clockInEntry ? tsToLocalTime(clockInEntry.timestamp) : '09:00',
        clockOut: clockOutEntry ? tsToLocalTime(clockOutEntry.timestamp) : '',
        skipClockOut: !clockOutEntry,
        breaks: parsedBreaks.length > 0 ? parsedBreaks : [{ start: '', end: '' }],
        workMode: clockInEntry?.work_mode || 'office',
    };
}

export const entryTypeLabels = {
    clock_in: 'Logged In',
    break_start: 'Break Started',
    break_end: 'Break Ended',
    clock_out: 'Logged Out',
};

export const entryTypeIcons = {
    clock_in: '🟢',
    break_start: '🟡',
    break_end: '🔵',
    clock_out: '🔴',
};
