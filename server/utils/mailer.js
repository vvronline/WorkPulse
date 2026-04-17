/**
 * Shared email service — used across all routes.
 * Supports two auth modes (auto-detected from env vars):
 *   1. Gmail OAuth2 (XOAUTH2) — recommended, token-based, no password stored
 *   2. Plain SMTP (username + password / app-password) — simpler fallback
 */
const nodemailer = require('nodemailer');
const { logger } = require('./logger');

let transporter = null;

function getTransporter() {
    if (transporter) return transporter;

    // ── Mode 1: Gmail OAuth2 ────────────────────────────────────────
    if (process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN) {
        transporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 465,
            secure: true,
            auth: {
                type: 'OAuth2',
                user: process.env.SMTP_USER,
                clientId: process.env.GMAIL_CLIENT_ID,
                clientSecret: process.env.GMAIL_CLIENT_SECRET,
                refreshToken: process.env.GMAIL_REFRESH_TOKEN,
            },
        });
        // Verify connection at startup so OAuth errors surface early
        transporter.verify().then(() => {
            logger.info('Email transport: Gmail OAuth2 — verified');
        }).catch(err => {
            logger.error({ err: err.message }, 'Email transport: Gmail OAuth2 — verification FAILED (check refresh token / credentials)');
            transporter = null;
        });
        return transporter;
    }

    // ── Mode 2: Plain SMTP (app-password) ───────────────────────────
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.gmail.com',
            port: Number(process.env.SMTP_PORT) || 587,
            secure: false,
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
        logger.info('Email transport: SMTP (password)');
        return transporter;
    }

    return null;
}

const FROM = () => process.env.SMTP_FROM || (process.env.SMTP_USER ? `"WorkPulse" <${process.env.SMTP_USER}>` : '"WorkPulse" <noreply@workpulse.app>');

/** Escape user-controlled strings before embedding in HTML email templates. */
function esc(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3000;

/**
 * Send an email with automatic retry. Never throws.
 */
function sendMail({ to, subject, html }) {
    const mailer = getTransporter();
    if (!mailer) {
        logger.debug({ to, subject }, 'Email skipped (SMTP not configured)');
        return Promise.resolve(false);
    }
    if (!to || !to.includes('@')) {
        logger.warn({ to, subject }, 'Email skipped — invalid recipient');
        return Promise.resolve(false);
    }

    let attempt = 0;
    return new Promise((resolve) => {
        const trySend = () => {
            attempt++;
            mailer.sendMail({ from: FROM(), to, subject, html }).then(() => {
                logger.info({ to, subject }, 'Email sent successfully');
                resolve(true);
            }).catch(err => {
                if (attempt <= MAX_RETRIES) {
                    logger.warn({ err: err.message, to, subject, attempt }, 'Email send failed — retrying');
                    setTimeout(trySend, RETRY_DELAY_MS * attempt);
                } else {
                    logger.error({ err, to, subject, attempts: attempt }, 'Failed to send email after retries');
                    resolve(false);
                }
            });
        };
        trySend();
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
            <p>Hi <strong>${esc(user.full_name)}</strong>,</p>
            <p>Your <strong>${esc(leave.leave_type)}</strong> leave on <strong>${esc(leave.date)}</strong> has been approved.</p>
        </div>`,
    }),
    leaveRejected: (user, leave, reason) => ({
        to: user.email,
        subject: 'WorkPulse — Leave Rejected',
        html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;">
            <h2 style="color:#ef4444;">Leave Rejected</h2>
            <p>Hi <strong>${esc(user.full_name)}</strong>,</p>
            <p>Your <strong>${esc(leave.leave_type)}</strong> leave on <strong>${esc(leave.date)}</strong> has been rejected.</p>
            ${reason ? `<p><em>Reason: ${esc(reason)}</em></p>` : ''}
        </div>`,
    }),
    leaveRevoked: (user, leave) => ({
        to: user.email,
        subject: 'WorkPulse — Leave Revoked',
        html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;">
            <h2 style="color:#f59e0b;">Leave Revoked</h2>
            <p>Hi <strong>${esc(user.full_name)}</strong>,</p>
            <p>Your <strong>${esc(leave.leave_type)}</strong> leave on <strong>${esc(leave.date)}</strong> has been revoked by management.</p>
        </div>`,
    }),
    taskAssigned: (user, task, assignerName) => ({
        to: user.email,
        subject: `WorkPulse — Task Assigned: ${esc(task.title)}`,
        html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;">
            <h2 style="color:#6366f1;">New Task Assigned</h2>
            <p>Hi <strong>${esc(user.full_name)}</strong>,</p>
            <p><strong>${esc(assignerName)}</strong> assigned you a task:</p>
            <p style="background:#f3f4f6;padding:12px;border-radius:8px;"><strong>${esc(task.title)}</strong></p>
            ${task.due_date ? `<p>Due: ${esc(task.due_date)}</p>` : ''}
        </div>`,
    }),
    mention: (user, commenterName, taskTitle) => ({
        to: user.email,
        subject: `WorkPulse — ${esc(commenterName)} mentioned you`,
        html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;">
            <h2 style="color:#6366f1;">You were mentioned</h2>
            <p>Hi <strong>${esc(user.full_name)}</strong>,</p>
            <p><strong>${esc(commenterName)}</strong> mentioned you in a comment on task: <strong>${esc(taskTitle)}</strong></p>
        </div>`,
    }),
    manualEntryApproved: (user, date) => ({
        to: user.email,
        subject: 'WorkPulse — Manual Entry Approved',
        html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;">
            <h2 style="color:#22c55e;">Manual Entry Approved ✅</h2>
            <p>Hi <strong>${esc(user.full_name)}</strong>,</p>
            <p>Your manual time entry for <strong>${esc(date)}</strong> has been approved.</p>
        </div>`,
    }),
    manualEntryRejected: (user, date, reason) => ({
        to: user.email,
        subject: 'WorkPulse — Manual Entry Rejected',
        html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;">
            <h2 style="color:#ef4444;">Manual Entry Rejected</h2>
            <p>Hi <strong>${esc(user.full_name)}</strong>,</p>
            <p>Your manual time entry for <strong>${esc(date)}</strong> has been rejected.</p>
            ${reason ? `<p><em>Reason: ${esc(reason)}</em></p>` : ''}
        </div>`,
    }),
    meetingScheduled: (user, meeting, organizerName) => ({
        to: user.email,
        subject: `WorkPulse — Meeting Scheduled: ${esc(meeting.title)}`,
        html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;">
            <h2 style="color:#6366f1;">📹 Meeting Scheduled</h2>
            <p>Hi <strong>${esc(user.full_name)}</strong>,</p>
            <p><strong>${esc(organizerName)}</strong> has scheduled a meeting:</p>
            <p style="background:#f3f4f6;padding:12px;border-radius:8px;"><strong>${esc(meeting.title)}</strong></p>
            ${meeting.start_time ? `<p>Start: <strong>${esc(new Date(meeting.start_time).toLocaleString())}</strong></p>` : ''}
            ${meeting.end_time ? `<p>End: <strong>${esc(new Date(meeting.end_time).toLocaleString())}</strong></p>` : ''}
            ${meeting.meeting_code ? `<p>Meeting code: <strong>${esc(meeting.meeting_code)}</strong></p>` : ''}
        </div>`,
    }),
    meetingUpdated: (user, meeting, organizerName) => ({
        to: user.email,
        subject: `WorkPulse — Meeting Updated: ${esc(meeting.title)}`,
        html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;">
            <h2 style="color:#f59e0b;">📹 Meeting Updated</h2>
            <p>Hi <strong>${esc(user.full_name)}</strong>,</p>
            <p><strong>${esc(organizerName)}</strong> has updated the meeting:</p>
            <p style="background:#f3f4f6;padding:12px;border-radius:8px;"><strong>${esc(meeting.title)}</strong></p>
            ${meeting.meeting_code ? `<p>Meeting code: <strong>${esc(meeting.meeting_code)}</strong></p>` : ''}
        </div>`,
    }),
    meetingCancelled: (user, meeting, organizerName) => ({
        to: user.email,
        subject: `WorkPulse — Meeting Cancelled: ${esc(meeting.title)}`,
        html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;">
            <h2 style="color:#ef4444;">📹 Meeting Cancelled</h2>
            <p>Hi <strong>${esc(user.full_name)}</strong>,</p>
            <p><strong>${esc(organizerName)}</strong> has cancelled the meeting:</p>
            <p style="background:#f3f4f6;padding:12px;border-radius:8px;"><strong>${esc(meeting.title)}</strong></p>
            <p>This meeting has been removed from your calendar.</p>
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
