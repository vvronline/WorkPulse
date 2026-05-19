const PDFDocument = require('pdfkit');
const { amountToWords } = require('./numberToWords');

function sanitizeFilename(name) {
    return String(name).replace(/[^a-zA-Z0-9._\-]/g, '_');
}

function sendSalarySlipPDF(res, { slip, employee, organization, branding, ytdData, filename }) {
    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'portrait' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(filename)}"`);
    doc.pipe(res);

    const ML = doc.page.margins.left;
    const MR = doc.page.margins.right;
    const pageWidth = doc.page.width;
    const usableWidth = pageWidth - ML - MR;
    const accentColor = branding?.accent_color || '#1a5276';

    // ── HEADER ──
    doc.rect(ML, doc.y, usableWidth, 60).fill(accentColor);
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#ffffff')
        .text('SALARY SLIP', ML + 15, doc.y - 55, { width: usableWidth / 2 });
    doc.font('Helvetica').fontSize(9).fillColor('#ffffff')
        .text(slip.slip_month ? `Period: ${slip.slip_month}` : '', ML + 15, doc.y + 5);

    const orgName = organization?.name || 'Organization';
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#ffffff')
        .text(orgName, pageWidth / 2, doc.y - 25, { width: usableWidth / 2 - 15, align: 'right' });
    doc.moveDown(3);

    // ── EMPLOYEE DETAILS ──
    const detailsY = doc.y + 10;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(accentColor)
        .text('EMPLOYEE DETAILS', ML, detailsY);
    doc.moveTo(ML, detailsY + 14).lineTo(ML + usableWidth, detailsY + 14).lineWidth(0.5).stroke(accentColor);
    doc.moveDown(0.8);

    const detStartY = doc.y;
    const col1X = ML;
    const col2X = ML + usableWidth / 2 + 20;
    const labelW = 100;
    const rowH = 16;

    function detailRow(y, label, value, x) {
        doc.font('Helvetica').fontSize(8).fillColor('#666666').text(label, x, y, { width: labelW });
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#222222').text(value || '-', x + labelW, y);
    }

    detailRow(detStartY, 'Employee Name:', employee.full_name, col1X);
    detailRow(detStartY, 'Department:', employee.department_name || '-', col2X);
    detailRow(detStartY + rowH, 'Employee ID:', `EMP-${String(employee.id).padStart(4, '0')}`, col1X);
    detailRow(detStartY + rowH, 'Designation:', employee.role || '-', col2X);
    detailRow(detStartY + rowH * 2, 'Email:', employee.email || '-', col1X);
    detailRow(detStartY + rowH * 2, 'Bank Account:', employee.bank_masked || '-', col2X);

    doc.y = detStartY + rowH * 3 + 10;

    // ── ATTENDANCE SUMMARY ──
    const attY = doc.y;
    doc.rect(ML, attY, usableWidth, 30).fill('#f0f7ff');
    doc.font('Helvetica-Bold').fontSize(8).fillColor(accentColor)
        .text('ATTENDANCE SUMMARY', ML + 10, attY + 4);

    const attItems = [
        `Days Worked: ${slip.days_worked || 0}`,
        `Leave Days: ${slip.leave_days || 0}`,
        `Absent Days: ${slip.days_absent || 0}`,
        `Overtime Hrs: ${slip.overtime_hours || 0}`,
    ];
    doc.font('Helvetica').fontSize(8).fillColor('#333333')
        .text(attItems.join('    |    '), ML + 10, attY + 16, { width: usableWidth - 20 });
    doc.y = attY + 38;

    // ── EARNINGS & DEDUCTIONS (side by side) ──
    const tableY = doc.y;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(accentColor)
        .text('EARNINGS', ML, tableY, { width: usableWidth / 2 });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(accentColor)
        .text('DEDUCTIONS', col2X - 20, tableY, { width: usableWidth / 2 });
    doc.moveTo(ML, tableY + 14).lineTo(ML + usableWidth, tableY + 14).lineWidth(0.5).stroke('#cccccc');

    let eY = tableY + 20;
    const earnings = slip.earnings || {};
    const deductions = slip.deductions || {};

    const earningsEntries = Object.entries(earnings).filter(([, v]) => v > 0);
    const deductionsEntries = Object.entries(deductions).filter(([, v]) => v > 0);
    const maxRows = Math.max(earningsEntries.length, deductionsEntries.length);

    for (let i = 0; i < maxRows; i++) {
        if (i < earningsEntries.length) {
            const [key, val] = earningsEntries[i];
            const label = formatComponentLabel(key);
            doc.font('Helvetica').fontSize(8).fillColor('#444444')
                .text(label, ML + 5, eY, { width: 120 });
            doc.font('Helvetica').fontSize(8).fillColor('#222222')
                .text(formatCurrency(val, slip.currency), ML + 130, eY, { width: 80, align: 'right' });
        }
        if (i < deductionsEntries.length) {
            const [key, val] = deductionsEntries[i];
            const label = formatComponentLabel(key);
            doc.font('Helvetica').fontSize(8).fillColor('#444444')
                .text(label, col2X - 15, eY, { width: 120 });
            doc.font('Helvetica').fontSize(8).fillColor('#222222')
                .text(formatCurrency(val, slip.currency), col2X + 110, eY, { width: 80, align: 'right' });
        }
        eY += 15;
    }

    // Totals
    eY += 5;
    doc.moveTo(ML, eY).lineTo(ML + usableWidth, eY).lineWidth(0.5).stroke('#cccccc');
    eY += 6;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#222222')
        .text('Gross Earnings:', ML + 5, eY, { width: 120 });
    doc.text(formatCurrency(slip.gross_earnings, slip.currency), ML + 130, eY, { width: 80, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#222222')
        .text('Total Deductions:', col2X - 15, eY, { width: 120 });
    doc.text(formatCurrency(slip.total_deductions, slip.currency), col2X + 110, eY, { width: 80, align: 'right' });

    // ── NET PAY ──
    eY += 30;
    doc.rect(ML, eY, usableWidth, 40).fill(accentColor);
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#ffffff')
        .text(`NET PAY: ${formatCurrency(slip.net_pay, slip.currency)}`, ML + 15, eY + 6, { width: usableWidth - 30, align: 'center' });
    const words = amountToWords(slip.net_pay, slip.currency || 'INR');
    doc.font('Helvetica').fontSize(8).fillColor('#dddddd')
        .text(`(${words})`, ML + 15, eY + 25, { width: usableWidth - 30, align: 'center' });

    doc.y = eY + 50;

    // ── YTD SUMMARY ──
    if (ytdData) {
        const ytdY = doc.y;
        doc.font('Helvetica-Bold').fontSize(9).fillColor(accentColor)
            .text('YEAR-TO-DATE SUMMARY', ML, ytdY);
        doc.moveTo(ML, ytdY + 12).lineTo(ML + usableWidth, ytdY + 12).lineWidth(0.3).stroke('#cccccc');
        doc.font('Helvetica').fontSize(8).fillColor('#333333')
            .text(
                `Total Gross: ${formatCurrency(ytdData.totalGross, slip.currency)}   |   ` +
                `Total Deductions: ${formatCurrency(ytdData.totalDeductions, slip.currency)}   |   ` +
                `Total Net: ${formatCurrency(ytdData.totalNet, slip.currency)}`,
                ML, ytdY + 18
            );
        doc.y = ytdY + 38;
    }

    // ── FOOTER ──
    doc.moveDown(2);
    doc.font('Helvetica').fontSize(7).fillColor('#999999')
        .text('This is a computer-generated document and does not require a signature.', ML, doc.y, { align: 'center', width: usableWidth });
    doc.font('Helvetica').fontSize(7).fillColor('#999999')
        .text(`Generated on: ${new Date().toLocaleString()}`, ML, doc.y + 3, { align: 'center', width: usableWidth });

    doc.end();
}

function formatComponentLabel(key) {
    return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatCurrency(amount, currency = 'INR') {
    const num = Number(amount) || 0;
    if (currency === 'INR') {
        return '₹' + num.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    }
    return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = { sendSalarySlipPDF };
