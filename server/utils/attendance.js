const { computeFloorMs, computeBreakMs } = require('./timeCalc');

async function calculateAttendance(db, userId, orgId, startDate, endDate, timezoneOffset = 0) {
    const orgRow = (await db.query(
        `SELECT work_days, work_hours_per_day, min_hours_present FROM organizations WHERE id = $1`,
        [orgId]
    )).rows[0] || {};
    const workDaySet = new Set(
        (orgRow.work_days || '1,2,3,4,5')
            .split(',').map(n => parseInt(n.trim(), 10)).filter(n => !isNaN(n))
    );
    const workHpd = orgRow.work_hours_per_day || 8;
    const minHoursPresent = (orgRow.min_hours_present != null && Number(orgRow.min_hours_present) >= 0)
        ? Number(orgRow.min_hours_present)
        : workHpd / 2;

    const holidaySet = new Set(
        (await db.query(
            `SELECT date FROM holidays
             WHERE org_id = $1 AND date BETWEEN $2 AND $3 AND is_optional = FALSE`,
            [orgId, startDate, endDate]
        )).rows.map(h => h.date)
    );

    const memberInterval = `${-timezoneOffset} minutes`;

    const entries = (await db.query(
        `SELECT * FROM time_entries
         WHERE user_id = $1 AND approval_status = 'approved'
           AND (timestamp + $4::interval)::date BETWEEN $2::date AND $3::date
         ORDER BY timestamp ASC`,
        [userId, startDate, endDate, memberInterval]
    )).rows;

    const byDate = {};
    for (const e of entries) {
        const localDate = new Date(new Date(e.timestamp).getTime() - timezoneOffset * 60000)
            .toISOString().slice(0, 10);
        (byDate[localDate] ??= []).push(e);
    }

    const leaveMap = {};
    for (const l of (await db.query(
        `SELECT date, leave_type, duration FROM leaves
         WHERE user_id = $1 AND status = 'approved' AND date BETWEEN $2 AND $3`,
        [userId, startDate, endDate]
    )).rows) {
        leaveMap[l.date] = l;
    }

    const allDays = [];
    const dt = new Date(startDate + 'T00:00:00Z');
    const dtEnd = new Date(endDate + 'T00:00:00Z');
    while (dt <= dtEnd) {
        allDays.push(dt.toISOString().slice(0, 10));
        dt.setUTCDate(dt.getUTCDate() + 1);
    }

    let scheduledDays = 0, daysWorked = 0;
    let totalLeaveDays = 0, leaveEquivForAbsent = 0;
    let totalHours = 0, regularHours = 0, overtimeHours = 0;
    const minPresentMs = minHoursPresent * 3_600_000;

    for (const date of allDays) {
        const dow = new Date(date + 'T00:00:00Z').getUTCDay();
        const isWorkDay = workDaySet.has(dow);
        const isHoliday = holidaySet.has(date);
        const leave = leaveMap[date];
        const dayEntries = byDate[date] || [];
        const hasWork = dayEntries.length > 0;
        const floorMs = hasWork ? computeFloorMs(dayEntries) : 0;
        const meetsMinHours = floorMs >= minPresentMs;

        if (!isWorkDay) {
            if (!hasWork) continue;
        } else if (isHoliday) {
            if (!hasWork) continue;
        } else {
            scheduledDays++;
            if (meetsMinHours) daysWorked++;

            if (leave) {
                const durFrac = leave.duration === 'quarter' ? 0.25
                    : leave.duration === 'half' ? 0.5 : 1;
                totalLeaveDays += durFrac;
                if (leave.duration === 'full') {
                    leaveEquivForAbsent += 1;
                } else if (!meetsMinHours) {
                    leaveEquivForAbsent += durFrac;
                }
            }
        }

        if (hasWork) {
            const dayTotal = floorMs / 3_600_000;
            if (!isWorkDay || isHoliday) {
                overtimeHours += dayTotal;
            } else {
                regularHours += Math.min(dayTotal, workHpd);
                overtimeHours += Math.max(0, dayTotal - workHpd);
            }
            totalHours += dayTotal;
        }
    }

    const daysAbsent = Math.max(0, scheduledDays - daysWorked - leaveEquivForAbsent);

    return {
        scheduledDays,
        daysWorked,
        daysAbsent: parseFloat(daysAbsent.toFixed(2)),
        leaveDays: parseFloat(totalLeaveDays.toFixed(2)),
        totalHours: parseFloat(totalHours.toFixed(2)),
        regularHours: parseFloat(regularHours.toFixed(2)),
        overtimeHours: parseFloat(overtimeHours.toFixed(2)),
        workHoursPerDay: workHpd,
    };
}

module.exports = { calculateAttendance };
