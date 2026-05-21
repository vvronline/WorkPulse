// Acceptance criteria stored as a JSONB array on tasks:
//   [{ id, text, done, doneAt, doneBy }]
//
//   GET /:id/acceptance-criteria
//   PUT /:id/acceptance-criteria  { criteria: [...] }
//
// Bug #12 (Stage 2): we now share a single normaliser with the create/update
// paths so the shape is byte-identical regardless of which endpoint wrote
// the row.

const express = require('express');
const auth = require('../../middleware/auth');
const { loadUserContext } = require('../../middleware/rbac');

const { loadAccessibleTask } = require('./_helpers/access');
const { normalizeAcceptanceCriteria } = require('./_helpers/agile');

const router = express.Router();

router.get('/:id/acceptance-criteria', auth, loadUserContext, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid task id' });
        const task = await loadAccessibleTask(req, res, id);
        if (!task) return;
        res.json({ criteria: task.acceptance_criteria || [] });
    } catch (err) {
        req.log.error({ err }, 'Error fetching criteria');
        res.status(500).json({ error: 'Failed to fetch acceptance criteria' });
    }
});

router.put('/:id/acceptance-criteria', auth, loadUserContext, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid task id' });
        const task = await loadAccessibleTask(req, res, id);
        if (!task) return;
        const { criteria } = req.body || {};
        if (!Array.isArray(criteria)) return res.status(400).json({ error: 'criteria must be an array' });
        // Single source of truth for normalisation (Bug #12).
        const cleaned = normalizeAcceptanceCriteria(criteria) || [];
        await req.db.query(
            'UPDATE tasks SET acceptance_criteria = $1::jsonb WHERE id = $2',
            [JSON.stringify(cleaned), id]
        );
        await req.db.query(
            `INSERT INTO task_history (task_id, action, field, new_value, user_id)
             VALUES ($1, 'updated', 'acceptance_criteria', $2, $3)`,
            [id, `${cleaned.length} item(s)`, req.userId]
        ).catch(() => { });
        res.json({ criteria: cleaned });
    } catch (err) {
        req.log.error({ err }, 'Error updating criteria');
        res.status(500).json({ error: 'Failed to update acceptance criteria' });
    }
});

module.exports = router;