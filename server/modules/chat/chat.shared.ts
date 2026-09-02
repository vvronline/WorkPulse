/** Shared non-HTTP chat adapter helpers. */
import type { Request } from "express";
const multer = require("multer");
const { sendToUser } = require("../../utils/ws");
const { randomFilename } = require("../../platform/storage");
const { deleteChatAttachment } = require("../../services/chatAttachments");
import { createChatService } from "./chat.service";
import type { ChatDb } from "./chat.types";

export const service = createChatService();

export function db(req: Request): ChatDb {
  return req.db as unknown as ChatDb;
}

export interface DbLike {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: any[]; rowCount: number }>;
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
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
  "text/plain": "txt",
  "text/csv": "csv",
};

// A3: buffered in memory, then written to object storage. Disk storage pinned
// the app to one Railway instance (a volume attaches to a single container),
// which made horizontal scaling impossible.
export const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req: Request, file: UploadedFile, cb: MulterCb<boolean>) => {
    if (!ALLOWED_TYPES[file.mimetype]) {
      return cb(new Error("File type not allowed"));
    }
    cb(null, true);
  },
});

/** Server-generated filename; extension comes from the validated MIME type. */
export function chatFilename(userId: number | undefined, mimetype: string): string {
  // Random, not `<userId>_<timestamp>`: chat attachments are the most
  // sensitive upload kind, and a guessable key is enumerable.
  return randomFilename("chat", ALLOWED_TYPES[mimetype] || "bin");
}

/**
 * Delete a chat attachment object, unless a forwarded copy still references it.
 * Full rationale in services/chatAttachments.ts.
 */
export const deleteChatObject = deleteChatAttachment;

// ─── Helper: verify participant ───
export async function verifyParticipant(
  convId: number,
  userId: number | undefined,
  db: DbLike,
): Promise<boolean> {
  const r = await service.query(db, "q001", [convId, userId]);
  return r.rows.length > 0;
}

/**
 * A reply may only reference a message in the destination conversation.
 * This prevents a message ID from another conversation being persisted and
 * later exposing its reply context through an unconstrained join.
 */
export async function verifyReplyTarget(
  conversationId: number,
  replyToId: number | null,
  db: DbLike,
): Promise<boolean> {
  if (replyToId === null) return true;

  const result = await service.query(db, "q002", [replyToId, conversationId]);
  return result.rows.length > 0;
}

// ─── Helper: get user org ───
export async function getUserOrg(
  userId: number | undefined,
  db: DbLike,
): Promise<number | undefined> {
  const r = await service.query(db, "q003", [userId]);
  return r.rows[0]?.org_id;
}

// ─── Helper: insert + broadcast a system (activity) message ───
// Mirrors meetings.insertSystemMessage: persists a format_type='system' row
// carrying a structured `metadata` payload and broadcasts it to all
// participants so the inline activity tombstone (X added Y, renamed, etc.)
// renders identically on every client (web + mobile).
export async function emitSystemMessage(
  db: DbLike,
  tenantId: number | string | undefined,
  conversationId: number,
  actorId: number | undefined,
  metadata: Record<string, unknown> & { text?: string },
): Promise<void> {
  // Activity/tombstone messages are best-effort: a failure to persist or fan
  // out the system message must NEVER fail the parent operation (e.g. removing
  // a member should still succeed even if the "X removed Y" notice can't be
  // written). Any error is swallowed and logged by the caller's surrounding
  // try/catch via the thrown-then-caught path being avoided here.
  try {
    const result = (
      await service.query(db, "q004", [conversationId, actorId, metadata.text || "", JSON.stringify(metadata)])
    ).rows[0];
    if (!result) return;
    await service.query(db, "q005", [
      conversationId,
    ]);
    const participants = (
      await service.query(db, "q006", [conversationId])
    ).rows;
    const outMsg = {
      id: result.id,
      conversationId,
      senderId: actorId,
      content: metadata.text || "",
      formatType: "system",
      metadata,
      createdAt: result.created_at,
    };
    for (const p of participants) {
      sendToUser(tenantId, p.user_id, "chat_message", outMsg);
    }
  } catch {
    /* best-effort: never let an activity message fail the parent action */
  }
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
