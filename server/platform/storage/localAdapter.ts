/**
 * Local-filesystem storage adapter — DEVELOPMENT ONLY.
 *
 * Writes under `server/uploads/`, exactly where uploads lived before A3, so a
 * developer can run the stack with no R2 credentials and existing local files
 * keep resolving.
 *
 * NOT FOR PRODUCTION: a local directory cannot be shared between replicas,
 * which is the precise limitation A3 removes. `index.ts` refuses to start in
 * production with STORAGE_DRIVER=local.
 */
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import type { PutOptions, StorageAdapter, StoredObject } from "./types";

export class LocalAdapter implements StorageAdapter {
    readonly name = "local";
    private readonly root: string;

    constructor(root?: string) {
        // Default matches the historical layout: server/uploads
        this.root = root || path.resolve(__dirname, "..", "..", "uploads");
    }

    /**
     * Resolve a key to an absolute path, refusing anything that escapes root.
     * Key segments are already validated in keys.ts; this is defence in depth.
     */
    private resolve(key: string): string {
        if (!key || key.includes("\0")) throw new Error("storage: invalid key");
        const abs = path.resolve(this.root, key);
        const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
        if (abs !== this.root && !abs.startsWith(rootWithSep)) {
            throw new Error("storage: key escapes root");
        }
        return abs;
    }

    async put(key: string, body: Buffer, _opts?: PutOptions): Promise<void> {
        const abs = this.resolve(key);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, body);
    }

    async get(key: string): Promise<Buffer | null> {
        try {
            return await fsp.readFile(this.resolve(key));
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw err;
        }
    }

    async delete(key: string): Promise<void> {
        try {
            await fsp.unlink(this.resolve(key));
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
    }

    async deletePrefix(prefix: string): Promise<number> {
        const abs = this.resolve(prefix);
        if (!fs.existsSync(abs)) return 0;

        let count = 0;
        const walk = async (dir: string): Promise<void> => {
            for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
                const p = path.join(dir, entry.name);
                if (entry.isDirectory()) await walk(p);
                else { await fsp.unlink(p); count++; }
            }
        };
        await walk(abs);
        await fsp.rm(abs, { recursive: true, force: true });
        return count;
    }

    async exists(key: string): Promise<boolean> {
        try {
            await fsp.access(this.resolve(key));
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Local files cannot be presigned. Returning null tells the caller to
     * stream the bytes through the app instead.
     */
    async getSignedUrl(_key: string, _expiresInSeconds?: number): Promise<string | null> {
        return null;
    }

    async stat(key: string): Promise<StoredObject | null> {
        try {
            const st = await fsp.stat(this.resolve(key));
            return { key, size: st.size, lastModified: st.mtime };
        } catch {
            return null;
        }
    }
}
