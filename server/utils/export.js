/**
 * CSV & PDF export helpers for analytics/leave/task data.
 */
const { Parser } = require('json2csv');
const PDFDocument = require('pdfkit');

/** Sanitize a cell value to prevent CSV formula injection. */
function sanitizeCell(val) {
    if (typeof val !== 'string') return val;
    if (/^[=+\-@\t\r]/.test(val)) return `'${val}`;
    return val;
}

/** Sanitize a filename for use in Content-Disposition header. */
function sanitizeFilename(name) {
    return String(name).replace(/[^a-zA-Z0-9._\-]/g, '_');
}

/**
 * Stream a CSV response.
 */
function sendCSV(res, data, fields, filename) {
    const safeData = data.map(row => {
        const out = {};
        for (const key of Object.keys(row)) out[key] = sanitizeCell(row[key]);
        return out;
    });
    const parser = new Parser({ fields });
    const csv = parser.parse(safeData);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(filename)}"`);
    res.send(csv);
}

/**
 * Stream a PDF table response.
 * columns: [{ header, key, width }]
 */
function sendPDF(res, { title, columns, rows, filename }) {
    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: rows.length > 0 && columns.length > 6 ? 'landscape' : 'portrait' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(filename)}"`);
    doc.pipe(res);

    // Title
    doc.fontSize(18).font('Helvetica-Bold').text(title, { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(9).font('Helvetica').text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
    doc.moveDown(1);

    if (rows.length === 0) {
        doc.fontSize(12).text('No data available.', { align: 'center' });
        doc.end();
        return;
    }

    // Table layout
    const tableLeft = doc.page.margins.left;
    const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // Calculate column widths: use explicit widths if provided, else distribute evenly
    const totalExplicit = columns.reduce((sum, c) => sum + (c.width || 0), 0);
    const colWidths = totalExplicit > 0
        ? columns.map(c => c.width || Math.floor(usableWidth / columns.length))
        : columns.map(() => Math.floor(usableWidth / columns.length));

    // Scale widths to fit usable area
    const rawTotal = colWidths.reduce((s, w) => s + w, 0);
    if (rawTotal !== usableWidth) {
        const scale = usableWidth / rawTotal;
        for (let i = 0; i < colWidths.length; i++) colWidths[i] = Math.floor(colWidths[i] * scale);
    }

    const cellPadding = 4;
    const rowSpacing = 6;

    // Helper: draw a row and return the height consumed
    function drawRow(y, values, font, fontSize, options = {}) {
        doc.font(font).fontSize(fontSize);
        // First pass: measure heights
        const heights = values.map((val, i) => {
            return doc.heightOfString(val, { width: colWidths[i] - cellPadding * 2 });
        });
        const rowHeight = Math.max(...heights) + cellPadding * 2;

        // Draw background stripe if requested
        if (options.bg) {
            doc.save().rect(tableLeft, y, usableWidth, rowHeight).fill(options.bg).restore();
            doc.font(font).fontSize(fontSize); // restore after fill
        }

        // Second pass: render text centered vertically in the row
        let x = tableLeft;
        values.forEach((val, i) => {
            const textY = y + cellPadding;
            doc.fillColor(options.textColor || '#333333')
                .text(val, x + cellPadding, textY, { width: colWidths[i] - cellPadding * 2 });
            x += colWidths[i];
        });

        return rowHeight;
    }

    // Header row
    const headerValues = columns.map(c => c.header);
    const headerHeight = drawRow(doc.y, headerValues, 'Helvetica-Bold', 8, { bg: '#f0f0f0', textColor: '#444444' });
    doc.y += headerHeight;

    // Divider line
    doc.moveTo(tableLeft, doc.y).lineTo(tableLeft + usableWidth, doc.y).lineWidth(0.5).stroke('#cccccc');
    doc.y += 2;

    // Data rows
    rows.forEach((row, idx) => {
        const values = columns.map(col => row[col.key] != null ? String(row[col.key]) : '');

        // Measure to check if we need a page break
        doc.font('Helvetica').fontSize(7);
        const heights = values.map((val, i) =>
            doc.heightOfString(val, { width: colWidths[i] - cellPadding * 2 })
        );
        const neededHeight = Math.max(...heights) + cellPadding * 2 + rowSpacing;

        if (doc.y + neededHeight > doc.page.height - doc.page.margins.bottom) {
            doc.addPage();
            // Re-render header on new page
            const hh = drawRow(doc.y, headerValues, 'Helvetica-Bold', 8, { bg: '#f0f0f0', textColor: '#444444' });
            doc.y += hh;
            doc.moveTo(tableLeft, doc.y).lineTo(tableLeft + usableWidth, doc.y).lineWidth(0.5).stroke('#cccccc');
            doc.y += 2;
        }

        const bg = idx % 2 === 1 ? '#f9f9f9' : undefined;
        const rh = drawRow(doc.y, values, 'Helvetica', 7, { bg, textColor: '#333333' });
        doc.y += rh + rowSpacing;
    });

    doc.end();
}

/**
 * Send a structured two-section payroll CSV:
 *   Section 1 — Period Summary (one row per employee)
 *   Section 2 — Daily Attendance Detail (one row per day)
 */
function sendPayrollCSV(res, { from, to, summaryRows, detailRows, filename }) {
    const summaryFields = [
        { label: 'Employee', value: 'employee_name' },
        { label: 'Email', value: 'email' },
        { label: 'Department', value: 'department' },
        { label: 'Team', value: 'team' },
        { label: 'Role', value: 'role' },
        { label: 'Period', value: 'period' },
        { label: 'Scheduled Days', value: 'scheduled_days' },
        { label: 'Days Worked', value: 'days_worked' },
        { label: 'Leave Days', value: 'leave_days' },
        { label: 'Absent Days', value: 'absent_days' },
        { label: 'Total Hours', value: 'total_hours' },
        { label: 'Regular Hours', value: 'regular_hours' },
        { label: 'Overtime Hours', value: 'overtime_hours' },
    ];
    const detailFields = [
        { label: 'Employee', value: 'employee_name' },
        { label: 'Department', value: 'department' },
        { label: 'Team', value: 'team' },
        { label: 'Date', value: 'date' },
        { label: 'Day', value: 'day_of_week' },
        { label: 'Status', value: 'status' },
        { label: 'Leave Type', value: 'leave_type' },
        { label: 'Leave Duration', value: 'leave_duration' },
        { label: 'Clock In', value: 'clock_in' },
        { label: 'Clock Out', value: 'clock_out' },
        { label: 'Regular Hrs', value: 'regular_hours' },
        { label: 'Overtime Hrs', value: 'overtime_hours' },
        { label: 'Break Hrs', value: 'break_hours' },
        { label: 'Total Hrs', value: 'total_hours' },
        { label: 'Work Mode', value: 'work_mode' },
    ];

    const sanitize = rows => rows.map(row => {
        const out = {};
        for (const k of Object.keys(row)) out[k] = sanitizeCell(row[k]);
        return out;
    });

    const sumCSV = new Parser({ fields: summaryFields }).parse(sanitize(summaryRows));
    const detCSV = detailRows.length > 0
        ? new Parser({ fields: detailFields }).parse(sanitize(detailRows))
        : detailFields.map(f => `"${f.label}"`).join(',');

    const body = [
        `PAYROLL SUMMARY (${from} to ${to})`,
        sumCSV,
        '',
        'DAILY ATTENDANCE DETAIL',
        detCSV,
    ].join('\r\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(filename)}"`);
    res.send(body);
}

/**
 * Send a structured payroll PDF:
 *   Page 1+  — Period Summary table (one row per employee)
 *   Then     — Per-employee daily detail sections with colour-coded rows
 */
function sendPayrollPDF(res, { from, to, summaryRows, detailRows, filename }) {
    const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(filename)}"`);
    doc.pipe(res);

    const ML = doc.page.margins.left;
    const MB = doc.page.margins.bottom;
    const useW = doc.page.width - ML - doc.page.margins.right;
    const pad = 3;

    /** Distribute pixel widths by ratio array */
    function computeWidths(ratios) {
        const total = ratios.reduce((a, b) => a + b, 0);
        const ws = ratios.map(r => Math.floor(r / total * useW));
        // Assign remainder to last column so widths sum exactly to useW
        const diff = useW - ws.reduce((a, b) => a + b, 0);
        ws[ws.length - 1] += diff;
        return ws;
    }

    /**
     * Draw a single table row at explicit y-coordinate.
     * Returns the row height consumed.
     */
    function drawRow(y, values, widths, { bold = false, fontSize = 7, bg, textColor = '#222222' } = {}) {
        const font = bold ? 'Helvetica-Bold' : 'Helvetica';
        doc.font(font).fontSize(fontSize);
        const cellHeights = values.map((v, i) =>
            doc.heightOfString(String(v ?? ''), { width: widths[i] - pad * 2 })
        );
        const rh = Math.max(...cellHeights) + pad * 2;
        if (bg) {
            doc.save().rect(ML, y, useW, rh).fill(bg).restore();
            doc.font(font).fontSize(fontSize);
        }
        let x = ML;
        values.forEach((v, i) => {
            doc.fillColor(textColor)
                .text(String(v ?? ''), x + pad, y + pad, { width: widths[i] - pad * 2, lineBreak: true });
            x += widths[i];
        });
        return rh;
    }

    function pageBreakNeeded(y, needed) {
        return y + needed > doc.page.height - MB;
    }

    // ──────────────────────────────────────────────────────────────────────
    // TITLE BLOCK
    // ──────────────────────────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#1a1a1a')
        .text('Payroll Report', { align: 'center' });
    doc.font('Helvetica').fontSize(10).fillColor('#555555')
        .text(`Period: ${from}  to  ${to}`, { align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor('#888888')
        .text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
    doc.moveDown(1.2);

    // ──────────────────────────────────────────────────────────────────────
    // SECTION 1 — PERIOD SUMMARY
    // ──────────────────────────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1a5276')
        .text('Period Summary', ML, doc.y);
    doc.moveDown(0.2);
    doc.moveTo(ML, doc.y).lineTo(ML + useW, doc.y).lineWidth(1).stroke('#1a5276');
    doc.moveDown(0.5);

    const sumCols = [
        { header: 'Employee', key: 'employee_name' },
        { header: 'Department', key: 'department' },
        { header: 'Team', key: 'team' },
        { header: 'Role', key: 'role' },
        { header: 'Scheduled\nDays', key: 'scheduled_days' },
        { header: 'Days\nWorked', key: 'days_worked' },
        { header: 'Leave\nDays', key: 'leave_days' },
        { header: 'Absent\nDays', key: 'absent_days' },
        { header: 'Total\nHours', key: 'total_hours' },
        { header: 'Regular\nHours', key: 'regular_hours' },
        { header: 'Overtime\nHours', key: 'overtime_hours' },
    ];
    const sumW = computeWidths([2.2, 1.4, 1.2, 1.0, 0.85, 0.85, 0.85, 0.85, 0.85, 0.85, 0.85]);

    let y = doc.y;
    y += drawRow(y, sumCols.map(c => c.header), sumW, { bold: true, bg: '#1a5276', textColor: '#ffffff' });
    doc.moveTo(ML, y).lineTo(ML + useW, y).lineWidth(0.3).stroke('#aaccee');

    summaryRows.forEach((row, i) => {
        const vals = sumCols.map(c => String(row[c.key] ?? ''));
        doc.font('Helvetica').fontSize(7);
        const needed = Math.max(...vals.map((v, j) =>
            doc.heightOfString(v, { width: sumW[j] - pad * 2 })
        )) + pad * 2 + 2;
        if (pageBreakNeeded(y, needed)) {
            doc.addPage();
            y = doc.y;
            y += drawRow(y, sumCols.map(c => c.header), sumW, { bold: true, bg: '#1a5276', textColor: '#ffffff' });
        }
        const bg = i % 2 === 1 ? '#eaf3fb' : '#f7fbff';
        y += drawRow(y, vals, sumW, { bg }) + 1;
    });

    doc.y = y;
    doc.moveDown(1.5);

    // ──────────────────────────────────────────────────────────────────────
    // SECTION 2 — DAILY DETAIL (per employee)
    // ──────────────────────────────────────────────────────────────────────
    const grouped = {};
    for (const row of detailRows) {
        (grouped[row.employee_name] ??= []).push(row);
    }

    const detCols = [
        { header: 'Date', key: 'date' },
        { header: 'Day', key: 'day_of_week' },
        { header: 'Status', key: 'status' },
        { header: 'Leave Type', key: 'leave_type' },
        { header: 'Leave Dur.', key: 'leave_duration' },
        { header: 'Clock In', key: 'clock_in' },
        { header: 'Clock Out', key: 'clock_out' },
        { header: 'Regular\nHrs', key: 'regular_hours' },
        { header: 'OT\nHrs', key: 'overtime_hours' },
        { header: 'Break\nHrs', key: 'break_hours' },
        { header: 'Total\nHrs', key: 'total_hours' },
        { header: 'Work Mode', key: 'work_mode' },
    ];
    const detW = computeWidths([1.2, 0.7, 1.8, 1.1, 0.95, 0.8, 0.8, 0.8, 0.65, 0.8, 0.8, 0.85]);

    // Colour coding by attendance status
    const STATUS_BG = {
        'Worked': '#f0fff0',
        'Absent': '#fde8e8',
        'Leave \u2013 Full Day': '#fff8dc',
        'Leave + Worked (Part Day)': '#e8f5e9',
        'Leave \u2013 Half Day': '#fff8dc',
        'Leave \u2013 Quarter Day': '#fffde7',
        'Weekend (Worked)': '#e8eaf6',
        'Holiday (Worked)': '#fce4ec',
    };

    for (const [empName, empRows] of Object.entries(grouped)) {
        const sumRow = summaryRows.find(s => s.employee_name === empName) || {};
        y = doc.y;

        // Employee section header
        if (pageBreakNeeded(y, 55)) { doc.addPage(); y = doc.y; }
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#1a5276')
            .text(empName, ML, y, { width: useW });
        y += doc.heightOfString(empName, { width: useW }) + 2;
        doc.moveTo(ML, y).lineTo(ML + useW, y).lineWidth(0.8).stroke('#1a5276');
        y += 4;

        const meta = [sumRow.department, sumRow.team, sumRow.role].filter(Boolean).join(' · ');
        const stats = [
            `Scheduled: ${sumRow.scheduled_days ?? '–'} days`,
            `Worked: ${sumRow.days_worked ?? '–'}`,
            `Leave: ${sumRow.leave_days ?? '–'}`,
            `Absent: ${sumRow.absent_days ?? '–'}`,
            `Total: ${sumRow.total_hours ?? '–'} hrs`,
            `Overtime: ${sumRow.overtime_hours ?? '–'} hrs`,
        ].join('   |   ');
        const infoLine = meta ? `${meta}    \u2014    ${stats}` : stats;
        doc.font('Helvetica').fontSize(8).fillColor('#444444')
            .text(infoLine, ML, y, { width: useW });
        y += doc.heightOfString(infoLine, { width: useW }) + 7;

        // Detail table
        y += drawRow(y, detCols.map(c => c.header), detW, { bold: true, fontSize: 7, bg: '#2471a3', textColor: '#ffffff' });

        empRows.forEach(row => {
            const vals = detCols.map(c => String(row[c.key] ?? ''));
            doc.font('Helvetica').fontSize(7);
            const needed = Math.max(...vals.map((v, i) =>
                doc.heightOfString(v, { width: detW[i] - pad * 2 })
            )) + pad * 2 + 2;
            if (pageBreakNeeded(y, needed)) {
                doc.addPage();
                y = doc.y;
                y += drawRow(y, detCols.map(c => c.header), detW, { bold: true, fontSize: 7, bg: '#2471a3', textColor: '#ffffff' });
            }
            const bg = STATUS_BG[row.status] || '#f9f9f9';
            y += drawRow(y, vals, detW, { bg }) + 1;
        });

        doc.y = y + 18; // breathing room between employees
    }

    doc.end();
}

module.exports = { sendCSV, sendPDF, sendPayrollCSV, sendPayrollPDF };
