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

    // Table
    const tableLeft = doc.page.margins.left;
    const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const colWidths = columns.map(c => c.width || Math.floor(usableWidth / columns.length));

    // Header row
    let x = tableLeft;
    const headerY = doc.y;
    doc.font('Helvetica-Bold').fontSize(8);
    columns.forEach((col, i) => {
        doc.text(col.header, x, headerY, { width: colWidths[i], align: 'left' });
        x += colWidths[i];
    });
    doc.moveDown(0.3);
    doc.moveTo(tableLeft, doc.y).lineTo(tableLeft + usableWidth, doc.y).stroke('#ccc');
    doc.moveDown(0.3);

    // Data rows
    doc.font('Helvetica').fontSize(7);
    rows.forEach(row => {
        if (doc.y > doc.page.height - 60) {
            doc.addPage();
            doc.font('Helvetica').fontSize(7);
        }
        x = tableLeft;
        const rowY = doc.y;
        columns.forEach((col, i) => {
            const val = row[col.key] != null ? String(row[col.key]) : '';
            doc.text(val, x, rowY, { width: colWidths[i], align: 'left' });
            x += colWidths[i];
        });
        doc.moveDown(0.5);
    });

    doc.end();
}

module.exports = { sendCSV, sendPDF };
