/**
 * Shared email service — used across all routes.
 * Lazy-initializes the SMTP transporter from env vars.
 */
const nodemailer = require('nodemailer');
const { logger } = require('./logger');

let transporter = null;

function getTransporter() {
    if (!transporter && process.env.SMTP_USER && process.env.SMTP_PASS) {
        transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.gmail.com',
            port: Number(process.env.SMTP_PORT) || 587,
            secure: false,
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
    }
    return transporter;
}

const FROM = () => process.env.SMTP_FROM || (process.env.SMTP_USER ? `"WorkPulse" <${process.env.SMTP_USER}>` : '"WorkPulse" <noreply@workpulse.app>');

/**
 * Send an email (fire-and-forget). Never throws.
 */
function sendMail({ to, subject, html }) {
    const mailer = getTransporter();
    if (!mailer) {
        logger.debug({ to, subject }, 'Email skipped (SMTP not configured)');
        return;
    }
    mailer.sendMail({ from: FROM(), to, subject, html }).catch(err => {
        logger.error({ err, to, subject }, 'Failed to send email');
    });
}

/**
 * Send notification emails for common events.
 */
const templates = {
    leaveApproved: (user, leave) => ({
        to: user.email,
        subject: 'WorkPulse — Leave Approved',
        html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;">
            <h2 style="color:#22c55e;">Leave Approved ✅</h2>
            <p>Hi <strong>${user.full_name}</strong>,</p>
            <p>Your <strong>${leave.leave_type}</strong> leave on <strong>${leave.date}</strong> has been approved.</p>
        </div>`,
    }),
    leaveRejected: (user, leave, reason) => ({
        to: user.email,
        subject: 'WorkPulse — Leave Rejected',
        html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;">
            <h2 style="color:#ef4444;">Leave Rejected</h2>
            <p>Hi <strong>${user.full_name}</strong>,</p>
            <p>Your <strong>${leave.leave_type}</strong> leave on <strong>${leave.date}</strong> has been rejected.</p>
            ${reason ? `<p><em>Reason: ${reason}</em></p>` : ''}
        </div>`,
    }),
    leaveRevoked: (user, leave) => ({
        to: user.email,
        subject: 'WorkPulse — Leave Revoked',
        html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;">
            <h2 style="color:#f59e0b;">Leave Revoked</h2>
            <p>Hi <strong>${user.full_name}</strong>,</p>
            <p>Your <strong>${leave.leave_type}</strong> leave on <strong>${leave.date}</strong> has been revoked by management.</p>
        </div>`,
    }),
    taskAssigned: (user, task, assignerName) => ({
        to: user.email,
        subject: `WorkPulse — Task Assigned: ${task.title}`,
        html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;">
            <h2 style="color:#6366f1;">New Task Assigned</h2>
            <p>Hi <strong>${user.full_name}</strong>,</p>
            <p><strong>${assignerName}</strong> assigned you a task:</p>
            <p style="background:#f3f4f6;padding:12px;border-radius:8px;"><strong>${task.title}</strong></p>
            ${task.due_date ? `<p>Due: ${task.due_date}</p>` : ''}
        </div>`,
    }),
    mention: (user, commenterName, taskTitle) => ({
        to: user.email,
        subject: `WorkPulse — ${commenterName} mentioned you`,
        html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;">
            <h2 style="color:#6366f1;">You were mentioned</h2>
            <p>Hi <strong>${user.full_name}</strong>,</p>
            <p><strong>${commenterName}</strong> mentioned you in a comment on task: <strong>${taskTitle}</strong></p>
        </div>`,
    }),
    manualEntryApproved: (user, date) => ({
        to: user.email,
        subject: 'WorkPulse — Manual Entry Approved',
        html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;">
            <h2 style="color:#22c55e;">Manual Entry Approved ✅</h2>
            <p>Hi <strong>${user.full_name}</strong>,</p>
            <p>Your manual time entry for <strong>${date}</strong> has been approved.</p>
        </div>`,
    }),
    manualEntryRejected: (user, date, reason) => ({
        to: user.email,
        subject: 'WorkPulse — Manual Entry Rejected',
        html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;">
            <h2 style="color:#ef4444;">Manual Entry Rejected</h2>
            <p>Hi <strong>${user.full_name}</strong>,</p>
            <p>Your manual time entry for <strong>${date}</strong> has been rejected.</p>
            ${reason ? `<p><em>Reason: ${reason}</em></p>` : ''}
        </div>`,
    }),
};

function notifyByEmail(templateName, ...args) {
    const tpl = templates[templateName];
    if (!tpl) return;
    const mail = tpl(...args);
    if (mail.to) sendMail(mail);
}

module.exports = { getTransporter, sendMail, notifyByEmail };
