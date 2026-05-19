const PDFDocument = require('pdfkit');
const { amountToWords } = require('./numberToWords');

function sanitizeFilename(name) {
    return String(name).replace(/[^a-zA-Z0-9._\-]/g, '_');
}

function getMonthYearLabel(slipMonth) {
    if (!slipMonth) return '';
    const [year, month] = slipMonth.split('-');
    const date = new Date(Number(year), Number(month) - 1);
    return date.toLocaleString('en-US', { month: 'long', year: 'numeric' });
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
    const monthYearLabel = getMonthYearLabel(slip.slip_month);

    // ── HEADER ──
    doc.rect(ML, doc.y, usableWidth, 70).fill(accentColor);
    const headerStartY = doc.y;

    const orgName = organization?.name || 'Organization';
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#ffffff')
        .text(orgName, ML + 15, headerStartY + 12, { width: usableWidth - 30 });

    doc.font('Helvetica').fontSize(11).fillColor('#ffffff')
        .text(`Payslip for the month of ${monthYearLabel}`, ML + 15, headerStartY + 34, { width: usableWidth - 30 });

    doc.y = headerStartY + 80;

    // ── EMPLOYEE DETAILS SECTION ──
    const empSectionY = doc.y;
    doc.font('Helvetica-Bold').fontSize(11).fillColor(accentColor)
        .text('Employee Details', ML, empSectionY);
    doc.moveTo(ML, empSectionY + 16).lineTo(ML + usableWidth, empSectionY + 16).lineWidth(0.5).stroke(accentColor);
    doc.y = empSectionY + 24;

    const detStartY = doc.y;
    const col1X = ML;
    const col2X = ML + usableWidth / 2 + 20;
    const labelW = 110;
    const rowH = 18;

    function detailRow(y, label, value, x) {
        doc.font('Helvetica').fontSize(9).fillColor('#000000').text(label, x, y, { width: labelW });
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#000000').text(value || '-', x + labelW, y);
    }

    detailRow(detStartY, 'Employee Name:', employee.full_name, col1X);
    detailRow(detStartY, 'Department:', employee.department_name || '-', col2X);
    detailRow(detStartY + rowH, 'Employee ID:', `EMP-${String(employee.id).padStart(4, '0')}`, col1X);
    detailRow(detStartY + rowH, 'Designation:', employee.team_name || employee.department_name || '-', col2X);
    detailRow(detStartY + rowH * 2, 'Email:', employee.email || '-', col1X);
    detailRow(detStartY + rowH * 2, 'Bank Account:', employee.bank_masked || '-', col2X);

    doc.y = detStartY + rowH * 3 + 12;

    // ── ATTENDANCE SUMMARY ──
    const attY = doc.y;
    doc.rect(ML, attY, usableWidth, 32).fill('#f0f7ff');
    doc.font('Helvetica-Bold').fontSize(9).fillColor(accentColor)
        .text('Attendance Summary', ML + 10, attY + 4);

    const attItems = [
        `Days Worked: ${slip.days_worked || 0}`,
        `Leave Days: ${slip.leave_days || 0}`,
        `Absent Days: ${slip.days_absent || 0}`,
        `Overtime Hrs: ${slip.overtime_hours || 0}`,
    ];
    doc.font('Helvetica').fontSize(8.5).fillColor('#000000')
        .text(attItems.join('    |    '), ML + 10, attY + 18, { width: usableWidth - 20 });
    doc.y = attY + 42;

    // ── COMPENSATION SECTION (EARNINGS & DEDUCTIONS side by side) ──
    const compSectionY = doc.y;
    doc.font('Helvetica-Bold').fontSize(11).fillColor(accentColor)
        .text('Compensation Details', ML, compSectionY);
    doc.moveTo(ML, compSectionY + 16).lineTo(ML + usableWidth, compSectionY + 16).lineWidth(0.5).stroke(accentColor);
    doc.y = compSectionY + 24;

    const tableY = doc.y;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000')
        .text('Earnings', ML, tableY, { width: usableWidth / 2 });
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000')
        .text('Deductions', col2X - 20, tableY, { width: usableWidth / 2 });
    doc.moveTo(ML, tableY + 14).lineTo(ML + usableWidth, tableY + 14).lineWidth(0.5).stroke('#000000');

    let eY = tableY + 22;
    const earnings = slip.earnings || {};
    const deductions = slip.deductions || {};

    const earningsEntries = Object.entries(earnings).filter(([, v]) => v > 0);
    const deductionsEntries = Object.entries(deductions).filter(([, v]) => v > 0);
    const maxRows = Math.max(earningsEntries.length, deductionsEntries.length);

    for (let i = 0; i < maxRows; i++) {
        if (i < earningsEntries.length) {
            const [key, val] = earningsEntries[i];
            const label = formatComponentLabel(key);
            doc.font('Helvetica').fontSize(9).fillColor('#000000')
                .text(label, ML + 5, eY, { width: 130 });
            doc.font('Helvetica').fontSize(9).fillColor('#000000')
                .text(formatCurrency(val, slip.currency), ML + 140, eY, { width: 80, align: 'right' });
        }
        if (i < deductionsEntries.length) {
            const [key, val] = deductionsEntries[i];
            const label = formatComponentLabel(key);
            doc.font('Helvetica').fontSize(9).fillColor('#000000')
                .text(label, col2X - 15, eY, { width: 130 });
            doc.font('Helvetica').fontSize(9).fillColor('#000000')
                .text(formatCurrency(val, slip.currency), col2X + 120, eY, { width: 80, align: 'right' });
        }
        eY += 16;
    }

    // Totals
    eY += 8;
    doc.moveTo(ML, eY).lineTo(ML + usableWidth, eY).lineWidth(0.5).stroke('#000000');
    eY += 8;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#000000')
        .text('Gross Earnings:', ML + 5, eY, { width: 130 });
    doc.text(formatCurrency(slip.gross_earnings, slip.currency), ML + 140, eY, { width: 80, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#000000')
        .text('Total Deductions:', col2X - 15, eY, { width: 130 });
    doc.text(formatCurrency(slip.total_deductions, slip.currency), col2X + 120, eY, { width: 80, align: 'right' });

    // ── NET PAY ──
    eY += 30;
    doc.rect(ML, eY, usableWidth, 44).fill(accentColor);
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#ffffff')
        .text(`NET PAY: ${formatCurrency(slip.net_pay, slip.currency)}`, ML + 15, eY + 8, { width: usableWidth - 30, align: 'center' });
    const words = amountToWords(slip.net_pay, slip.currency || 'INR');
    doc.font('Helvetica').fontSize(9).fillColor('#ffffff')
        .text(`(${words})`, ML + 15, eY + 28, { width: usableWidth - 30, align: 'center' });

    doc.y = eY + 54;

    // ── YTD SUMMARY ──
    if (ytdData) {
        const ytdY = doc.y;
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(accentColor)
            .text('Year-to-Date Summary', ML, ytdY);
        doc.moveTo(ML, ytdY + 14).lineTo(ML + usableWidth, ytdY + 14).lineWidth(0.3).stroke('#000000');
        doc.font('Helvetica').fontSize(9).fillColor('#000000')
            .text(
                `Total Gross: ${formatCurrency(ytdData.totalGross, slip.currency)}   |   ` +
                `Total Deductions: ${formatCurrency(ytdData.totalDeductions, slip.currency)}   |   ` +
                `Total Net: ${formatCurrency(ytdData.totalNet, slip.currency)}`,
                ML, ytdY + 20
            );
        doc.y = ytdY + 40;
    }

    // ── FOOTER ──
    doc.moveDown(2);
    doc.font('Helvetica').fontSize(8).fillColor('#000000')
        .text('This is a computer-generated document and does not require a signature.', ML, doc.y, { align: 'center', width: usableWidth });
    doc.font('Helvetica').fontSize(8).fillColor('#000000')
        .text(`Generated on: ${new Date().toLocaleString()}`, ML, doc.y + 4, { align: 'center', width: usableWidth });

    doc.end();
}

function formatComponentLabel(key) {
    const labels = {
        basic: 'Basic Salary',
        hra: 'HRA',
        conveyance: 'Conveyance Allowance',
        special_allowance: 'Special Allowance',
        pf: 'Provident Fund',
        professional_tax: 'Professional Tax',
        tds: 'Income Tax (TDS)',
    };
    const normalized = key.replace(/^_ded_/, '');
    return labels[normalized] || normalized.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatCurrency(amount, currency = 'INR') {
    const num = Number(amount) || 0;
    if (currency === 'INR') {
        return 'Rs.' + num.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    }
    return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = { sendSalarySlipPDF };
