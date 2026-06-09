import express from "express";
import type { Request, Response } from "express";
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const auth = require("../middleware/auth");
const { loadUserContext } = require("../middleware/rbac");
const { sendToUser } = require("../utils/ws");
const redis = require("../redis");
const { requireTenant, requireFeature } = require("../middleware/tenant");
const { getUploadDir, getUploadUrl } = require("../utils/uploadPath");

const router = express.Router();
router.use(requireTenant, requireFeature("chat"));

interface DbLike {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
    transaction: <T = unknown>(fn: (client: any) => Promise<T>) => Promise<T>;
}

interface UploadedFile {
    mimetype: string;
    filename: string;
    originalname?: string;
    size: number;
    [key: string]: unknown;
}
type MulterCb<T> = (err: Error | null, value?: T) => void;

// Allowlist of safe MIME types → canonical extension
const ALLOWED_TYPES: Record<string, string> = {
    "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif",
    "image/webp": "webp", "image/bmp": "bmp",
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
    "audio/webm": "webm", "audio/mp4": "m4a", "audio/mpeg": "mp3",
    "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav",
    "application/pdf": "pdf",
    "application/zip": "zip", "application/x-zip-compressed": "zip",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/msword": "doc",
    "application/vnd.ms-excel": "xls",
    "text/plain": "txt", "text/csv": "csv",
};

const storage = multer.diskStorage({
    destination: (req: Request, _file: UploadedFile, cb: MulterCb<string>) => {
        try {
            // Per-tenant layout: uploads/tenant_<tid>/org_<oid>/chat/
            // requireTenant guarantees req.tenantId; loadUserContext on the
            // route handler guarantees req.userOrgId.
            const dir = getUploadDir(req.tenantId, req.userOrgId, "chat");
            cb(null, dir);
        } catch (err) {
            cb(err as Error);
        }
    },
    filename: (req: Request, file: UploadedFile, cb: MulterCb<string>) => {
        // Use canonical extension from MIME type — never trust originalname extension
        const ext = ALLOWED_TYPES[file.mimetype] || "bin";
        cb(null, `${req.userId}_${Date.now()}.${ext}`);
    },
});

const chatUpload = multer({
    storage,
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: (_req: Request, file: UploadedFile, cb: MulterCb<boolean>) => {
        if (!ALLOWED_TYPES[file.mimetype]) {
            return cb(new Error("File type not allowed"));
        }
        cb(null, true);
    },
});

// ─── Helper: verify participant ───
async function verifyParticipant(convId: number, userId: number | undefined, db: DbLike): Promise<boolean> {
    const r = await db.query(
        "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
        [convId, userId],
    );
    return r.rows.length > 0;
}

// ─── Helper: get user org ───
async function getUserOrg(userId: number | undefined, db: DbLike): Promise<number | undefined> {
    const r = await db.query("SELECT org_id FROM users WHERE id = $1", [userId]);
    return r.rows[0]?.org_id;
}

/**
 * GET /api/chat/ice-config
 * Returns WebRTC ICE server configuration.
 *
 * Server selection order (see server/utils/coturn.js):
 *   1. Self-hosted coturn with ephemeral HMAC creds (TURN_HOST + TURN_STATIC_AUTH_SECRET)
 *   2. Static TURN creds (TURN_SERVER_URL/USERNAME/CREDENTIAL)
 *   3. Public Metered Open Relay (dev only — set DISABLE_PUBLIC_TURN=true to disable)
 *
 * The response includes an `expiresAt` field (epoch seconds) so the client can
 * refresh credentials before they lapse during long calls.
 */
const { buildIceServers } = require("../utils/coturn");
router.get("/ice-config", auth, async (req: Request, res: Response) => {
    try {
        const { iceServers, ttl, mode, expiresAt } = await buildIceServers(req.userId);
        const payload: Record<string, unknown> = { iceServers, mode };
        // expiresAt is set directly by the Cloudflare path (absolute epoch);
        // for everything else we derive it from the relative ttl.
        if (expiresAt) payload.expiresAt = expiresAt;
        else if (ttl) payload.expiresAt = Math.floor(Date.now() / 1000) + ttl;
        // Prevent caching so each call gets fresh ephemeral creds
        res.set("Cache-Control", "no-store");
        res.json(payload);
    } catch (err) {
        req.log.error({ err }, "ice-config error");
        res.status(500).json({ error: "Failed to build ICE config" });
    }
});

/**
 * GET /api/chat/search?q=term
 */
router.get("/search", auth, async (req: Request, res: Response) => {
    try {
        const { q } = req.query as { q?: string };
        if (!q || q.trim().length < 2) return res.json([]);

        const orgId = await getUserOrg(req.userId, req.db as unknown as DbLike);
        if (!orgId) return res.json([]);

        const term = `%${q.trim().replace(/[%_]/g, (c) => `\\${c}`)}%`;
        // `hidden_from_directory = FALSE` excludes synthetic Platform
        // Inspector users that back the impersonation flow — they live
        // in the same `users` table but must never surface in chat
        // search / @mention pickers / DM-start dialogs.
        const rows = (await req.db!.query(`
            SELECT id, username, full_name, email, avatar, last_seen_at
            FROM users
            WHERE org_id = $1 AND is_active = TRUE
              AND hidden_from_directory = FALSE
              AND (username ILIKE $2 OR full_name ILIKE $2 OR email ILIKE $2)
            ORDER BY
              CASE WHEN id = $3 THEN 0 ELSE 1 END,
              full_name ASC
            LIMIT 20
        `, [orgId, term, req.userId])).rows;

        res.json(rows);
    } catch (err) {
        req.log.error({ err }, "Chat search error");
        res.status(500).json({ error: "Search failed" });
    }
});

/**
 * GET /api/chat/presence?userIds=1,2,3
 *
 * Returns presence + resolved effective status for each user, sourced from
 * StatusService (org-isolated). Kept as a thin v1 alias so the chat
 * conversation-list query has a single bulk endpoint; the underlying data
 * is identical to GET /api/me/status (same resolver output).
 *
 * Response shape (preserved for backwards compatibility):
 *   { [userId]: { presence: 'online'|'offline', userStatus: '<effective>' } }
 */
router.get("/presence", auth, async (req: Request, res: Response) => {
    try {
        const { userIds } = req.query as { userIds?: string };
        if (!userIds) return res.json({});
        const ids = userIds.split(",").map(Number).filter((n) => n > 0);
        if (ids.length === 0) return res.json({});

        // Org isolation — never leak presence across orgs.
        const orgId = await getUserOrg(req.userId, req.db as unknown as DbLike);
        if (!orgId) return res.json({});
        const orgMembers = (await req.db!.query(
            "SELECT id FROM users WHERE id = ANY($1) AND org_id = $2",
            [ids, orgId],
        )).rows.map((r: { id: number }) => r.id);
        const orgMemberSet = new Set(orgMembers);
        const allowedIds = ids.filter((id) => orgMemberSet.has(id));
        if (allowedIds.length === 0) return res.json({});

        const statusService = require("../services/status");
        const payloads = await statusService.getEffectiveBulk(
            { db: req.db, tenantId: req.tenantId || null },
            allowedIds,
        );

        const result: Record<number, { presence: string; userStatus: string }> = {};
        for (const id of allowedIds) {
            const p = payloads[id];
            result[id] = {
                presence: p?.presence || "offline",
                userStatus: p?.effective || "offline",
            };
        }
        res.json(result);
    } catch (err) {
        req.log.error({ err }, "Presence error");
        res.status(500).json({ error: "Failed to get presence" });
    }
});

// PR7: removed legacy `GET /api/chat/status` and `PUT /api/chat/status`.
// The v2 client uses `/api/me/status*` (see server/routes/status.js).

/**
 * POST /api/chat/conversations  { userId }
 */
router.post("/conversations", auth, async (req: Request, res: Response) => {
    try {
        const { userId: otherUserId } = req.body;
        if (!otherUserId) {
            return res.status(400).json({ error: "Invalid user" });
        }

        const isSelfChat = otherUserId === req.userId;

        if (isSelfChat) {
            // Self-chat: verify current user exists and is active
            const selfUser = (await req.db!.query(
                "SELECT id, org_id FROM users WHERE id = $1 AND is_active = TRUE",
                [req.userId],
            )).rows[0];
            if (!selfUser) return res.status(400).json({ error: "User not found" });
            const orgId = selfUser.org_id;

            const conv = await (req.db as unknown as DbLike).transaction(async (client) => {
                // Check inside transaction to prevent duplicate self-chats
                const existing = (await client.query(`
                    SELECT cp.conversation_id
                    FROM conversation_participants cp
                    JOIN conversations c ON c.id = cp.conversation_id
                    WHERE cp.user_id = $1
                      AND c.is_group = FALSE
                      AND (SELECT COUNT(*) FROM conversation_participants WHERE conversation_id = cp.conversation_id) = 1
                    LIMIT 1
                    FOR UPDATE
                `, [req.userId])).rows[0];

                if (existing) return { id: existing.conversation_id, existed: true };

                const c = (await client.query(
                    "INSERT INTO conversations (org_id) VALUES ($1) RETURNING id",
                    [orgId],
                )).rows[0];
                await client.query(
                    "INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2)",
                    [c.id, req.userId],
                );
                return c;
            });

            return res.status(conv.existed ? 200 : 201).json({ conversationId: conv.id });
        }

        const users = (await req.db!.query(
            "SELECT id, org_id FROM users WHERE id = ANY($1) AND is_active = TRUE",
            [[req.userId, otherUserId]],
        )).rows;
        if (users.length !== 2) return res.status(400).json({ error: "User not found" });
        if (users[0].org_id !== users[1].org_id || !users[0].org_id) {
            return res.status(403).json({ error: "Users must be in the same organization" });
        }
        const orgId = users[0].org_id;

        const conv = await (req.db as unknown as DbLike).transaction(async (client) => {
            // Check inside transaction to prevent duplicate 1:1 conversations
            const existing = (await client.query(`
                SELECT cp1.conversation_id
                FROM conversation_participants cp1
                JOIN conversation_participants cp2 ON cp1.conversation_id = cp2.conversation_id
                JOIN conversations c ON c.id = cp1.conversation_id
                WHERE cp1.user_id = $1 AND cp2.user_id = $2
                  AND c.is_group = FALSE
                  AND (SELECT COUNT(*) FROM conversation_participants WHERE conversation_id = cp1.conversation_id) >= 2
                LIMIT 1
                FOR UPDATE
            `, [req.userId, otherUserId])).rows[0];

            if (existing) {
                // Heal corrupted 1:1 chats: remove extra participants
                await client.query(
                    `DELETE FROM conversation_participants
                     WHERE conversation_id = $1 AND user_id NOT IN ($2, $3)`,
                    [existing.conversation_id, req.userId, otherUserId],
                );
                return { id: existing.conversation_id, existed: true };
            }

            const c = (await client.query(
                "INSERT INTO conversations (org_id) VALUES ($1) RETURNING id",
                [orgId],
            )).rows[0];
            await client.query(
                "INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)",
                [c.id, req.userId, otherUserId],
            );
            return c;
        });

        if (conv.existed) {
            return res.json({ conversationId: conv.id });
        }

        res.status(201).json({ conversationId: conv.id });
    } catch (err) {
        req.log.error({ err }, "Create conversation error");
        res.status(500).json({ error: "Failed to create conversation" });
    }
});

/**
 * POST /api/chat/conversations/group  { name, userIds: [id, ...] }
 */
router.post("/conversations/group", auth, async (req: Request, res: Response) => {
    try {
        const { name, userIds } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: "Group name is required" });
        if (!Array.isArray(userIds) || userIds.length < 1) {
            return res.status(400).json({ error: "At least one other user is required" });
        }

        const allIds = [...new Set([req.userId, ...userIds.map(Number)])];
        const orgId = await getUserOrg(req.userId, req.db as unknown as DbLike);
        if (!orgId) return res.status(400).json({ error: "No organization" });

        const users = (await req.db!.query(
            "SELECT id FROM users WHERE id = ANY($1) AND org_id = $2 AND is_active = TRUE",
            [allIds, orgId],
        )).rows;
        if (users.length !== allIds.length) {
            return res.status(400).json({ error: "Some users not found in your organization" });
        }

        const conv = await (req.db as unknown as DbLike).transaction(async (client) => {
            const c = (await client.query(
                "INSERT INTO conversations (org_id, name, is_group, created_by) VALUES ($1, $2, TRUE, $3) RETURNING id",
                [orgId, name.trim().slice(0, 100), req.userId],
            )).rows[0];
            const values = allIds.map((_uid, i) => `($1, $${i + 2})`).join(", ");
            await client.query(
                `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ${values}`,
                [c.id, ...allIds],
            );
            return c;
        });

        for (const uid of allIds) {
            if (uid !== req.userId) {
                sendToUser(req.tenantId, uid, "chat_group_created", { conversationId: conv.id, name: name.trim() });
            }
        }

        res.status(201).json({ conversationId: conv.id });
    } catch (err) {
        req.log.error({ err }, "Create group error");
        res.status(500).json({ error: "Failed to create group" });
    }
});

/**
 * PUT /api/chat/conversations/:id/group  { name?, addUserIds?, removeUserIds? }
 */
router.put("/conversations/:id/group", auth, async (req: Request, res: Response) => {
    try {
        const convId = parseInt(String(req.params.id), 10);
        if (isNaN(convId)) return res.status(400).json({ error: "Invalid conversation" });

        const conv = (await req.db!.query("SELECT * FROM conversations WHERE id = $1 AND is_group = TRUE", [convId])).rows[0];
        if (!conv) return res.status(404).json({ error: "Group not found" });
        if (!(await verifyParticipant(convId, req.userId, req.db as unknown as DbLike))) {
            return res.status(403).json({ error: "Not a participant" });
        }

        const { name, addUserIds, removeUserIds } = req.body;

        if (name !== undefined) {
            await req.db!.query("UPDATE conversations SET name = $1 WHERE id = $2", [name.trim().slice(0, 100), convId]);
        }

        if (Array.isArray(addUserIds) && addUserIds.length > 0) {
            const valid = (await req.db!.query(
                "SELECT id FROM users WHERE id = ANY($1) AND org_id = $2 AND is_active = TRUE",
                [addUserIds, conv.org_id],
            )).rows.map((r: { id: number }) => r.id);
            for (const uid of valid) {
                await req.db!.query(
                    "INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                    [convId, uid],
                );
                sendToUser(req.tenantId, uid, "chat_group_added", { conversationId: convId });
            }
        }

        if (Array.isArray(removeUserIds) && removeUserIds.length > 0) {
            // Only remove users who are actually participants in this conversation
            const validRemoveIds = (await req.db!.query(
                `SELECT u.id FROM users u
                 JOIN conversation_participants cp ON cp.user_id = u.id AND cp.conversation_id = $3
                 WHERE u.id = ANY($1) AND u.org_id = $2 AND u.is_active = TRUE`,
                [removeUserIds, conv.org_id, convId],
            )).rows.map((r: { id: number }) => r.id);

            for (const uid of validRemoveIds) {
                if (uid === req.userId) continue;
                await req.db!.query(
                    "DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
                    [convId, uid],
                );
                sendToUser(req.tenantId, uid, "chat_group_removed", { conversationId: convId });
            }
        }

        res.json({ ok: true });
    } catch (err) {
        req.log.error({ err }, "Update group error");
        res.status(500).json({ error: "Failed to update group" });
    }
});

/**
 * GET /api/chat/conversations/:id/members
 */
router.get("/conversations/:id/members", auth, async (req: Request, res: Response) => {
    try {
        const convId = parseInt(String(req.params.id), 10);
        if (isNaN(convId)) return res.status(400).json({ error: "Invalid conversation" });
        if (!(await verifyParticipant(convId, req.userId, req.db as unknown as DbLike))) {
            return res.status(403).json({ error: "Not a participant" });
        }

        const rows = (await req.db!.query(`
            SELECT u.id, u.username, u.full_name, u.avatar, u.last_seen_at
            FROM conversation_participants cp
            JOIN users u ON u.id = cp.user_id
            WHERE cp.conversation_id = $1
            ORDER BY u.full_name
        `, [convId])).rows;

        res.json(rows);
    } catch (err) {
        req.log.error({ err }, "Get members error");
        res.status(500).json({ error: "Failed to get members" });
    }
});

/**
 * GET /api/chat/conversations
 */
router.get("/conversations", auth, async (req: Request, res: Response) => {
    try {
        const rows = (await req.db!.query(`
            SELECT
                c.id,
                c.updated_at,
                c.name AS group_name,
                c.is_group,
                CASE WHEN c.is_group = FALSE THEN COALESCE(u.id, self_u.id) END        AS other_user_id,
                CASE WHEN c.is_group = FALSE THEN COALESCE(u.username, self_u.username) END   AS other_username,
                CASE WHEN c.is_group = FALSE THEN COALESCE(u.full_name, self_u.full_name) END  AS other_full_name,
                CASE WHEN c.is_group = FALSE THEN COALESCE(u.avatar, self_u.avatar) END     AS other_avatar,
                CASE WHEN c.is_group = FALSE THEN COALESCE(u.last_seen_at, self_u.last_seen_at) END AS other_last_seen,
                CASE WHEN c.is_group = FALSE AND u.id IS NULL THEN TRUE ELSE FALSE END AS is_self_chat,
                m.content   AS last_message,
                m.sender_id AS last_sender_id,
                m.sender_name AS last_sender_name,
                m.created_at AS last_message_at,
                m.file_url  AS last_file_url,
                m.deleted_at AS last_deleted,
                COALESCE(mr.last_read_at, '1970-01-01'::timestamptz) AS last_read_at,
                (SELECT COUNT(*)::int FROM messages msg
                 WHERE msg.conversation_id = c.id
                   AND msg.created_at > COALESCE(mr.last_read_at, '1970-01-01'::timestamptz)
                   AND msg.sender_id != $1
                   AND msg.deleted_at IS NULL
                ) AS unread_count,
                CASE WHEN c.is_group THEN
                    (SELECT COUNT(*)::int FROM conversation_participants WHERE conversation_id = c.id)
                END AS member_count,
                cp.is_pinned,
                cp.is_favourite,
                CASE WHEN mtg.id IS NOT NULL THEN TRUE ELSE FALSE END AS is_meeting_chat,
                mtg.meeting_code
            FROM conversations c
            JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = $1
            LEFT JOIN conversation_participants cp2
                ON cp2.conversation_id = c.id AND cp2.user_id != $1 AND c.is_group = FALSE
            LEFT JOIN users u ON u.id = cp2.user_id AND c.is_group = FALSE
            LEFT JOIN users self_u ON self_u.id = $1 AND c.is_group = FALSE AND cp2.user_id IS NULL
            LEFT JOIN meetings mtg ON mtg.conversation_id = c.id
            LEFT JOIN LATERAL (
                SELECT lm.content, lm.sender_id, lm.created_at, lm.file_url, lm.deleted_at, usr.full_name AS sender_name
                FROM messages lm
                JOIN users usr ON usr.id = lm.sender_id
                WHERE lm.conversation_id = c.id
                ORDER BY lm.created_at DESC LIMIT 1
            ) m ON TRUE
            LEFT JOIN message_reads mr ON mr.conversation_id = c.id AND mr.user_id = $1
            ORDER BY cp.is_pinned DESC, COALESCE(m.created_at, c.created_at) DESC
            LIMIT 200
        `, [req.userId])).rows;

        // Overlay Redis unread counts if available (faster than the SQL subquery)
        if (rows.length > 0) {
            const convIds = rows.map((r: { id: number }) => r.id);
            const redisCounts = await redis.getUnreadCounts(req.tenantId, req.userId, convIds);
            if (redisCounts) {
                for (const row of rows) {
                    row.unread_count = redisCounts[row.id] ?? row.unread_count;
                }
            }
        }

        res.json(rows);
    } catch (err) {
        req.log.error({ err }, "List conversations error");
        res.status(500).json({ error: "Failed to list conversations" });
    }
});

/**
 * GET /api/chat/conversations/:id/messages?before=id&limit=50
 */
router.get("/conversations/:id/messages", auth, async (req: Request, res: Response) => {
    try {
        const convId = parseInt(String(req.params.id), 10);
        if (isNaN(convId)) return res.status(400).json({ error: "Invalid conversation" });

        if (!(await verifyParticipant(convId, req.userId, req.db as unknown as DbLike))) {
            return res.status(403).json({ error: "Not a participant" });
        }

        const limit = Math.min(parseInt(String(req.query.limit), 10) || 50, 100);
        const before = parseInt(String(req.query.before), 10) || null;

        let sql = `
            SELECT m.id, m.sender_id, m.content, m.created_at,
                   m.reply_to_id, m.file_url, m.file_name, m.file_type, m.file_size,
                   m.edited_at, m.deleted_at, m.forwarded_from_id,
                   m.pinned_at, m.pinned_by,
                   m.format_type, m.metadata, m.delivered_to,
                   u.full_name AS sender_name, u.avatar AS sender_avatar, u.username AS sender_username,
                   rm.content AS reply_content, rm.sender_id AS reply_sender_id,
                   ru.full_name AS reply_sender_name,
                   CASE WHEN sm.message_id IS NOT NULL THEN true ELSE false END AS starred
            FROM messages m
            JOIN users u ON u.id = m.sender_id
            LEFT JOIN messages rm ON rm.id = m.reply_to_id
            LEFT JOIN users ru ON ru.id = rm.sender_id
            LEFT JOIN starred_messages sm ON sm.message_id = m.id AND sm.user_id = $1
            WHERE m.conversation_id = $2
        `;
        const params: unknown[] = [req.userId, convId];

        if (before) {
            sql += ` AND m.id < $${params.length + 1}`;
            params.push(before);
        }

        sql += ` ORDER BY m.created_at DESC LIMIT $${params.length + 1}`;
        params.push(limit);

        const rows = (await req.db!.query(sql, params)).rows;

        // Fetch reactions for these messages
        if (rows.length > 0) {
            const msgIds = rows.map((r: { id: number }) => r.id);
            const reactions = (await req.db!.query(`
                SELECT mr.message_id, mr.emoji, mr.user_id, u.full_name
                FROM message_reactions mr
                JOIN users u ON u.id = mr.user_id
                WHERE mr.message_id = ANY($1)
                ORDER BY mr.created_at
            `, [msgIds])).rows;

            const reactionMap: Record<number, Array<{ emoji: string; userId: number; fullName: string }>> = {};
            for (const r of reactions) {
                if (!reactionMap[r.message_id]) reactionMap[r.message_id] = [];
                reactionMap[r.message_id].push({ emoji: r.emoji, userId: r.user_id, fullName: r.full_name });
            }
            for (const row of rows) {
                row.reactions = reactionMap[row.id] || [];
            }
        }

        res.json(rows.reverse());
    } catch (err) {
        req.log.error({ err }, "Get messages error");
        res.status(500).json({ error: "Failed to get messages" });
    }
});

/**
 * POST /api/chat/conversations/:id/read
 */
router.post("/conversations/:id/read", auth, async (req: Request, res: Response) => {
    try {
        const convId = parseInt(String(req.params.id), 10);
        if (isNaN(convId)) return res.status(400).json({ error: "Invalid conversation" });

        if (!(await verifyParticipant(convId, req.userId, req.db as unknown as DbLike))) {
            return res.status(403).json({ error: "Not a participant" });
        }

        await req.db!.query(
            `INSERT INTO message_reads (conversation_id, user_id, last_read_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = NOW()`,
            [convId, req.userId],
        );
        redis.resetUnread(req.tenantId, req.userId, convId);

        // Notify others about read receipt
        const participants = (await req.db!.query(
            "SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2",
            [convId, req.userId],
        )).rows;
        for (const p of participants) {
            sendToUser(req.tenantId, p.user_id, "chat_read_receipt", {
                conversationId: convId,
                userId: req.userId,
                readAt: new Date().toISOString(),
            });
        }

        res.json({ ok: true });
    } catch (err) {
        req.log.error({ err }, "Mark read error");
        res.status(500).json({ error: "Failed to mark as read" });
    }
});

/**
 * GET /api/chat/conversations/:id/read-status
 */
router.get("/conversations/:id/read-status", auth, async (req: Request, res: Response) => {
    try {
        const convId = parseInt(String(req.params.id), 10);
        if (isNaN(convId)) return res.status(400).json({ error: "Invalid conversation" });
        if (!(await verifyParticipant(convId, req.userId, req.db as unknown as DbLike))) {
            return res.status(403).json({ error: "Not a participant" });
        }

        const rows = (await req.db!.query(`
            SELECT mr.user_id, mr.last_read_at, u.full_name
            FROM message_reads mr
            JOIN users u ON u.id = mr.user_id
            WHERE mr.conversation_id = $1 AND mr.user_id != $2
        `, [convId, req.userId])).rows;

        res.json(rows);
    } catch (err) {
        req.log.error({ err }, "Read status error");
        res.status(500).json({ error: "Failed to get read status" });
    }
});

/**
 * POST /api/chat/conversations/:id/files
 */
router.post("/conversations/:id/files", auth, loadUserContext, chatUpload.single("file"), async (req: Request, res: Response) => {
    try {
        const convId = parseInt(String(req.params.id), 10);
        if (isNaN(convId)) return res.status(400).json({ error: "Invalid conversation" });

        if (!(await verifyParticipant(convId, req.userId, req.db as unknown as DbLike))) {
            return res.status(403).json({ error: "Not a participant" });
        }

        if (!req.file) return res.status(400).json({ error: "No file uploaded" });

        // Sanitize the display name: strip control chars, path separators, limit length
        const safeName = (req.file.originalname || "file")
            .replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, "")   // strip control characters
            .replace(/[/\\]/g, "_")                         // no path separators
            .slice(0, 255) || "file";

        const fileUrl = getUploadUrl(req.tenantId, req.userOrgId, "chat", req.file.filename);
        const content = req.body.content || null;
        const replyToId = req.body.replyToId ? parseInt(req.body.replyToId, 10) : null;

        const result = (await req.db!.query(
            `INSERT INTO messages (conversation_id, sender_id, content, file_url, file_name, file_type, file_size, reply_to_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
            [convId, req.userId, content, fileUrl, safeName, req.file.mimetype, req.file.size, replyToId],
        )).rows[0];

        await req.db!.query("UPDATE conversations SET updated_at = NOW() WHERE id = $1", [convId]);
        await req.db!.query(
            `INSERT INTO message_reads (conversation_id, user_id, last_read_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = $3`,
            [convId, req.userId, result.created_at],
        );

        const sender = (await req.db!.query("SELECT full_name, avatar, username FROM users WHERE id = $1", [req.userId])).rows[0];

        const participants = (await req.db!.query(
            "SELECT user_id FROM conversation_participants WHERE conversation_id = $1",
            [convId],
        )).rows;

        const outMsg = {
            id: result.id,
            conversationId: convId,
            senderId: req.userId,
            senderName: sender.full_name,
            senderAvatar: sender.avatar,
            senderUsername: sender.username,
            content,
            fileUrl,
            fileName: safeName,
            fileType: req.file.mimetype,
            fileSize: req.file.size,
            replyToId,
            createdAt: result.created_at,
        };

        for (const p of participants) {
            sendToUser(req.tenantId, p.user_id, "chat_message", outMsg);
            if (p.user_id !== req.userId) {
                redis.incrUnread(req.tenantId, p.user_id, convId);
            }
        }

        res.status(201).json(outMsg);
    } catch (err) {
        req.log.error({ err }, "File upload error");
        res.status(500).json({ error: "Failed to upload file" });
    }
});

/**
 * POST /api/chat/messages/:id/reactions  { emoji }
 */
router.post("/messages/:id/reactions", auth, async (req: Request, res: Response) => {
    try {
        const msgId = parseInt(String(req.params.id), 10);
        if (isNaN(msgId)) return res.status(400).json({ error: "Invalid message" });

        const { emoji } = req.body;
        if (!emoji || emoji.length > 20) return res.status(400).json({ error: "Invalid emoji" });

        const msg = (await req.db!.query("SELECT conversation_id FROM messages WHERE id = $1", [msgId])).rows[0];
        if (!msg) return res.status(404).json({ error: "Message not found" });
        if (!(await verifyParticipant(msg.conversation_id, req.userId, req.db as unknown as DbLike))) {
            return res.status(403).json({ error: "Not a participant" });
        }

        const existing = (await req.db!.query(
            "SELECT id FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3",
            [msgId, req.userId, emoji],
        )).rows[0];

        let action;
        if (existing) {
            await req.db!.query("DELETE FROM message_reactions WHERE id = $1", [existing.id]);
            action = "removed";
        } else {
            await req.db!.query(
                "INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT (message_id, user_id, emoji) DO NOTHING",
                [msgId, req.userId, emoji],
            );
            action = "added";
        }

        const sender = (await req.db!.query("SELECT full_name FROM users WHERE id = $1", [req.userId])).rows[0];

        const participants = (await req.db!.query(
            "SELECT user_id FROM conversation_participants WHERE conversation_id = $1",
            [msg.conversation_id],
        )).rows;

        for (const p of participants) {
            sendToUser(req.tenantId, p.user_id, "chat_reaction", {
                messageId: msgId,
                conversationId: msg.conversation_id,
                userId: req.userId,
                fullName: sender.full_name,
                emoji,
                action,
            });
        }

        res.json({ ok: true, action });
    } catch (err) {
        req.log.error({ err }, "Reaction error");
        res.status(500).json({ error: "Failed to toggle reaction" });
    }
});

/**
 * PUT /api/chat/messages/:id  { content }
 */
router.put("/messages/:id", auth, async (req: Request, res: Response) => {
    try {
        const msgId = parseInt(String(req.params.id), 10);
        if (isNaN(msgId)) return res.status(400).json({ error: "Invalid message" });

        const { content } = req.body;
        if (!content || typeof content !== "string" || content.trim().length === 0 || content.length > 5000) {
            return res.status(400).json({ error: "Invalid content" });
        }

        const msg = (await req.db!.query("SELECT * FROM messages WHERE id = $1", [msgId])).rows[0];
        if (!msg) return res.status(404).json({ error: "Message not found" });
        if (msg.sender_id !== req.userId) return res.status(403).json({ error: "Can only edit own messages" });
        if (msg.deleted_at) return res.status(400).json({ error: "Message is deleted" });

        await req.db!.query("UPDATE messages SET content = $1, edited_at = NOW() WHERE id = $2", [content.trim(), msgId]);

        const participants = (await req.db!.query(
            "SELECT user_id FROM conversation_participants WHERE conversation_id = $1",
            [msg.conversation_id],
        )).rows;

        for (const p of participants) {
            sendToUser(req.tenantId, p.user_id, "chat_edit", {
                messageId: msgId,
                conversationId: msg.conversation_id,
                content: content.trim(),
                editedAt: new Date().toISOString(),
            });
        }

        res.json({ ok: true });
    } catch (err) {
        req.log.error({ err }, "Edit message error");
        res.status(500).json({ error: "Failed to edit message" });
    }
});

/**
 * DELETE /api/chat/messages/:id
 */
router.delete("/messages/:id", auth, async (req: Request, res: Response) => {
    try {
        const msgId = parseInt(String(req.params.id), 10);
        if (isNaN(msgId)) return res.status(400).json({ error: "Invalid message" });

        const msg = (await req.db!.query("SELECT * FROM messages WHERE id = $1", [msgId])).rows[0];
        if (!msg) return res.status(404).json({ error: "Message not found" });
        if (msg.sender_id !== req.userId) return res.status(403).json({ error: "Can only delete own messages" });
        if (msg.deleted_at) return res.status(400).json({ error: "Already deleted" });

        await req.db!.query("UPDATE messages SET deleted_at = NOW(), content = NULL, file_url = NULL WHERE id = $1", [msgId]);

        const participants = (await req.db!.query(
            "SELECT user_id FROM conversation_participants WHERE conversation_id = $1",
            [msg.conversation_id],
        )).rows;

        for (const p of participants) {
            sendToUser(req.tenantId, p.user_id, "chat_delete", {
                messageId: msgId,
                conversationId: msg.conversation_id,
            });
        }

        if (msg.file_url) {
            const filePath = path.join(__dirname, "..", msg.file_url);
            const resolved = path.resolve(filePath);
            if (resolved.startsWith(path.resolve(__dirname, "..", "uploads"))) {
                fs.unlink(resolved, () => { });
            }
        }

        res.json({ ok: true });
    } catch (err) {
        req.log.error({ err }, "Delete message error");
        res.status(500).json({ error: "Failed to delete message" });
    }
});

/**
 * POST /api/chat/messages/:id/pin
 */
router.post("/messages/:id/pin", auth, async (req: Request, res: Response) => {
    try {
        const msgId = parseInt(String(req.params.id), 10);
        if (isNaN(msgId)) return res.status(400).json({ error: "Invalid message" });

        const msg = (await req.db!.query("SELECT * FROM messages WHERE id = $1", [msgId])).rows[0];
        if (!msg) return res.status(404).json({ error: "Message not found" });
        if (!(await verifyParticipant(msg.conversation_id, req.userId, req.db as unknown as DbLike))) {
            return res.status(403).json({ error: "Not a participant" });
        }

        const isPinned = !!msg.pinned_at;
        if (isPinned) {
            await req.db!.query("UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = $1", [msgId]);
        } else {
            await req.db!.query("UPDATE messages SET pinned_at = NOW(), pinned_by = $1 WHERE id = $2", [req.userId, msgId]);
        }

        const participants = (await req.db!.query(
            "SELECT user_id FROM conversation_participants WHERE conversation_id = $1",
            [msg.conversation_id],
        )).rows;

        const sender = (await req.db!.query("SELECT full_name FROM users WHERE id = $1", [req.userId])).rows[0];

        for (const p of participants) {
            sendToUser(req.tenantId, p.user_id, "chat_pin", {
                messageId: msgId,
                conversationId: msg.conversation_id,
                pinned: !isPinned,
                pinnedBy: req.userId,
                pinnedByName: sender.full_name,
            });
        }

        res.json({ ok: true, pinned: !isPinned });
    } catch (err) {
        req.log.error({ err }, "Pin message error");
        res.status(500).json({ error: "Failed to pin message" });
    }
});

/**
 * GET /api/chat/conversations/:id/pinned
 */
router.get("/conversations/:id/pinned", auth, async (req: Request, res: Response) => {
    try {
        const convId = parseInt(String(req.params.id), 10);
        if (isNaN(convId)) return res.status(400).json({ error: "Invalid conversation" });
        if (!(await verifyParticipant(convId, req.userId, req.db as unknown as DbLike))) {
            return res.status(403).json({ error: "Not a participant" });
        }

        const rows = (await req.db!.query(`
            SELECT m.id, m.sender_id, m.content, m.created_at, m.pinned_at, m.pinned_by,
                   m.file_url, m.file_name, m.file_type,
                   u.full_name AS sender_name, u.avatar AS sender_avatar,
                   pb.full_name AS pinned_by_name
            FROM messages m
            JOIN users u ON u.id = m.sender_id
            LEFT JOIN users pb ON pb.id = m.pinned_by
            WHERE m.conversation_id = $1 AND m.pinned_at IS NOT NULL AND m.deleted_at IS NULL
            ORDER BY m.pinned_at DESC
        `, [convId])).rows;

        res.json(rows);
    } catch (err) {
        req.log.error({ err }, "Get pinned error");
        res.status(500).json({ error: "Failed to get pinned messages" });
    }
});

/**
 * GET /api/chat/search-messages?q=term&convId=id
 */
router.get("/search-messages", auth, async (req: Request, res: Response) => {
    try {
        const { q, convId } = req.query as { q?: string; convId?: string };
        if (!q || q.trim().length < 2) return res.json([]);

        const orgId = await getUserOrg(req.userId, req.db as unknown as DbLike);
        if (!orgId) return res.json([]);

        const searchPattern = `%${q.trim().replace(/[%_]/g, (c) => `\\${c}`)}%`;
        let sql; let params;

        if (convId) {
            const cId = parseInt(convId, 10);
            if (isNaN(cId)) return res.status(400).json({ error: "Invalid conversation" });
            if (!(await verifyParticipant(cId, req.userId, req.db as unknown as DbLike))) {
                return res.status(403).json({ error: "Not a participant" });
            }

            sql = `
                SELECT m.id, m.conversation_id, m.sender_id, m.content, m.created_at,
                       m.file_url, m.file_name,
                       u.full_name AS sender_name, u.avatar AS sender_avatar
                FROM messages m
                JOIN users u ON u.id = m.sender_id
                WHERE m.conversation_id = $1 AND m.deleted_at IS NULL
                  AND COALESCE(m.content, '') ILIKE $2
                ORDER BY m.created_at DESC
                LIMIT 50
            `;
            params = [cId, searchPattern];
        } else {
            sql = `
                SELECT m.id, m.conversation_id, m.sender_id, m.content, m.created_at,
                       m.file_url, m.file_name,
                       u.full_name AS sender_name, u.avatar AS sender_avatar,
                       c.name AS group_name, c.is_group
                FROM messages m
                JOIN users u ON u.id = m.sender_id
                JOIN conversations c ON c.id = m.conversation_id
                JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = $1
                WHERE m.deleted_at IS NULL
                  AND COALESCE(m.content, '') ILIKE $2
                ORDER BY m.created_at DESC
                LIMIT 50
            `;
            params = [req.userId, searchPattern];
        }

        const rows = (await req.db!.query(sql, params)).rows;
        res.json(rows);
    } catch (err) {
        req.log.error({ err }, "Search messages error");
        res.status(500).json({ error: "Search failed" });
    }
});

/**
 * POST /api/chat/messages/:id/forward  { conversationIds: [id, ...] }
 */
router.post("/messages/:id/forward", auth, async (req: Request, res: Response) => {
    try {
        const msgId = parseInt(String(req.params.id), 10);
        if (isNaN(msgId)) return res.status(400).json({ error: "Invalid message" });

        const { conversationIds } = req.body;
        if (!Array.isArray(conversationIds) || conversationIds.length === 0) {
            return res.status(400).json({ error: "No conversations selected" });
        }
        if (conversationIds.length > 20) {
            return res.status(400).json({ error: "Cannot forward to more than 20 conversations at once" });
        }

        const original = (await req.db!.query(
            "SELECT * FROM messages WHERE id = $1 AND deleted_at IS NULL",
            [msgId],
        )).rows[0];
        if (!original) return res.status(404).json({ error: "Message not found" });
        if (!(await verifyParticipant(original.conversation_id, req.userId, req.db as unknown as DbLike))) {
            return res.status(403).json({ error: "Not a participant" });
        }

        const sender = (await req.db!.query("SELECT full_name, avatar, username FROM users WHERE id = $1", [req.userId])).rows[0];

        for (const cId of conversationIds) {
            const convIdNum = parseInt(cId, 10);
            if (isNaN(convIdNum)) continue;
            if (!(await verifyParticipant(convIdNum, req.userId, req.db as unknown as DbLike))) continue;

            const result = (await req.db!.query(
                `INSERT INTO messages (conversation_id, sender_id, content, file_url, file_name, file_type, file_size, forwarded_from_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
                [convIdNum, req.userId, original.content, original.file_url, original.file_name, original.file_type, original.file_size, msgId],
            )).rows[0];

            await req.db!.query("UPDATE conversations SET updated_at = NOW() WHERE id = $1", [convIdNum]);

            await req.db!.query(
                `INSERT INTO message_reads (conversation_id, user_id, last_read_at)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = $3`,
                [convIdNum, req.userId, result.created_at],
            );

            const participants = (await req.db!.query(
                "SELECT user_id FROM conversation_participants WHERE conversation_id = $1",
                [convIdNum],
            )).rows;

            const outMsg = {
                id: result.id,
                conversationId: convIdNum,
                senderId: req.userId,
                senderName: sender.full_name,
                senderAvatar: sender.avatar,
                senderUsername: sender.username,
                content: original.content,
                fileUrl: original.file_url,
                fileName: original.file_name,
                fileType: original.file_type,
                fileSize: original.file_size,
                forwardedFromId: msgId,
                createdAt: result.created_at,
            };

            for (const p of participants) {
                sendToUser(req.tenantId, p.user_id, "chat_message", outMsg);
                if (p.user_id !== req.userId) {
                    redis.incrUnread(req.tenantId, p.user_id, convIdNum);
                }
            }
        }

        res.json({ ok: true });
    } catch (err) {
        req.log.error({ err }, "Forward message error");
        res.status(500).json({ error: "Failed to forward message" });
    }
});

// ─────────────────────────────────────────────
// STARRED MESSAGES
// ─────────────────────────────────────────────

/**
 * POST /api/chat/messages/:id/star
 */
router.post("/messages/:id/star", auth, async (req: Request, res: Response) => {
    try {
        const msgId = parseInt(String(req.params.id), 10);
        if (isNaN(msgId)) return res.status(400).json({ error: "Invalid message" });

        const msg = (await req.db!.query("SELECT conversation_id FROM messages WHERE id = $1", [msgId])).rows[0];
        if (!msg) return res.status(404).json({ error: "Message not found" });
        if (!(await verifyParticipant(msg.conversation_id, req.userId, req.db as unknown as DbLike))) {
            return res.status(403).json({ error: "Not a participant" });
        }

        const existing = (await req.db!.query(
            "SELECT 1 FROM starred_messages WHERE user_id = $1 AND message_id = $2",
            [req.userId, msgId],
        )).rows[0];

        if (existing) {
            await req.db!.query("DELETE FROM starred_messages WHERE user_id = $1 AND message_id = $2", [req.userId, msgId]);
            res.json({ ok: true, starred: false });
        } else {
            await req.db!.query("INSERT INTO starred_messages (user_id, message_id) VALUES ($1, $2)", [req.userId, msgId]);
            res.json({ ok: true, starred: true });
        }
    } catch (err) {
        req.log.error({ err }, "Star message error");
        res.status(500).json({ error: "Failed to star message" });
    }
});

/**
 * GET /api/chat/starred
 */
router.get("/starred", auth, async (req: Request, res: Response) => {
    try {
        const rows = (await req.db!.query(`
            SELECT m.id, m.conversation_id, m.sender_id, m.content, m.created_at,
                   m.file_url, m.file_name, m.file_type, m.file_size,
                   m.format_type, m.metadata,
                   u.full_name AS sender_name, u.avatar AS sender_avatar,
                   sm.created_at AS starred_at,
                   c.name AS group_name, c.is_group
            FROM starred_messages sm
            JOIN messages m ON m.id = sm.message_id
            JOIN users u ON u.id = m.sender_id
            JOIN conversations c ON c.id = m.conversation_id
            WHERE sm.user_id = $1 AND m.deleted_at IS NULL
            ORDER BY sm.created_at DESC
            LIMIT 100
        `, [req.userId])).rows;

        res.json(rows);
    } catch (err) {
        req.log.error({ err }, "Get starred error");
        res.status(500).json({ error: "Failed to get starred messages" });
    }
});

// ─────────────────────────────────────────────
// POLLS
// ─────────────────────────────────────────────

/**
 * POST /api/chat/conversations/:id/polls  { question, options: [str], multiSelect? }
 */
router.post("/conversations/:id/polls", auth, async (req: Request, res: Response) => {
    try {
        const convId = parseInt(String(req.params.id), 10);
        if (isNaN(convId)) return res.status(400).json({ error: "Invalid conversation" });
        if (!(await verifyParticipant(convId, req.userId, req.db as unknown as DbLike))) {
            return res.status(403).json({ error: "Not a participant" });
        }

        const { question, options, multiSelect } = req.body;
        if (!question || !question.trim()) return res.status(400).json({ error: "Question is required" });
        if (!Array.isArray(options) || options.length < 2 || options.length > 10) {
            return res.status(400).json({ error: "2-10 options required" });
        }

        const cleanOpts = options.map((o) => String(o).trim().slice(0, 200)).filter(Boolean);
        if (cleanOpts.length < 2) return res.status(400).json({ error: "At least 2 non-empty options" });

        const poll = (await req.db!.query(
            `INSERT INTO polls (conversation_id, creator_id, question, options, multi_select)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [convId, req.userId, question.trim().slice(0, 500), JSON.stringify(cleanOpts), !!multiSelect],
        )).rows[0];

        // Insert a message of type 'poll' referencing this poll
        const result = (await req.db!.query(
            `INSERT INTO messages (conversation_id, sender_id, content, format_type, metadata)
             VALUES ($1, $2, $3, 'poll', $4) RETURNING id, created_at`,
            [convId, req.userId, question.trim().slice(0, 500), JSON.stringify({ pollId: poll.id })],
        )).rows[0];

        await req.db!.query("UPDATE conversations SET updated_at = NOW() WHERE id = $1", [convId]);

        const sender = (await req.db!.query("SELECT full_name, avatar, username FROM users WHERE id = $1", [req.userId])).rows[0];
        const participants = (await req.db!.query(
            "SELECT user_id FROM conversation_participants WHERE conversation_id = $1", [convId],
        )).rows;

        const outMsg = {
            id: result.id, conversationId: convId, senderId: req.userId,
            senderName: sender.full_name, senderAvatar: sender.avatar,
            content: question.trim(), formatType: "poll",
            metadata: { pollId: poll.id, question: poll.question, options: cleanOpts, multiSelect: !!multiSelect, votes: {} },
            createdAt: result.created_at,
        };

        for (const p of participants) {
            sendToUser(req.tenantId, p.user_id, "chat_message", outMsg);
        }

        res.status(201).json({ ok: true, poll, messageId: result.id });
    } catch (err) {
        req.log.error({ err }, "Create poll error");
        res.status(500).json({ error: "Failed to create poll" });
    }
});

/**
 * POST /api/chat/polls/:id/vote  { optionIdx }
 */
router.post("/polls/:id/vote", auth, async (req: Request, res: Response) => {
    try {
        const pollId = parseInt(String(req.params.id), 10);
        if (isNaN(pollId)) return res.status(400).json({ error: "Invalid poll" });

        const poll = (await req.db!.query("SELECT * FROM polls WHERE id = $1", [pollId])).rows[0];
        if (!poll) return res.status(404).json({ error: "Poll not found" });
        if (poll.closed_at) return res.status(400).json({ error: "Poll is closed" });
        if (!(await verifyParticipant(poll.conversation_id, req.userId, req.db as unknown as DbLike))) {
            return res.status(403).json({ error: "Not a participant" });
        }

        const { optionIdx } = req.body;
        const opts = poll.options;
        if (typeof optionIdx !== "number" || optionIdx < 0 || optionIdx >= opts.length) {
            return res.status(400).json({ error: "Invalid option" });
        }

        // Toggle vote
        const existing = (await req.db!.query(
            "SELECT id FROM poll_votes WHERE poll_id = $1 AND user_id = $2 AND option_idx = $3",
            [pollId, req.userId, optionIdx],
        )).rows[0];

        if (existing) {
            await req.db!.query("DELETE FROM poll_votes WHERE id = $1", [existing.id]);
        } else {
            if (!poll.multi_select) {
                await req.db!.query("DELETE FROM poll_votes WHERE poll_id = $1 AND user_id = $2", [pollId, req.userId]);
            }
            await req.db!.query("INSERT INTO poll_votes (poll_id, user_id, option_idx) VALUES ($1, $2, $3)", [pollId, req.userId, optionIdx]);
        }

        // Fetch updated vote counts
        const votes = (await req.db!.query(
            "SELECT option_idx, array_agg(user_id) AS user_ids FROM poll_votes WHERE poll_id = $1 GROUP BY option_idx",
            [pollId],
        )).rows;
        const voteMap: Record<number, number[]> = {};
        for (const v of votes) voteMap[v.option_idx] = v.user_ids;

        // Broadcast poll update
        const participants = (await req.db!.query(
            "SELECT user_id FROM conversation_participants WHERE conversation_id = $1", [poll.conversation_id],
        )).rows;
        for (const p of participants) {
            sendToUser(req.tenantId, p.user_id, "chat_poll_vote", {
                pollId, conversationId: poll.conversation_id, votes: voteMap,
                voterId: req.userId, optionIdx, isRemoval: !!existing,
            });
        }

        res.json({ ok: true, votes: voteMap });
    } catch (err) {
        req.log.error({ err }, "Poll vote error");
        res.status(500).json({ error: "Failed to vote" });
    }
});

/**
 * GET /api/chat/polls/:id
 */
router.get("/polls/:id", auth, async (req: Request, res: Response) => {
    try {
        const pollId = parseInt(String(req.params.id), 10);
        if (isNaN(pollId)) return res.status(400).json({ error: "Invalid poll" });

        const poll = (await req.db!.query("SELECT * FROM polls WHERE id = $1", [pollId])).rows[0];
        if (!poll) return res.status(404).json({ error: "Poll not found" });
        if (!(await verifyParticipant(poll.conversation_id, req.userId, req.db as unknown as DbLike))) {
            return res.status(403).json({ error: "Not a participant" });
        }

        const votes = (await req.db!.query(
            `SELECT pv.option_idx, pv.user_id, u.full_name
             FROM poll_votes pv JOIN users u ON u.id = pv.user_id
             WHERE pv.poll_id = $1`,
            [pollId],
        )).rows;

        const voteMap: Record<number, Array<{ userId: number; fullName: string }>> = {};
        for (const v of votes) {
            if (!voteMap[v.option_idx]) voteMap[v.option_idx] = [];
            voteMap[v.option_idx].push({ userId: v.user_id, fullName: v.full_name });
        }

        res.json({ ...poll, votes: voteMap });
    } catch (err) {
        req.log.error({ err }, "Get poll error");
        res.status(500).json({ error: "Failed to get poll" });
    }
});

// ─────────────────────────────────────────────
// SHARED FILES
// ─────────────────────────────────────────────

/**
 * GET /api/chat/conversations/:id/files
 */
router.get("/conversations/:id/files", auth, async (req: Request, res: Response) => {
    try {
        const convId = parseInt(String(req.params.id), 10);
        if (isNaN(convId)) return res.status(400).json({ error: "Invalid conversation" });
        if (!(await verifyParticipant(convId, req.userId, req.db as unknown as DbLike))) {
            return res.status(403).json({ error: "Not a participant" });
        }

        const rows = (await req.db!.query(`
            SELECT m.id, m.file_url, m.file_name, m.file_type, m.file_size,
                   m.created_at, m.sender_id,
                   u.full_name AS sender_name, u.avatar AS sender_avatar
            FROM messages m
            JOIN users u ON u.id = m.sender_id
            WHERE m.conversation_id = $1 AND m.file_url IS NOT NULL AND m.deleted_at IS NULL
            ORDER BY m.created_at DESC
            LIMIT 100
        `, [convId])).rows;

        res.json(rows);
    } catch (err) {
        req.log.error({ err }, "Get shared files error");
        res.status(500).json({ error: "Failed to get shared files" });
    }
});

// ─────────────────────────────────────────────
// PIN / FAVOURITE CONVERSATION
// ─────────────────────────────────────────────

/**
 * POST /api/chat/conversations/:id/pin
 * Toggle pin status for the current user.
 */
router.post("/conversations/:id/pin", auth, async (req: Request, res: Response) => {
    try {
        const convId = parseInt(String(req.params.id), 10);
        if (isNaN(convId)) return res.status(400).json({ error: "Invalid conversation" });

        if (!(await verifyParticipant(convId, req.userId, req.db as unknown as DbLike))) {
            return res.status(403).json({ error: "Not a participant" });
        }

        const result = (await req.db!.query(
            `UPDATE conversation_participants SET is_pinned = NOT is_pinned
             WHERE conversation_id = $1 AND user_id = $2
             RETURNING is_pinned`,
            [convId, req.userId],
        )).rows[0];

        res.json({ pinned: result.is_pinned });
    } catch (err) {
        req.log.error({ err }, "Pin conversation error");
        res.status(500).json({ error: "Failed to pin conversation" });
    }
});

/**
 * POST /api/chat/conversations/:id/favourite
 * Toggle favourite status for the current user.
 */
router.post("/conversations/:id/favourite", auth, async (req: Request, res: Response) => {
    try {
        const convId = parseInt(String(req.params.id), 10);
        if (isNaN(convId)) return res.status(400).json({ error: "Invalid conversation" });

        if (!(await verifyParticipant(convId, req.userId, req.db as unknown as DbLike))) {
            return res.status(403).json({ error: "Not a participant" });
        }

        const result = (await req.db!.query(
            `UPDATE conversation_participants SET is_favourite = NOT is_favourite
             WHERE conversation_id = $1 AND user_id = $2
             RETURNING is_favourite`,
            [convId, req.userId],
        )).rows[0];

        res.json({ favourite: result.is_favourite });
    } catch (err) {
        req.log.error({ err }, "Favourite conversation error");
        res.status(500).json({ error: "Failed to favourite conversation" });
    }
});

// ─────────────────────────────────────────────
// CLEAR CHAT (delete all messages, keep conversation)
// ─────────────────────────────────────────────

/**
 * DELETE /api/chat/conversations/:id/messages
 * Removes all messages in a conversation for everyone.
 */
router.delete("/conversations/:id/messages", auth, async (req: Request, res: Response) => {
    try {
        const convId = parseInt(String(req.params.id), 10);
        if (isNaN(convId)) return res.status(400).json({ error: "Invalid conversation" });

        if (!(await verifyParticipant(convId, req.userId, req.db as unknown as DbLike))) {
            return res.status(403).json({ error: "Not a participant" });
        }

        // Only group creator or 1-on-1 participants can clear all messages
        const conv = (await req.db!.query("SELECT is_group, created_by FROM conversations WHERE id = $1", [convId])).rows[0];
        if (conv?.is_group && conv.created_by && conv.created_by !== req.userId) {
            return res.status(403).json({ error: "Only the group creator can clear all messages" });
        }

        await req.db!.query("DELETE FROM messages WHERE conversation_id = $1", [convId]);
        await req.db!.query(
            "UPDATE conversations SET updated_at = NOW() WHERE id = $1",
            [convId],
        );

        // Notify all participants
        const participants = (await req.db!.query(
            "SELECT user_id FROM conversation_participants WHERE conversation_id = $1",
            [convId],
        )).rows;

        for (const p of participants) {
            sendToUser(req.tenantId, p.user_id, "chat_cleared", { conversationId: convId });
        }

        res.json({ ok: true });
    } catch (err) {
        req.log.error({ err }, "Clear chat error");
        res.status(500).json({ error: "Failed to clear chat" });
    }
});

// ─────────────────────────────────────────────
// DELETE CONVERSATION
// ─────────────────────────────────────────────

/**
 * DELETE /api/chat/conversations/:id
 * Deletes a conversation the user participates in.
 * For 1-on-1 chats, both users' conversation is removed.
 * For groups, only the creator or any participant can delete (removes for everyone).
 */
router.delete("/conversations/:id", auth, async (req: Request, res: Response) => {
    try {
        const convId = parseInt(String(req.params.id), 10);
        if (isNaN(convId)) return res.status(400).json({ error: "Invalid conversation" });

        if (!(await verifyParticipant(convId, req.userId, req.db as unknown as DbLike))) {
            return res.status(403).json({ error: "Not a participant" });
        }

        // Only group creator can delete group conversations; 1-on-1 chats can be deleted by either party
        const conv = (await req.db!.query("SELECT is_group, created_by FROM conversations WHERE id = $1", [convId])).rows[0];
        if (conv?.is_group && conv.created_by && conv.created_by !== req.userId) {
            return res.status(403).json({ error: "Only the group creator can delete this conversation" });
        }

        // Notify other participants before deletion
        const participants = (await req.db!.query(
            "SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2",
            [convId, req.userId],
        )).rows;

        // Delete the conversation (all children CASCADE automatically)
        await req.db!.query("DELETE FROM conversations WHERE id = $1", [convId]);

        for (const p of participants) {
            sendToUser(req.tenantId, p.user_id, "chat_conv_deleted", { conversationId: convId });
        }

        res.json({ ok: true });
    } catch (err) {
        req.log.error({ err }, "Delete conversation error");
        res.status(500).json({ error: "Failed to delete conversation" });
    }
});

// ─────────────────────────────────────────────
// DELIVERY ACKNOWLEDGEMENT
// ─────────────────────────────────────────────

/**
 * POST /api/chat/messages/:id/delivered
 */
router.post("/messages/:id/delivered", auth, async (req: Request, res: Response) => {
    try {
        const msgId = parseInt(String(req.params.id), 10);
        if (isNaN(msgId)) return res.status(400).json({ error: "Invalid message" });

        // Verify user is a participant in the message's conversation
        const msg = (await req.db!.query(
            `SELECT m.conversation_id FROM messages m
             JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id AND cp.user_id = $1
             WHERE m.id = $2`,
            [req.userId, msgId],
        )).rows[0];
        if (!msg) return res.status(403).json({ error: "Not a participant" });

        await req.db!.query(
            `UPDATE messages SET delivered_to = delivered_to || $1::jsonb
             WHERE id = $2 AND NOT delivered_to @> $1::jsonb`,
            [JSON.stringify([req.userId]), msgId],
        );

        res.json({ ok: true });
    } catch (err) {
        req.log.error({ err }, "Delivery ack error");
        res.status(500).json({ error: "Failed" });
    }
});

// ─────────────────────────────────────────────
// CALL HISTORY
// ─────────────────────────────────────────────

/**
 * GET /api/chat/calls
 * Returns all calls the current user participated in (across all conversations).
 */
router.get("/calls", auth, async (req: Request, res: Response) => {
    try {
        const userId = req.userId;
        const rows = (await req.db!.query(`
            SELECT * FROM (
                SELECT DISTINCT ON (cl.id)
                    cl.id, cl.caller_id, cl.call_type, cl.status,
                    cl.started_at, cl.ended_at, cl.duration, cl.created_at,
                    caller.full_name AS caller_name, caller.avatar AS caller_avatar,
                    other_u.id AS other_user_id,
                    other_u.full_name AS other_name,
                    other_u.avatar AS other_avatar,
                    c.is_group, c.name AS group_name
                FROM call_logs cl
                JOIN conversations c ON c.id = cl.conversation_id
                JOIN users caller ON caller.id = cl.caller_id
                JOIN conversation_participants cp_me
                    ON cp_me.conversation_id = cl.conversation_id AND cp_me.user_id = $1
                LEFT JOIN LATERAL (
                    SELECT u.id, u.full_name, u.avatar
                    FROM conversation_participants cp2
                    JOIN users u ON u.id = cp2.user_id
                    WHERE cp2.conversation_id = cl.conversation_id
                      AND cp2.user_id != $1
                      AND NOT c.is_group
                    LIMIT 1
                ) other_u ON true
                ORDER BY cl.id, cl.created_at DESC
            ) sub
            ORDER BY created_at DESC
            LIMIT 100
        `, [userId])).rows;
        res.json(rows);
    } catch (err) {
        req.log.error({ err }, "Get all call history error");
        res.status(500).json({ error: "Failed to get call history" });
    }
});

/**
 * GET /api/chat/calls/active
 * Returns the user's currently active call (status = 'answered'), if any.
 */
router.get("/calls/active", auth, async (req: Request, res: Response) => {
    try {
        const userId = req.userId;
        const row = (await req.db!.query(`
            SELECT cl.id, cl.conversation_id, cl.caller_id, cl.call_type, cl.status, cl.started_at,
                   caller.full_name AS caller_name, caller.avatar AS caller_avatar,
                   c.is_group, c.name AS group_name,
                   other_u.id AS other_user_id,
                   other_u.full_name AS other_name,
                   other_u.avatar AS other_avatar
            FROM call_logs cl
            JOIN conversations c ON c.id = cl.conversation_id
            JOIN users caller ON caller.id = cl.caller_id
            JOIN conversation_participants cp_me
                ON cp_me.conversation_id = cl.conversation_id AND cp_me.user_id = $1
            LEFT JOIN LATERAL (
                SELECT u.id, u.full_name, u.avatar
                FROM conversation_participants cp2
                JOIN users u ON u.id = cp2.user_id
                WHERE cp2.conversation_id = cl.conversation_id
                  AND cp2.user_id != $1
                  AND NOT c.is_group
                LIMIT 1
            ) other_u ON true
            WHERE cl.status = 'answered'
            ORDER BY cl.started_at DESC
            LIMIT 1
        `, [userId])).rows[0];
        res.json(row || null);
    } catch (err) {
        req.log.error({ err }, "Get active call error");
        res.status(500).json({ error: "Failed to get active call" });
    }
});

/**
 * GET /api/chat/conversations/:id/calls
 * Returns call history for a conversation.
 */
router.get("/conversations/:id/calls", auth, async (req: Request, res: Response) => {
    try {
        const convId = parseInt(String(req.params.id), 10);
        if (isNaN(convId)) return res.status(400).json({ error: "Invalid conversation" });
        if (!(await verifyParticipant(convId, req.userId, req.db as unknown as DbLike))) {
            return res.status(403).json({ error: "Not a participant" });
        }

        const rows = (await req.db!.query(`
            SELECT cl.id, cl.caller_id, cl.call_type, cl.status, cl.started_at,
                   cl.ended_at, cl.duration, cl.created_at,
                   u.full_name AS caller_name, u.avatar AS caller_avatar
            FROM call_logs cl
            JOIN users u ON u.id = cl.caller_id
            WHERE cl.conversation_id = $1
            ORDER BY cl.created_at DESC
            LIMIT 50
        `, [convId])).rows;

        res.json(rows);
    } catch (err) {
        req.log.error({ err }, "Get call history error");
        res.status(500).json({ error: "Failed to get call history" });
    }
});

export = router;