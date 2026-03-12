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
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
}

/**
 * Stream a PDF table response.
 * columns: [{ header, key, width }]
 */
function sendPDF(res, { title, columns, rows, filename }) {
    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: rows.length > 0 && columns.length > 6 ? 'landscape' : 'portrait' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
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

module.exports = { sendCSV, sendPDF };
