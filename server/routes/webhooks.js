const express = require('express');
const crypto = require('crypto');
const { logger } = require('../utils/logger');
const { decrypt } = require('../utils/encryption');
const { masterQuery } = require('../db');
const { getTenantPool, listActiveTenants } = require('../utils/tenantManager');

const router = express.Router();

async function runOnAllTenants(sql, params) {
    const tenants = await listActiveTenants();
    for (const t of tenants) {
        try {
            const pool = await getTenantPool(t.db_name, t.db_host);
            await pool.query(sql, params);
        } catch {}
    }
    try { await masterQuery(sql, params); } catch {}
}

async function validateWebhookSignature(body, signature) {
    const tenants = await listActiveTenants();
    for (const t of tenants) {
        try {
            const pool = await getTenantPool(t.db_name, t.db_host);
            const configs = (await pool.query(
                `SELECT webhook_secret FROM org_payment_config WHERE is_active = TRUE AND webhook_secret IS NOT NULL`
            )).rows;
            for (const cfg of configs) {
                const secret = decrypt(cfg.webhook_secret);
                if (!secret) continue;
                const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
                if (expected === signature) return true;
            }
        } catch {}
    }
    // Also check master DB for single-DB setups
    try {
        const configs = (await masterQuery(
            `SELECT webhook_secret FROM org_payment_config WHERE is_active = TRUE AND webhook_secret IS NOT NULL`
        )).rows;
        for (const cfg of configs) {
            const secret = decrypt(cfg.webhook_secret);
            if (!secret) continue;
            const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
            if (expected === signature) return true;
        }
    } catch {}
    return false;
}

router.post('/razorpay', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const signature = req.headers['x-razorpay-signature'];
        if (!signature) return res.status(400).json({ error: 'Missing signature' });

        const body = typeof req.body === 'string' ? req.body : req.body.toString();

        const valid = await validateWebhookSignature(body, signature);
        if (!valid) {
            logger.warn('Razorpay webhook signature mismatch');
            return res.status(401).json({ error: 'Invalid signature' });
        }

        const event = JSON.parse(body);
        const eventType = event.event;
        const payload = event.payload?.payout?.entity;

        if (!payload) {
            return res.status(200).json({ status: 'ignored' });
        }

        const payoutId = payload.id;
        logger.info({ eventType, payoutId }, 'Razorpay webhook received');

        switch (eventType) {
            case 'payout.processed': {
                await runOnAllTenants(
                    `UPDATE payroll_disbursements SET status = 'processed', utr = $1, processed_at = NOW()
                     WHERE razorpay_payout_id = $2`,
                    [payload.utr || null, payoutId]
                );
                break;
            }
            case 'payout.reversed': {
                await runOnAllTenants(
                    `UPDATE payroll_disbursements SET status = 'reversed',
                     failure_reason = $1 WHERE razorpay_payout_id = $2`,
                    [payload.failure_reason || 'Payout reversed', payoutId]
                );
                break;
            }
            case 'payout.failed': {
                await runOnAllTenants(
                    `UPDATE payroll_disbursements SET status = 'failed',
                     failure_reason = $1 WHERE razorpay_payout_id = $2`,
                    [payload.failure_reason || 'Payout failed', payoutId]
                );
                break;
            }
            case 'payout.queued':
            case 'payout.initiated': {
                await runOnAllTenants(
                    `UPDATE payroll_disbursements SET status = 'processing' WHERE razorpay_payout_id = $1`,
                    [payoutId]
                );
                break;
            }
        }

        res.status(200).json({ status: 'ok' });
    } catch (err) {
        logger.error({ err }, 'Razorpay webhook processing error');
        res.status(500).json({ error: 'Internal error' });
    }
});

module.exports = router;

