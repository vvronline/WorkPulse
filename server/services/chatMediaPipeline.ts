import { createHash } from "crypto";
import { sendToUser } from "../utils/ws";
import { getStorage, urlToKey } from "../platform/storage";

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

/**
 * Storage key for a stored file URL, or null when unusable.
 *
 * A3: this used to build an absolute path under `server/uploads/`. That only
 * worked while the worker shared a filesystem with the web process — which
 * stops being true the moment either one is replicated, or once the worker
 * runs as its own service (Phase D). Media now lives in object storage.
 */
function resolveUploadKey(fileUrl: string | null | undefined): string | null {
    if (!fileUrl || typeof fileUrl !== "string") return null;
    // Strip any query/fragment before interpreting the path.
    const clean = fileUrl.split("?")[0].split("#")[0];
    return urlToKey(clean);
}

/** SHA-256 of a stored object, or null when the object is missing. */
async function computeSha256(key: string): Promise<string | null> {
    const body = await getStorage().get(key);
    if (!body) return null;
    return createHash("sha256").update(body).digest("hex");
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

        const objectKey = resolveUploadKey(msg.file_url);
        const checksum = objectKey ? await computeSha256(objectKey) : null;
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
