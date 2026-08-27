/**
 * Cloudflare R2 storage adapter (S3-compatible API).
 *
 * PRODUCTION BACKEND. Makes the app stateless with respect to uploads, which is
 * what allows more than one replica to run — see docs/SCALABILITY_REFACTOR_PLAN.md A3.
 *
 * BUCKET MODEL (ADR-003/004)
 *   One PRIVATE bucket (`aino-uploads`) with per-tenant key prefixes.
 *   Deliberately separate from the public `aino-releases` bucket behind
 *   cdn.aino.org.in: user content must never share a bucket that has a public
 *   custom domain.
 *
 * ACCESS MODEL
 *   The bucket has no public access. Downloads are served via short-lived
 *   presigned URLs minted only AFTER the tenant/org/conversation authorization
 *   checks pass, so a client can never enumerate another tenant's prefix.
 *
 * ENVIRONMENT
 *   R2_ACCOUNT_ID          Cloudflare account id (builds the endpoint)
 *   R2_ACCESS_KEY_ID       R2 API token id
 *   R2_SECRET_ACCESS_KEY   R2 API token secret
 *   R2_UPLOADS_BUCKET      bucket name (default: aino-uploads)
 */
import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    DeleteObjectsCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { PutOptions, StorageAdapter, StoredObject } from "./types";

/** Default presign lifetime. Long enough to start a download, short enough
 *  that a leaked URL is near-worthless. */
const DEFAULT_SIGNED_URL_TTL = 60;

export interface R2Config {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
}

export class R2Adapter implements StorageAdapter {
    readonly name = "r2";
    private readonly client: S3Client;
    private readonly bucket: string;

    constructor(cfg: R2Config) {
        this.bucket = cfg.bucket;
        this.client = new S3Client({
            // R2 ignores region but the SDK requires one.
            region: "auto",
            endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
            credentials: {
                accessKeyId: cfg.accessKeyId,
                secretAccessKey: cfg.secretAccessKey,
            },
        });
    }

    async put(key: string, body: Buffer, opts?: PutOptions): Promise<void> {
        await this.client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: body,
            ContentType: opts?.contentType,
            // Uploads are immutable — filenames embed a timestamp — so a long
            // TTL is safe and keeps repeat egress off the origin.
            CacheControl: opts?.cacheControl ?? "public, max-age=31536000, immutable",
        }));
    }

    async get(key: string): Promise<Buffer | null> {
        try {
            const res = await this.client.send(new GetObjectCommand({
                Bucket: this.bucket,
                Key: key,
            }));
            if (!res.Body) return null;
            return Buffer.from(await res.Body.transformToByteArray());
        } catch (err: unknown) {
            if (isNotFound(err)) return null;
            throw err;
        }
    }

    async delete(key: string): Promise<void> {
        try {
            await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
        } catch (err: unknown) {
            if (!isNotFound(err)) throw err;
        }
    }

    /**
     * Delete every object under a prefix, paging through the listing and
     * batching deletes 1,000 at a time (the S3 API maximum).
     */
    async deletePrefix(prefix: string): Promise<number> {
        let deleted = 0;
        let token: string | undefined;

        do {
            const listed = await this.client.send(new ListObjectsV2Command({
                Bucket: this.bucket,
                Prefix: prefix,
                ContinuationToken: token,
            }));

            const objects = (listed.Contents || [])
                .map((o) => (o.Key ? { Key: o.Key } : null))
                .filter((o): o is { Key: string } => o !== null);

            if (objects.length > 0) {
                await this.client.send(new DeleteObjectsCommand({
                    Bucket: this.bucket,
                    Delete: { Objects: objects, Quiet: true },
                }));
                deleted += objects.length;
            }

            token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
        } while (token);

        return deleted;
    }

    async exists(key: string): Promise<boolean> {
        try {
            await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
            return true;
        } catch (err: unknown) {
            if (isNotFound(err)) return false;
            throw err;
        }
    }

    async getSignedUrl(key: string, expiresInSeconds = DEFAULT_SIGNED_URL_TTL): Promise<string | null> {
        return getSignedUrl(
            this.client,
            new GetObjectCommand({ Bucket: this.bucket, Key: key }),
            { expiresIn: expiresInSeconds },
        );
    }

    async stat(key: string): Promise<StoredObject | null> {
        try {
            const res = await this.client.send(new HeadObjectCommand({
                Bucket: this.bucket,
                Key: key,
            }));
            return {
                key,
                size: res.ContentLength ?? 0,
                contentType: res.ContentType,
                lastModified: res.LastModified,
            };
        } catch (err: unknown) {
            if (isNotFound(err)) return null;
            throw err;
        }
    }
}

/** S3/R2 signal a missing key as NoSuchKey/NotFound or HTTP 404. */
function isNotFound(err: unknown): boolean {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    return e?.name === "NoSuchKey"
        || e?.name === "NotFound"
        || e?.$metadata?.httpStatusCode === 404;
}
