const express = require('express');
const auth = require('../middleware/auth');
const { loadUserContext, requireRole, getVisibleUserIds } = require('../middleware/rbac');
const { requireTenant, requireFeature } = require('../middleware/tenant');
const { calculateAttendance } = require('../utils/attendance');
const { encrypt, decrypt, maskAccountNumber } = require('../utils/encryption');
const { sendSalarySlipPDF } = require('../utils/salarySlipPdf');
const { getPayoutService } = require('../services/razorpayPayout');
const { logger } = require('../utils/logger');

const router = express.Router();
router.use(auth, loadUserContext, requireTenant, requireFeature('payroll'));

function requireSameOrg(req, res, next) {
    if (!req.userOrgId && req.userRole !== 'platform_admin') {
        return res.status(403).json({ error: 'Organization required' });
    }
    next();
}

function logAction(req, action, entity, entityId, details = {}) {
    req.db.query(
        `INSERT INTO audit_logs(user_id, org_id, action, entity_type, entity_id, details)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [req.userId, req.userOrgId, action, entity, entityId, JSON.stringify(details)]
    ).catch(() => { });
}

// ==================== COMPENSATION TEMPLATES ====================

router.get('/templates', requireSameOrg, async (req, res) => {
    try {
        const result = await req.db.query(
            `SELECT * FROM compensation_templates WHERE org_id = $1 ORDER BY is_default DESC, name`,
            [req.userOrgId]
        );
        res.json(result.rows);
    } catch (err) {
        logger.error({ err }, 'GET templates error');
        res.status(500).json({ error: 'Failed to fetch templates' });
    }
});

router.post('/templates', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { name, description, components, is_default } = req.body;
        if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
        if (!Array.isArray(components) || components.length === 0) {
            return res.status(400).json({ error: 'At least one component is required' });
        }
        if (is_default) {
            await req.db.query(
                `UPDATE compensation_templates SET is_default = FALSE WHERE org_id = $1`,
                [req.userOrgId]
            );
        }
        const result = await req.db.query(
            `INSERT INTO compensation_templates (org_id, name, description, components, is_default, created_by)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [req.userOrgId, name.trim(), description || null, JSON.stringify(components), !!is_default, req.userId]
        );
        logAction(req, 'create', 'compensation_template', result.rows[0].id, { name });
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Template name already exists' });
        logger.error({ err }, 'POST templates error');
        res.status(500).json({ error: 'Failed to create template' });
    }
});

router.put('/templates/:id', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { name, description, components, is_default } = req.body;
        const tmpl = (await req.db.query(
            `SELECT * FROM compensation_templates WHERE id = $1 AND org_id = $2`,
            [req.params.id, req.userOrgId]
        )).rows[0];
        if (!tmpl) return res.status(404).json({ error: 'Template not found' });
        if (is_default) {
            await req.db.query(
                `UPDATE compensation_templates SET is_default = FALSE WHERE org_id = $1 AND id != $2`,
                [req.userOrgId, req.params.id]
            );
        }
        const result = await req.db.query(
            `UPDATE compensation_templates
             SET name = COALESCE($1, name), description = $2, components = COALESCE($3, components),
                 is_default = $4, updated_at = NOW()
             WHERE id = $5 AND org_id = $6 RETURNING *`,
            [name?.trim(), description ?? tmpl.description, components ? JSON.stringify(components) : null, !!is_default, req.params.id, req.userOrgId]
        );
        res.json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Template name already exists' });
        logger.error({ err }, 'PUT templates error');
        res.status(500).json({ error: 'Failed to update template' });
    }
});

router.delete('/templates/:id', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const usage = (await req.db.query(
            `SELECT COUNT(*) AS cnt FROM employee_compensation WHERE template_id = $1`,
            [req.params.id]
        )).rows[0];
        if (parseInt(usage.cnt) > 0) {
            return res.status(400).json({ error: 'Template is in use by employees. Reassign them first.' });
        }
        await req.db.query(
            `DELETE FROM compensation_templates WHERE id = $1 AND org_id = $2`,
            [req.params.id, req.userOrgId]
        );
        logAction(req, 'delete', 'compensation_template', req.params.id);
        res.json({ message: 'Template deleted' });
    } catch (err) {
        logger.error({ err }, 'DELETE templates error');
        res.status(500).json({ error: 'Failed to delete template' });
    }
});

// ==================== EMPLOYEE COMPENSATION ====================

router.get('/employees', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const result = await req.db.query(
            `SELECT ec.*, u.full_name, u.email, u.role, d.name AS department_name, t.name AS team_name
             FROM employee_compensation ec
             JOIN users u ON u.id = ec.user_id
             LEFT JOIN departments d ON d.id = u.department_id
             LEFT JOIN teams t ON t.id = u.team_id
             WHERE ec.org_id = $1 AND ec.effective_to IS NULL
             ORDER BY u.full_name`,
            [req.userOrgId]
        );
        res.json(result.rows);
    } catch (err) {
        logger.error({ err }, 'GET employee compensations error');
        res.status(500).json({ error: 'Failed to fetch employee compensations' });
    }
});

router.get('/employees/:userId', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const result = await req.db.query(
            `SELECT ec.*, ct.name AS template_name
             FROM employee_compensation ec
             LEFT JOIN compensation_templates ct ON ct.id = ec.template_id
             WHERE ec.user_id = $1 AND ec.org_id = $2
             ORDER BY ec.effective_from DESC`,
            [req.params.userId, req.userOrgId]
        );
        res.json(result.rows);
    } catch (err) {
        logger.error({ err }, 'GET employee compensation history error');
        res.status(500).json({ error: 'Failed to fetch compensation history' });
    }
});

router.post('/employees/:userId', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { template_id, effective_from, base_salary, ctc_annual, components, currency, payment_frequency, bank_account, notes } = req.body;
        if (!effective_from || !base_salary) {
            return res.status(400).json({ error: 'effective_from and base_salary are required' });
        }
        const user = (await req.db.query(
            `SELECT id FROM users WHERE id = $1 AND org_id = $2`,
            [req.params.userId, req.userOrgId]
        )).rows[0];
        if (!user) return res.status(404).json({ error: 'Employee not found in organization' });

        // Close previous active record
        await req.db.query(
            `UPDATE employee_compensation SET effective_to = $1, updated_at = NOW()
             WHERE user_id = $2 AND org_id = $3 AND effective_to IS NULL`,
            [effective_from, req.params.userId, req.userOrgId]
        );

        const result = await req.db.query(
            `INSERT INTO employee_compensation
             (user_id, org_id, template_id, effective_from, ctc_annual, base_salary, components, currency, payment_frequency, bank_account, notes, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [req.params.userId, req.userOrgId, template_id || null, effective_from, ctc_annual || 0, base_salary,
            JSON.stringify(components || {}), currency || 'INR', payment_frequency || 'monthly',
            bank_account || null, notes || null, req.userId]
        );
        logAction(req, 'create', 'employee_compensation', result.rows[0].id, { user_id: req.params.userId, base_salary, ctc_annual });
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Compensation for this effective date already exists' });
        logger.error({ err }, 'POST employee compensation error');
        res.status(500).json({ error: 'Failed to assign compensation' });
    }
});

router.put('/employees/:userId/:id', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { base_salary, ctc_annual, components, currency, payment_frequency, bank_account, notes } = req.body;
        const existing = (await req.db.query(
            `SELECT * FROM employee_compensation WHERE id = $1 AND user_id = $2 AND org_id = $3`,
            [req.params.id, req.params.userId, req.userOrgId]
        )).rows[0];
        if (!existing) return res.status(404).json({ error: 'Compensation record not found' });

        const result = await req.db.query(
            `UPDATE employee_compensation
             SET base_salary = COALESCE($1, base_salary), ctc_annual = COALESCE($2, ctc_annual),
                 components = COALESCE($3, components),
                 currency = COALESCE($4, currency), payment_frequency = COALESCE($5, payment_frequency),
                 bank_account = COALESCE($6, bank_account), notes = COALESCE($7, notes), updated_at = NOW()
             WHERE id = $8 RETURNING *`,
            [base_salary, ctc_annual ?? null, components ? JSON.stringify(components) : null, currency, payment_frequency, bank_account, notes, req.params.id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        logger.error({ err }, 'PUT employee compensation error');
        res.status(500).json({ error: 'Failed to update compensation' });
    }
});

// ==================== PAYROLL RUN ====================

router.post('/payroll-run', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { pay_period_id } = req.body;
        if (!pay_period_id) return res.status(400).json({ error: 'pay_period_id is required' });

        const period = (await req.db.query(
            `SELECT * FROM pay_periods WHERE id = $1 AND org_id = $2`,
            [pay_period_id, req.userOrgId]
        )).rows[0];
        if (!period) return res.status(404).json({ error: 'Pay period not found' });
        if (!period.locked_by) return res.status(400).json({ error: 'Pay period must be locked before generating salary slips' });

        const employees = (await req.db.query(
            `SELECT ec.*, u.full_name, u.timezone_offset
             FROM employee_compensation ec
             JOIN users u ON u.id = ec.user_id AND u.is_active = TRUE
             WHERE ec.org_id = $1 AND ec.effective_to IS NULL
               AND ec.effective_from <= $2`,
            [req.userOrgId, period.end_date]
        )).rows;

        if (employees.length === 0) {
            return res.status(400).json({ error: 'No employees with active compensation found' });
        }

        const orgRow = (await req.db.query(
            `SELECT work_hours_per_day, work_days FROM organizations WHERE id = $1`,
            [req.userOrgId]
        )).rows[0] || {};
        const workDaysPerMonth = (orgRow.work_days || '1,2,3,4,5').split(',').length * 4.33;

        let generated = 0;
        const slipMonth = period.start_date.slice(0, 7);

        logger.info({ start_date: period.start_date, end_date: period.end_date, slipMonth }, 'Payroll run date range');

        for (const emp of employees) {
            const attendance = await calculateAttendance(
                req.db, emp.user_id, req.userOrgId,
                period.start_date, period.end_date, emp.timezone_offset || 0
            );

            logger.info({ user_id: emp.user_id, attendance, period_start: period.start_date, period_end: period.end_date }, 'Attendance calculation result');

            const components = emp.components || {};
            const baseSalary = parseFloat(emp.base_salary) || 0;

            // Calculate earnings
            const earnings = {};
            earnings.basic = baseSalary;
            for (const [key, val] of Object.entries(components)) {
                if (key.startsWith('_')) continue;
                const numVal = parseFloat(val) || 0;
                if (numVal > 0) earnings[key] = numVal;
            }

            // Pro-rata for attendance (LOP deduction)
            const scheduledDays = attendance.scheduledDays || 1;
            const effectiveDays = attendance.daysWorked + attendance.leaveDays;
            const attendanceRatio = Math.min(1, effectiveDays / scheduledDays);

            // Apply pro-rata to all earnings
            for (const key of Object.keys(earnings)) {
                earnings[key] = Math.round(earnings[key] * attendanceRatio);
            }


            // Calculate deductions from components with negative or deduction-tagged keys
            const deductions = {};
            for (const [key, val] of Object.entries(components)) {
                if (!key.startsWith('_ded_')) continue;
                const dedKey = key.replace('_ded_', '');
                const numVal = parseFloat(val) || 0;
                if (numVal > 0) deductions[dedKey] = Math.round(numVal * attendanceRatio);
            }

            const grossEarnings = Object.values(earnings).reduce((s, v) => s + v, 0);
            const totalDeductions = Object.values(deductions).reduce((s, v) => s + v, 0);
            const netPay = grossEarnings - totalDeductions;

            await req.db.query(
                `INSERT INTO salary_slips
                 (org_id, user_id, pay_period_id, compensation_id, slip_month, earnings, deductions,
                  gross_earnings, total_deductions, net_pay, days_worked, days_absent, leave_days,
                  overtime_hours, status, generated_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'draft',$15)
                 ON CONFLICT (org_id, user_id, pay_period_id) DO UPDATE SET
                  earnings = EXCLUDED.earnings, deductions = EXCLUDED.deductions,
                  gross_earnings = EXCLUDED.gross_earnings, total_deductions = EXCLUDED.total_deductions,
                  net_pay = EXCLUDED.net_pay, days_worked = EXCLUDED.days_worked,
                  days_absent = EXCLUDED.days_absent, leave_days = EXCLUDED.leave_days,
                  overtime_hours = EXCLUDED.overtime_hours, updated_at = NOW()`,
                [req.userOrgId, emp.user_id, pay_period_id, emp.id, slipMonth,
                JSON.stringify(earnings), JSON.stringify(deductions),
                    grossEarnings, totalDeductions, netPay,
                attendance.daysWorked, attendance.daysAbsent, attendance.leaveDays,
                attendance.overtimeHours, req.userId]
            );
            generated++;
        }

        logAction(req, 'payroll_run', 'salary_slips', pay_period_id, { generated, period: period.label });
        res.json({ message: `Generated ${generated} salary slips`, count: generated });
    } catch (err) {
        logger.error({ err }, 'Payroll run error');
        res.status(500).json({ error: 'Payroll run failed: ' + err.message });
    }
});

// ==================== SALARY SLIPS ====================

router.get('/salary-slips', requireSameOrg, async (req, res) => {
    try {
        const { pay_period_id, status, user_id } = req.query;
        const isAdmin = ['hr_admin', 'super_admin', 'platform_admin'].includes(req.userRole);

        let query = `SELECT ss.*, u.full_name, u.email, d.name AS department_name,
                            pd.razorpay_payout_id, pd.status AS disbursement_status, pd.utr
                     FROM salary_slips ss
                     JOIN users u ON u.id = ss.user_id
                     LEFT JOIN departments d ON d.id = u.department_id
                     LEFT JOIN payroll_disbursements pd ON pd.salary_slip_id = ss.id
                     WHERE ss.org_id = $1`;
        const params = [req.userOrgId];
        let idx = 2;

        if (!isAdmin) {
            query += ` AND ss.user_id = $${idx} AND ss.status = 'published'`;
            params.push(req.userId);
            idx++;
        } else {
            if (pay_period_id) { query += ` AND ss.pay_period_id = $${idx}`; params.push(pay_period_id); idx++; }
            if (status) { query += ` AND ss.status = $${idx}`; params.push(status); idx++; }
            if (user_id) { query += ` AND ss.user_id = $${idx}`; params.push(user_id); idx++; }
        }
        query += ` ORDER BY ss.slip_month DESC, u.full_name`;
        const result = await req.db.query(query, params);
        res.json(result.rows);
    } catch (err) {
        logger.error({ err }, 'GET salary-slips error');
        res.status(500).json({ error: 'Failed to fetch salary slips' });
    }
});

router.get('/salary-slips/:id', requireSameOrg, async (req, res) => {
    try {
        const slip = (await req.db.query(
            `SELECT ss.*, u.full_name, u.email, u.role, d.name AS department_name, t.name AS team_name
             FROM salary_slips ss
             JOIN users u ON u.id = ss.user_id
             LEFT JOIN departments d ON d.id = u.department_id
             LEFT JOIN teams t ON t.id = u.team_id
             WHERE ss.id = $1 AND ss.org_id = $2`,
            [req.params.id, req.userOrgId]
        )).rows[0];
        if (!slip) return res.status(404).json({ error: 'Salary slip not found' });
        const isAdmin = ['hr_admin', 'super_admin', 'platform_admin'].includes(req.userRole);
        if (!isAdmin && (slip.user_id !== req.userId || slip.status !== 'published')) {
            return res.status(403).json({ error: 'Access denied' });
        }
        res.json(slip);
    } catch (err) {
        logger.error({ err }, 'GET salary-slip detail error');
        res.status(500).json({ error: 'Failed to fetch salary slip' });
    }
});

router.put('/salary-slips/:id/publish', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const result = await req.db.query(
            `UPDATE salary_slips SET status = 'published', published_at = NOW(), updated_at = NOW()
             WHERE id = $1 AND org_id = $2 AND status = 'draft' RETURNING *`,
            [req.params.id, req.userOrgId]
        );
        if (!result.rows[0]) return res.status(404).json({ error: 'Salary slip not found or already published' });
        res.json(result.rows[0]);
    } catch (err) {
        logger.error({ err }, 'Publish salary slip error');
        res.status(500).json({ error: 'Failed to publish salary slip' });
    }
});

router.post('/salary-slips/bulk-publish', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { pay_period_id } = req.body;
        if (!pay_period_id) return res.status(400).json({ error: 'pay_period_id is required' });
        const result = await req.db.query(
            `UPDATE salary_slips SET status = 'published', published_at = NOW(), updated_at = NOW()
             WHERE org_id = $1 AND pay_period_id = $2 AND status = 'draft'`,
            [req.userOrgId, pay_period_id]
        );
        res.json({ message: `Published ${result.rowCount} salary slips`, count: result.rowCount });
    } catch (err) {
        logger.error({ err }, 'Bulk publish error');
        res.status(500).json({ error: 'Failed to publish salary slips' });
    }
});

router.get('/salary-slips/:id/pdf', requireSameOrg, async (req, res) => {
    try {
        const slip = (await req.db.query(
            `SELECT ss.*, u.full_name, u.email, u.role, u.id AS emp_id,
                    d.name AS department_name, t.name AS team_name
             FROM salary_slips ss
             JOIN users u ON u.id = ss.user_id
             LEFT JOIN departments d ON d.id = u.department_id
             LEFT JOIN teams t ON t.id = u.team_id
             WHERE ss.id = $1 AND ss.org_id = $2`,
            [req.params.id, req.userOrgId]
        )).rows[0];
        if (!slip) return res.status(404).json({ error: 'Salary slip not found' });
        const isAdmin = ['hr_admin', 'super_admin', 'platform_admin'].includes(req.userRole);
        if (!isAdmin && (slip.user_id !== req.userId || slip.status !== 'published')) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const org = (await req.db.query(`SELECT * FROM organizations WHERE id = $1`, [req.userOrgId])).rows[0];
        const branding = (await req.db.query(
            `SELECT * FROM org_branding WHERE org_id = $1`, [req.userOrgId]
        )).rows[0];

        // Bank details (masked)
        const bankRow = (await req.db.query(
            `SELECT account_number FROM employee_bank_details WHERE user_id = $1 AND org_id = $2`,
            [slip.user_id, req.userOrgId]
        )).rows[0];
        const bankMasked = bankRow ? maskAccountNumber(decrypt(bankRow.account_number)) : null;

        // YTD data
        const fiscalStart = org?.fiscal_year_start || '04';
        const slipYear = parseInt(slip.slip_month.slice(0, 4));
        const slipMon = parseInt(slip.slip_month.slice(5, 7));
        const fiscalYearStart = slipMon >= parseInt(fiscalStart)
            ? `${slipYear}-${fiscalStart}-01`
            : `${slipYear - 1}-${fiscalStart}-01`;

        const ytdResult = (await req.db.query(
            `SELECT COALESCE(SUM(gross_earnings),0) AS total_gross,
                    COALESCE(SUM(total_deductions),0) AS total_deductions,
                    COALESCE(SUM(net_pay),0) AS total_net
             FROM salary_slips
             WHERE user_id = $1 AND org_id = $2 AND status = 'published'
               AND slip_month >= $3 AND slip_month <= $4`,
            [slip.user_id, req.userOrgId, fiscalYearStart.slice(0, 7), slip.slip_month]
        )).rows[0];

        sendSalarySlipPDF(res, {
            slip: { ...slip, currency: 'INR' },
            employee: { ...slip, bank_masked: bankMasked },
            organization: org,
            branding,
            ytdData: {
                totalGross: parseFloat(ytdResult.total_gross),
                totalDeductions: parseFloat(ytdResult.total_deductions),
                totalNet: parseFloat(ytdResult.total_net),
            },
            filename: `salary_slip_${slip.full_name.replace(/\s+/g, '_')}_${slip.slip_month}.pdf`,
        });
    } catch (err) {
        logger.error({ err }, 'Salary slip PDF error');
        res.status(500).json({ error: 'Failed to generate PDF' });
    }
});

// Employee self-service
router.get('/my-slips', async (req, res) => {
    try {
        const result = await req.db.query(
            `SELECT ss.*, pd.status AS disbursement_status, pd.utr, pd.processed_at AS paid_at
             FROM salary_slips ss
             LEFT JOIN payroll_disbursements pd ON pd.salary_slip_id = ss.id
             WHERE ss.user_id = $1 AND ss.org_id = $2 AND ss.status = 'published'
             ORDER BY ss.slip_month DESC`,
            [req.userId, req.userOrgId]
        );
        res.json(result.rows);
    } catch (err) {
        logger.error({ err }, 'GET my-slips error');
        res.status(500).json({ error: 'Failed to fetch salary slips' });
    }
});

router.get('/my-slips/:id/pdf', async (req, res) => {
    try {
        const slip = (await req.db.query(
            `SELECT ss.*, u.full_name, u.email, u.role,
                    d.name AS department_name, t.name AS team_name
             FROM salary_slips ss
             JOIN users u ON u.id = ss.user_id
             LEFT JOIN departments d ON d.id = u.department_id
             LEFT JOIN teams t ON t.id = u.team_id
             WHERE ss.id = $1 AND ss.user_id = $2 AND ss.status = 'published'`,
            [req.params.id, req.userId]
        )).rows[0];
        if (!slip) return res.status(404).json({ error: 'Salary slip not found' });

        const org = (await req.db.query(`SELECT * FROM organizations WHERE id = $1`, [req.userOrgId])).rows[0];
        const branding = (await req.db.query(
            `SELECT * FROM org_branding WHERE org_id = $1`, [req.userOrgId]
        )).rows[0];
        const bankRow = (await req.db.query(
            `SELECT account_number FROM employee_bank_details WHERE user_id = $1 AND org_id = $2`,
            [req.userId, req.userOrgId]
        )).rows[0];
        const bankMasked = bankRow ? maskAccountNumber(decrypt(bankRow.account_number)) : null;

        sendSalarySlipPDF(res, {
            slip: { ...slip, currency: 'INR' },
            employee: { ...slip, bank_masked: bankMasked },
            organization: org,
            branding,
            ytdData: null,
            filename: `salary_slip_${slip.slip_month}.pdf`,
        });
    } catch (err) {
        logger.error({ err }, 'My salary slip PDF error');
        res.status(500).json({ error: 'Failed to generate PDF' });
    }
});

// ==================== DISBURSEMENT ====================

router.post('/disburse', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { pay_period_id } = req.body;
        if (!pay_period_id) return res.status(400).json({ error: 'pay_period_id is required' });

        const slips = (await req.db.query(
            `SELECT ss.*, ebd.razorpay_fund_account_id
             FROM salary_slips ss
             JOIN employee_bank_details ebd ON ebd.user_id = ss.user_id AND ebd.org_id = ss.org_id
             LEFT JOIN payroll_disbursements pd ON pd.salary_slip_id = ss.id
             WHERE ss.org_id = $1 AND ss.pay_period_id = $2 AND ss.status = 'published'
               AND pd.id IS NULL
               AND ebd.razorpay_fund_account_id IS NOT NULL`,
            [req.userOrgId, pay_period_id]
        )).rows;

        if (slips.length === 0) {
            const totalPublished = (await req.db.query(
                `SELECT COUNT(*) FROM salary_slips WHERE org_id = $1 AND pay_period_id = $2 AND status = 'published'`,
                [req.userOrgId, pay_period_id]
            )).rows[0].count;
            const alreadyDisbursed = (await req.db.query(
                `SELECT COUNT(*) FROM salary_slips ss
                 JOIN payroll_disbursements pd ON pd.salary_slip_id = ss.id
                 WHERE ss.org_id = $1 AND ss.pay_period_id = $2`,
                [req.userOrgId, pay_period_id]
            )).rows[0].count;
            const missingBank = (await req.db.query(
                `SELECT COUNT(*) FROM salary_slips ss
                 LEFT JOIN employee_bank_details ebd ON ebd.user_id = ss.user_id AND ebd.org_id = ss.org_id
                 WHERE ss.org_id = $1 AND ss.pay_period_id = $2 AND ss.status = 'published'
                   AND (ebd.razorpay_fund_account_id IS NULL OR ebd.id IS NULL)`,
                [req.userOrgId, pay_period_id]
            )).rows[0].count;

            let reason = 'No eligible slips for disbursement.';
            if (parseInt(alreadyDisbursed) > 0 && parseInt(missingBank) > 0) {
                reason = `All slips already disbursed (${alreadyDisbursed}) or missing bank details (${missingBank}).`;
            } else if (parseInt(alreadyDisbursed) > 0) {
                reason = `All ${alreadyDisbursed} slip(s) have already been disbursed.`;
            } else if (parseInt(missingBank) > 0) {
                reason = `${missingBank} slip(s) missing bank details. No slips are ready for disbursement.`;
            } else if (parseInt(totalPublished) === 0) {
                reason = 'No published slips found. Publish draft slips before disbursing.';
            }
            return res.status(400).json({ error: reason });
        }

        const payoutService = await getPayoutService(req.db, req.userOrgId);
        let disbursed = 0, failed = 0;

        for (const slip of slips) {
            try {
                const referenceId = `WP-${slip.slip_month}-${String(slip.user_id).padStart(4, '0')}`;
                const payout = await payoutService.createPayout({
                    fundAccountId: slip.razorpay_fund_account_id,
                    amount: parseFloat(slip.net_pay),
                    currency: 'INR',
                    mode: 'NEFT',
                    purpose: 'salary',
                    referenceId,
                    narration: `Salary ${slip.slip_month}`,
                });

                await req.db.query(
                    `INSERT INTO payroll_disbursements
                     (org_id, salary_slip_id, user_id, amount, currency, razorpay_payout_id,
                      razorpay_fund_account_id, transfer_mode, status, initiated_by, initiated_at)
                     VALUES ($1,$2,$3,$4,'INR',$5,$6,'NEFT','processing',$7,NOW())`,
                    [req.userOrgId, slip.id, slip.user_id, slip.net_pay,
                    payout.id, slip.razorpay_fund_account_id, req.userId]
                );
                disbursed++;
            } catch (err) {
                logger.error({ err, slipId: slip.id }, 'Disbursement failed for slip');
                await req.db.query(
                    `INSERT INTO payroll_disbursements
                     (org_id, salary_slip_id, user_id, amount, currency, razorpay_fund_account_id,
                      transfer_mode, status, failure_reason, initiated_by, initiated_at)
                     VALUES ($1,$2,$3,$4,'INR',$5,'NEFT','failed',$6,$7,NOW())
                     ON CONFLICT (salary_slip_id) DO UPDATE SET status = 'failed', failure_reason = EXCLUDED.failure_reason`,
                    [req.userOrgId, slip.id, slip.user_id, slip.net_pay,
                    slip.razorpay_fund_account_id, err.message, req.userId]
                );
                failed++;
            }
        }

        logAction(req, 'disburse', 'payroll_disbursements', pay_period_id, { disbursed, failed });
        res.json({ message: `Disbursement initiated`, disbursed, failed, total: slips.length });
    } catch (err) {
        logger.error({ err }, 'Disburse error');
        res.status(500).json({ error: 'Disbursement failed: ' + err.message });
    }
});

router.post('/disburse/:slipId', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const slip = (await req.db.query(
            `SELECT ss.*, ebd.razorpay_fund_account_id
             FROM salary_slips ss
             JOIN employee_bank_details ebd ON ebd.user_id = ss.user_id AND ebd.org_id = ss.org_id
             WHERE ss.id = $1 AND ss.org_id = $2 AND ss.status = 'published'`,
            [req.params.slipId, req.userOrgId]
        )).rows[0];
        if (!slip) return res.status(404).json({ error: 'Slip not found or not published' });
        if (!slip.razorpay_fund_account_id) return res.status(400).json({ error: 'Employee bank details not registered with Razorpay' });

        const existing = (await req.db.query(
            `SELECT * FROM payroll_disbursements WHERE salary_slip_id = $1 AND status IN ('processing','processed')`,
            [slip.id]
        )).rows[0];
        if (existing) return res.status(400).json({ error: 'Already disbursed or in progress' });

        const payoutService = await getPayoutService(req.db, req.userOrgId);
        const referenceId = `WP-${slip.slip_month}-${String(slip.user_id).padStart(4, '0')}`;
        const payout = await payoutService.createPayout({
            fundAccountId: slip.razorpay_fund_account_id,
            amount: parseFloat(slip.net_pay),
            currency: 'INR',
            mode: 'NEFT',
            purpose: 'salary',
            referenceId,
        });

        await req.db.query(
            `INSERT INTO payroll_disbursements
             (org_id, salary_slip_id, user_id, amount, currency, razorpay_payout_id,
              razorpay_fund_account_id, transfer_mode, status, initiated_by, initiated_at)
             VALUES ($1,$2,$3,$4,'INR',$5,$6,'NEFT','processing',$7,NOW())
             ON CONFLICT (salary_slip_id) DO UPDATE SET
              razorpay_payout_id = EXCLUDED.razorpay_payout_id, status = 'processing',
              failure_reason = NULL, initiated_at = NOW()`,
            [req.userOrgId, slip.id, slip.user_id, slip.net_pay,
            payout.id, slip.razorpay_fund_account_id, req.userId]
        );
        res.json({ message: 'Disbursement initiated', payout_id: payout.id });
    } catch (err) {
        logger.error({ err }, 'Single disburse error');
        res.status(500).json({ error: 'Disbursement failed: ' + err.message });
    }
});

router.get('/disbursements', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { pay_period_id, status } = req.query;
        let query = `SELECT pd.*, u.full_name, ss.slip_month
                     FROM payroll_disbursements pd
                     JOIN users u ON u.id = pd.user_id
                     JOIN salary_slips ss ON ss.id = pd.salary_slip_id
                     WHERE pd.org_id = $1`;
        const params = [req.userOrgId];
        let idx = 2;
        if (pay_period_id) { query += ` AND ss.pay_period_id = $${idx}`; params.push(pay_period_id); idx++; }
        if (status) { query += ` AND pd.status = $${idx}`; params.push(status); idx++; }
        query += ` ORDER BY pd.created_at DESC`;
        res.json((await req.db.query(query, params)).rows);
    } catch (err) {
        logger.error({ err }, 'GET disbursements error');
        res.status(500).json({ error: 'Failed to fetch disbursements' });
    }
});

router.post('/disburse/retry/:id', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const disbursement = (await req.db.query(
            `SELECT pd.*, ebd.razorpay_fund_account_id, ss.net_pay, ss.slip_month, ss.user_id AS emp_user_id
             FROM payroll_disbursements pd
             JOIN salary_slips ss ON ss.id = pd.salary_slip_id
             JOIN employee_bank_details ebd ON ebd.user_id = pd.user_id AND ebd.org_id = pd.org_id
             WHERE pd.id = $1 AND pd.org_id = $2 AND pd.status = 'failed'`,
            [req.params.id, req.userOrgId]
        )).rows[0];
        if (!disbursement) return res.status(404).json({ error: 'Failed disbursement not found' });

        const payoutService = await getPayoutService(req.db, req.userOrgId);
        const referenceId = `WP-${disbursement.slip_month}-${String(disbursement.emp_user_id).padStart(4, '0')}-R`;
        const payout = await payoutService.createPayout({
            fundAccountId: disbursement.razorpay_fund_account_id,
            amount: parseFloat(disbursement.net_pay),
            currency: 'INR',
            mode: 'NEFT',
            purpose: 'salary',
            referenceId,
        });

        await req.db.query(
            `UPDATE payroll_disbursements SET razorpay_payout_id = $1, status = 'processing',
             failure_reason = NULL, initiated_at = NOW() WHERE id = $2`,
            [payout.id, req.params.id]
        );
        res.json({ message: 'Retry initiated', payout_id: payout.id });
    } catch (err) {
        logger.error({ err }, 'Retry disbursement error');
        res.status(500).json({ error: 'Retry failed: ' + err.message });
    }
});

// ==================== PAYMENT CONFIG ====================

router.get('/payment-config', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const config = (await req.db.query(
            `SELECT * FROM org_payment_config WHERE org_id = $1`,
            [req.userOrgId]
        )).rows[0];
        if (!config) return res.json(null);
        res.json({
            ...config,
            api_key_id: config.api_key_id ? '****' + decrypt(config.api_key_id).slice(-4) : null,
            api_key_secret: config.api_key_secret ? '********' : null,
            webhook_secret: config.webhook_secret ? '********' : null,
        });
    } catch (err) {
        logger.error({ err }, 'GET payment-config error');
        res.status(500).json({ error: 'Failed to fetch payment config' });
    }
});

router.put('/payment-config', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { api_key_id, api_key_secret, account_number, webhook_secret, default_transfer_mode, is_active } = req.body;
        if (!api_key_id || !api_key_secret || !account_number) {
            return res.status(400).json({ error: 'api_key_id, api_key_secret, and account_number are required' });
        }
        const encKeyId = encrypt(api_key_id);
        const encKeySecret = encrypt(api_key_secret);
        const encWebhookSecret = webhook_secret ? encrypt(webhook_secret) : null;

        const result = await req.db.query(
            `INSERT INTO org_payment_config (org_id, api_key_id, api_key_secret, account_number, webhook_secret, default_transfer_mode, is_active)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (org_id) DO UPDATE SET
              api_key_id = EXCLUDED.api_key_id, api_key_secret = EXCLUDED.api_key_secret,
              account_number = EXCLUDED.account_number, webhook_secret = COALESCE(EXCLUDED.webhook_secret, org_payment_config.webhook_secret),
              default_transfer_mode = EXCLUDED.default_transfer_mode,
              is_active = EXCLUDED.is_active, updated_at = NOW()
             RETURNING id`,
            [req.userOrgId, encKeyId, encKeySecret, account_number, encWebhookSecret, default_transfer_mode || 'NEFT', is_active !== false]
        );
        logAction(req, 'update', 'org_payment_config', result.rows[0].id);
        res.json({ message: 'Payment configuration saved' });
    } catch (err) {
        logger.error({ err }, 'PUT payment-config error');
        res.status(500).json({ error: 'Failed to save payment config' });
    }
});

router.post('/payment-config/test', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const payoutService = await getPayoutService(req.db, req.userOrgId);
        const result = await payoutService.testConnection();
        res.json({ success: true, balance: result.balance });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// ==================== CTC CONFIG ====================

const CTC_DEFAULTS = { basic_pct: 40, hra_pct: 50, conveyance_pct: 5, pf_pct: 12, pf_max: 1800, pt_fixed: 200 };

router.get('/ctc-config', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const row = (await req.db.query(
            `SELECT * FROM org_ctc_config WHERE org_id = $1`,
            [req.userOrgId]
        )).rows[0];
        res.json(row || { org_id: req.userOrgId, ...CTC_DEFAULTS });
    } catch (err) {
        logger.error({ err }, 'GET ctc-config error');
        res.status(500).json({ error: 'Failed to fetch CTC config' });
    }
});

router.put('/ctc-config', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { basic_pct, hra_pct, conveyance_pct, pf_pct, pf_max, pt_fixed } = req.body;
        const result = await req.db.query(
            `INSERT INTO org_ctc_config (org_id, basic_pct, hra_pct, conveyance_pct, pf_pct, pf_max, pt_fixed, updated_by, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
             ON CONFLICT (org_id) DO UPDATE SET
                 basic_pct = EXCLUDED.basic_pct, hra_pct = EXCLUDED.hra_pct,
                 conveyance_pct = EXCLUDED.conveyance_pct, pf_pct = EXCLUDED.pf_pct,
                 pf_max = EXCLUDED.pf_max, pt_fixed = EXCLUDED.pt_fixed,
                 updated_by = EXCLUDED.updated_by, updated_at = NOW()
             RETURNING *`,
            [req.userOrgId, basic_pct ?? CTC_DEFAULTS.basic_pct, hra_pct ?? CTC_DEFAULTS.hra_pct,
            conveyance_pct ?? CTC_DEFAULTS.conveyance_pct, pf_pct ?? CTC_DEFAULTS.pf_pct,
            pf_max ?? CTC_DEFAULTS.pf_max, pt_fixed ?? CTC_DEFAULTS.pt_fixed, req.userId]
        );
        res.json(result.rows[0]);
    } catch (err) {
        logger.error({ err }, 'PUT ctc-config error');
        res.status(500).json({ error: 'Failed to save CTC config' });
    }
});

// ==================== EMPLOYEE BANK DETAILS ====================

router.get('/bank-details', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const rows = (await req.db.query(
            `SELECT ebd.*, u.full_name, u.email
             FROM employee_bank_details ebd
             JOIN users u ON u.id = ebd.user_id
             WHERE ebd.org_id = $1 ORDER BY u.full_name`,
            [req.userOrgId]
        )).rows;
        const masked = rows.map(r => ({
            ...r,
            account_number: maskAccountNumber(decrypt(r.account_number)),
        }));
        res.json(masked);
    } catch (err) {
        logger.error({ err }, 'GET bank-details error');
        res.status(500).json({ error: 'Failed to fetch bank details' });
    }
});

router.get('/bank-details/:userId', requireSameOrg, async (req, res) => {
    try {
        const isAdmin = ['hr_admin', 'super_admin', 'platform_admin'].includes(req.userRole);
        if (!isAdmin && parseInt(req.params.userId) !== req.userId) {
            return res.status(403).json({ error: 'Access denied' });
        }
        const row = (await req.db.query(
            `SELECT * FROM employee_bank_details WHERE user_id = $1 AND org_id = $2`,
            [req.params.userId, req.userOrgId]
        )).rows[0];
        if (!row) return res.json(null);
        res.json({ ...row, account_number: maskAccountNumber(decrypt(row.account_number)) });
    } catch (err) {
        logger.error({ err }, 'GET bank-details/:userId error');
        res.status(500).json({ error: 'Failed to fetch bank details' });
    }
});

router.post('/bank-details/:userId', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { account_holder_name, account_number, ifsc_code, bank_name, account_type } = req.body;
        if (!account_holder_name || !account_number || !ifsc_code) {
            return res.status(400).json({ error: 'account_holder_name, account_number, and ifsc_code are required' });
        }
        const user = (await req.db.query(
            `SELECT id, full_name, email FROM users WHERE id = $1 AND org_id = $2`,
            [req.params.userId, req.userOrgId]
        )).rows[0];
        if (!user) return res.status(404).json({ error: 'Employee not found' });

        const encAccountNumber = encrypt(account_number);
        let razorpayContactId = null;
        let razorpayFundAccountId = null;

        // Register with Razorpay if payment config is active
        try {
            const payoutService = await getPayoutService(req.db, req.userOrgId);
            const contact = await payoutService.createContact({
                name: account_holder_name,
                email: user.email,
                type: 'employee',
                referenceId: `EMP-${user.id}`,
            });
            razorpayContactId = contact.id;

            const fundAccount = await payoutService.createFundAccount(contact.id, {
                accountNumber: account_number,
                ifsc: ifsc_code,
                name: account_holder_name,
                accountType: account_type || 'savings',
            });
            razorpayFundAccountId = fundAccount.id;
        } catch (err) {
            logger.warn({ err }, 'Razorpay registration failed (will store details without Razorpay link)');
        }

        const result = await req.db.query(
            `INSERT INTO employee_bank_details
             (user_id, org_id, account_holder_name, account_number, ifsc_code, bank_name, account_type,
              razorpay_contact_id, razorpay_fund_account_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (user_id, org_id) DO UPDATE SET
              account_holder_name = EXCLUDED.account_holder_name, account_number = EXCLUDED.account_number,
              ifsc_code = EXCLUDED.ifsc_code, bank_name = EXCLUDED.bank_name, account_type = EXCLUDED.account_type,
              razorpay_contact_id = COALESCE(EXCLUDED.razorpay_contact_id, employee_bank_details.razorpay_contact_id),
              razorpay_fund_account_id = COALESCE(EXCLUDED.razorpay_fund_account_id, employee_bank_details.razorpay_fund_account_id),
              updated_at = NOW()
             RETURNING *`,
            [req.params.userId, req.userOrgId, account_holder_name, encAccountNumber,
                ifsc_code, bank_name || null, account_type || 'savings',
                razorpayContactId, razorpayFundAccountId]
        );
        const saved = result.rows[0];
        logAction(req, 'update', 'employee_bank_details', saved.id, { user_id: req.params.userId });
        res.json({ ...saved, account_number: maskAccountNumber(account_number) });
    } catch (err) {
        logger.error({ err }, 'POST bank-details error');
        res.status(500).json({ error: 'Failed to save bank details' });
    }
});

router.post('/bank-details/:userId/verify', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const bankDetail = (await req.db.query(
            `SELECT * FROM employee_bank_details WHERE user_id = $1 AND org_id = $2`,
            [req.params.userId, req.userOrgId]
        )).rows[0];
        if (!bankDetail) return res.status(404).json({ error: 'Bank details not found' });
        if (!bankDetail.razorpay_fund_account_id) {
            return res.status(400).json({ error: 'Fund account not registered with Razorpay' });
        }

        const payoutService = await getPayoutService(req.db, req.userOrgId);
        await payoutService.validateFundAccount(bankDetail.razorpay_fund_account_id, {});

        await req.db.query(
            `UPDATE employee_bank_details SET is_verified = TRUE, verified_at = NOW() WHERE id = $1`,
            [bankDetail.id]
        );
        res.json({ message: 'Verification initiated (penny drop)' });
    } catch (err) {
        logger.error({ err }, 'Bank verify error');
        res.status(500).json({ error: 'Verification failed: ' + err.message });
    }
});

router.get('/bank-verifications', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const rows = (await req.db.query(
            `SELECT ebd.*, u.full_name, u.email, u.department_id, d.name as department_name
             FROM employee_bank_details ebd
             JOIN users u ON u.id = ebd.user_id
             LEFT JOIN departments d ON d.id = u.department_id
             WHERE ebd.org_id = $1
             ORDER BY ebd.is_verified ASC, ebd.updated_at DESC`,
            [req.userOrgId]
        )).rows;
        res.json(rows.map(r => ({
            ...r,
            account_number: maskAccountNumber(decrypt(r.account_number)),
        })));
    } catch (err) {
        logger.error({ err }, 'GET bank-verifications error');
        res.status(500).json({ error: 'Failed to fetch bank verifications' });
    }
});

router.post('/bank-details/:userId/approve', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const result = await req.db.query(
            `UPDATE employee_bank_details SET is_verified = TRUE, verified_at = NOW()
             WHERE user_id = $1 AND org_id = $2 RETURNING id`,
            [req.params.userId, req.userOrgId]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Bank details not found' });
        res.json({ message: 'Bank details approved' });
    } catch (err) {
        logger.error({ err }, 'POST bank-details approve error');
        res.status(500).json({ error: 'Failed to approve bank details' });
    }
});

router.post('/bank-details/:userId/reject', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const result = await req.db.query(
            `UPDATE employee_bank_details SET is_verified = FALSE, verified_at = NULL
             WHERE user_id = $1 AND org_id = $2 RETURNING id`,
            [req.params.userId, req.userOrgId]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Bank details not found' });
        res.json({ message: 'Bank details rejected' });
    } catch (err) {
        logger.error({ err }, 'POST bank-details reject error');
        res.status(500).json({ error: 'Failed to reject bank details' });
    }
});

router.get('/my-bank-details', async (req, res) => {
    try {
        const row = (await req.db.query(
            `SELECT * FROM employee_bank_details WHERE user_id = $1 AND org_id = $2`,
            [req.userId, req.userOrgId]
        )).rows[0];
        if (!row) return res.json(null);
        res.json({
            ...row,
            account_number: maskAccountNumber(decrypt(row.account_number)),
        });
    } catch (err) {
        logger.error({ err }, 'GET my-bank-details error');
        res.status(500).json({ error: 'Failed to fetch bank details' });
    }
});

router.post('/my-bank-details', async (req, res) => {
    try {
        const { account_holder_name, account_number, ifsc_code, bank_name, account_type } = req.body;
        if (!account_holder_name || !account_number || !ifsc_code) {
            return res.status(400).json({ error: 'account_holder_name, account_number, and ifsc_code are required' });
        }
        const encrypted = encrypt(account_number);
        await req.db.query(
            `INSERT INTO employee_bank_details (user_id, org_id, account_holder_name, account_number, ifsc_code, bank_name, account_type)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (user_id, org_id) DO UPDATE SET
               account_holder_name = EXCLUDED.account_holder_name,
               account_number = EXCLUDED.account_number,
               ifsc_code = EXCLUDED.ifsc_code,
               bank_name = EXCLUDED.bank_name,
               account_type = EXCLUDED.account_type,
               is_verified = false,
               updated_at = NOW()`,
            [req.userId, req.userOrgId, account_holder_name, encrypted, ifsc_code, bank_name || null, account_type || 'savings']
        );
        res.json({ message: 'Bank details saved successfully' });
    } catch (err) {
        logger.error({ err }, 'POST my-bank-details error');
        res.status(500).json({ error: 'Failed to save bank details' });
    }
});

module.exports = router;
