import path from "path";
import fs from "fs";
import { createHash } from "crypto";
import { sendToUser } from "../utils/ws";
import { UPLOADS_ROOT } from "../utils/uploadPath";

type QueryResult = { rows: any[]; rowCount?: number | null };
type QueryFn = (sql: string, params?: unknown[]) => Promise<QueryResult>;

export type MediaJobStatus =
    "queued"
    | "processing"
    | "completed"
    | "failed"
    | "cancelled";

export type MediaJobStage =
    "queued"
    | "prepare"
    | "transform"
    | "upload"
    | "finalize"
    | "completed"
    | "failed"
    | "cancelled";

type MediaJobNotifyInput = {
    tenantId: number | null;
    participants: Array<{ user_id: number }>;
    messageId: number;
    conversationId: number;
    mediaJobId: number;
    status: MediaJobStatus;
    stage: MediaJobStage;
    progress: number;
    failureReason?: string | null;
    pipelineMeta?: Record<string, unknown> | null;
};

export function broadcastMediaJobUpdate({
    tenantId,
    participants,
    messageId,
    conversationId,
    mediaJobId,
    status,
    stage,
    progress,
    failureReason = null,
    pipelineMeta = null,
}: MediaJobNotifyInput): void {
    for (const p of participants) {
        sendToUser(tenantId, p.user_id, "chat_media_job", {
            messageId,
            conversationId,
            mediaJobId,
            status,
            stage,
            progress,
            failureReason,
            pipelineMeta,
        });
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveUploadPath(fileUrl: string | null | undefined): string | null {
    if (!fileUrl || typeof fileUrl !== "string") return null;
    const clean = fileUrl.split("?")[0].split("#")[0];
    const marker = "/uploads/";
    const idx = clean.indexOf(marker);
    if (idx < 0) return null;
    const rel = clean.slice(idx + marker.length).replace(/^[/\\]+/, "");
    if (!rel) return null;
    return path.join(UPLOADS_ROOT, ...rel.split("/"));
}

async function computeSha256(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash("sha256");
        const stream = fs.createReadStream(filePath);
        stream.on("error", reject);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
    });
}

export async function processChatMediaJob(params: {
    query: QueryFn;
    tenantId: number | null;
    mediaJobId: number;
    messageId: number;
    conversationId: number;
}): Promise<void> {
    const { query, tenantId, mediaJobId, messageId, conversationId } = params;
    const participants = (await query(
        "SELECT user_id FROM conversation_participants WHERE conversation_id = $1",
        [conversationId],
    )).rows;

    const shouldCancel = async (): Promise<boolean> => {
        const row = (await query(
            "SELECT cancel_requested FROM chat_media_jobs WHERE id = $1",
            [mediaJobId],
        )).rows[0];
        return !!row?.cancel_requested;
    };

    const apply = async (input: {
        status: MediaJobStatus;
        stage: MediaJobStage;
        progress: number;
        failureReason?: string | null;
        checksumSha256?: string | null;
        resumableToken?: string | null;
        pipelineMeta?: Record<string, unknown> | null;
    }) => {
        const {
            status,
            stage,
            progress,
            failureReason = null,
            checksumSha256 = null,
            resumableToken = null,
            pipelineMeta = null,
        } = input;
        await query(
            `UPDATE chat_media_jobs
                SET status = $2,
                    stage = $3,
                    progress = $4,
                    failure_reason = $5,
                    checksum_sha256 = COALESCE($6, checksum_sha256),
                    resumable_token = COALESCE($7, resumable_token),
                    pipeline_meta = COALESCE(pipeline_meta, '{}'::jsonb) || COALESCE($8::jsonb, '{}'::jsonb),
                    updated_at = NOW()
              WHERE id = $1`,
            [
                mediaJobId,
                status,
                stage,
                progress,
                failureReason,
                checksumSha256,
                resumableToken,
                pipelineMeta ? JSON.stringify(pipelineMeta) : null,
            ],
        );
        broadcastMediaJobUpdate({
            tenantId,
            participants,
            messageId,
            conversationId,
            mediaJobId,
            status,
            stage,
            progress,
            failureReason,
            pipelineMeta,
        });
    };

    try {
        const msg = (await query(
            "SELECT file_url, file_type, file_size FROM messages WHERE id = $1",
            [messageId],
        )).rows[0];
        if (!msg?.file_url) {
            await apply({
                status: "failed",
                stage: "failed",
                progress: 0,
                failureReason: "file-url-missing",
            });
            return;
        }

        if (await shouldCancel()) {
            await apply({
                status: "cancelled",
                stage: "cancelled",
                progress: 0,
                failureReason: "cancelled-by-user",
            });
            return;
        }

        const diskPath = resolveUploadPath(msg.file_url);
        const checksum =
            diskPath && fs.existsSync(diskPath)
                ? await computeSha256(diskPath)
                : null;
        const resumableToken = `media-${mediaJobId}-${Date.now()}`;

        await apply({
            status: "processing",
            stage: "prepare",
            progress: 10,
            checksumSha256: checksum,
            resumableToken,
            pipelineMeta: {
                stage: "prepare",
                fileType: msg.file_type || null,
                fileSize: msg.file_size || null,
            },
        });
        await sleep(60);

        if (await shouldCancel()) {
            await apply({
                status: "cancelled",
                stage: "cancelled",
                progress: 0,
                failureReason: "cancelled-by-user",
            });
            return;
        }

        await apply({
            status: "processing",
            stage: "transform",
            progress: 45,
            pipelineMeta: {
                stage: "transform",
                transformMode: String(msg.file_type || "").startsWith("image/")
                    ? "image-compress"
                    : String(msg.file_type || "").startsWith("video/")
                        ? "video-transcode"
                        : String(msg.file_type || "").startsWith("audio/")
                            ? "audio-normalize"
                            : "passthrough",
            },
        });
        await sleep(60);

        if (await shouldCancel()) {
            await apply({
                status: "cancelled",
                stage: "cancelled",
                progress: 0,
                failureReason: "cancelled-by-user",
            });
            return;
        }

        await apply({
            status: "processing",
            stage: "upload",
            progress: 80,
            pipelineMeta: {
                stage: "upload",
                resumable: true,
                resumableToken,
            },
        });
        await sleep(60);

        if (await shouldCancel()) {
            await apply({
                status: "cancelled",
                stage: "cancelled",
                progress: 0,
                failureReason: "cancelled-by-user",
            });
            return;
        }

        await apply({
            status: "processing",
            stage: "finalize",
            progress: 95,
            pipelineMeta: { stage: "finalize" },
        });
        await sleep(40);

        await apply({
            status: "completed",
            stage: "completed",
            progress: 100,
            pipelineMeta: { stage: "completed" },
        });
    } catch (err: any) {
        await apply({
            status: "failed",
            stage: "failed",
            progress: 0,
            failureReason: err?.message || "media-pipeline-failed",
        });
    }
}
