// Manager-only CRUD for org task labels.
//   GET    /labels/manage   — list with creator info
//   POST   /labels          — create
//   PUT    /labels/:id      — update
//   DELETE /labels/:id      — delete (cascades label_map entries)

const express = require('express');
const auth = require('../../middleware/auth');
const { loadUserContext, requireRole } = require('../../middleware/rbac');
const { logAction } = require('../../utils/audit');

const router = express.Router();

router.get('/labels/manage', auth, loadUserContext, requireRole('manager'), async (req, res) => {
    try {
        if (!req.userOrgId) return res.json([]);
        const result = await req.db.query(
            'SELECT tl.*, u.username as created_by_username FROM task_labels tl LEFT JOIN users u ON u.id = tl.created_by WHERE tl.org_id = $1 ORDER BY tl.name ASC',
            [req.userOrgId]
        );
        res.json(result.rows);
    } catch (err) {
        req.log.error({ err }, 'Fetch labels error');
        res.status(500).json({ error: 'Failed to fetch labels' });
    }
});

router.post('/labels', auth, loadUserContext, requireRole('manager'), async (req, res) => {
    try {
        if (!req.userOrgId) return res.status(400).json({ error: 'Organization required' });
        const { name, color } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'Label name is required' });
        if (name.trim().length > 30) return res.status(400).json({ error: 'Label name must be 30 characters or less' });
        const existingRes = await req.db.query('SELECT id FROM task_labels WHERE org_id = $1 AND LOWER(name) = LOWER($2)', [req.userOrgId, name.trim()]);
        if (existingRes.rows[0]) return res.status(409).json({ error: 'A label with this name already exists' });
        const validColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#6366f1';
        const result = await req.db.query(
            'INSERT INTO task_labels (org_id, name, color, created_by) VALUES ($1,$2,$3,$4) RETURNING *',
            [req.userOrgId, name.trim(), validColor, req.userId]
        );
        const label = result.rows[0];
        logAction(req, 'create', 'task_label', label.id, { name: label.name });
        res.json(label);
    } catch (err) {
        req.log.error({ err }, 'Create label error');
        res.status(500).json({ error: 'Failed to create label' });
    }
});

router.put('/labels/:id', auth, loadUserContext, requireRole('manager'), async (req, res) => {
    try {
        const labelRes = await req.db.query('SELECT * FROM task_labels WHERE id = $1', [Number(req.params.id)]);
        const label = labelRes.rows[0];
        if (!label) return res.status(404).json({ error: 'Label not found' });
        if (label.org_id !== req.userOrgId) return res.status(403).json({ error: 'Cannot edit labels from another organization' });
        const { name, color } = req.body;
        const newName = name?.trim() || label.name;
        if (newName.length > 30) return res.status(400).json({ error: 'Label name must be 30 characters or less' });
        if (newName.toLowerCase() !== label.name.toLowerCase()) {
            const existingRes = await req.db.query('SELECT id FROM task_labels WHERE org_id = $1 AND LOWER(name) = LOWER($2) AND id != $3', [label.org_id, newName, label.id]);
            if (existingRes.rows[0]) return res.status(409).json({ error: 'A label with this name already exists' });
        }
        const newColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : label.color;
        await req.db.query('UPDATE task_labels SET name = $1, color = $2 WHERE id = $3', [newName, newColor, label.id]);
        const updated = await req.db.query('SELECT * FROM task_labels WHERE id = $1', [label.id]);
        logAction(req, 'update', 'task_label', label.id, { name: newName });
        res.json(updated.rows[0]);
    } catch (err) {
        req.log.error({ err }, 'Update label error');
        res.status(500).json({ error: 'Failed to update label' });
    }
});

router.delete('/labels/:id', auth, loadUserContext, requireRole('manager'), async (req, res) => {
    try {
        const labelRes = await req.db.query('SELECT * FROM task_labels WHERE id = $1', [Number(req.params.id)]);
        const label = labelRes.rows[0];
        if (!label) return res.status(404).json({ error: 'Label not found' });
        if (label.org_id !== req.userOrgId) return res.status(403).json({ error: 'Cannot delete labels from another organization' });
        await req.db.query('DELETE FROM task_label_map WHERE label_id = $1', [label.id]);
        await req.db.query('DELETE FROM task_labels WHERE id = $1', [label.id]);
        logAction(req, 'delete', 'task_label', label.id, { name: label.name });
        res.json({ message: 'Label deleted' });
    } catch (err) {
        req.log.error({ err }, 'Delete label error');
        res.status(500).json({ error: 'Failed to delete label' });
    }
});

module.exports = router;