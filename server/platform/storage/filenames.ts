/**
 * Server-generated upload filenames.
 *
 * WHY THESE ARE RANDOM
 *   Filenames used to be `<userId>_<Date.now()>.<ext>`, which is *enumerable*:
 *   both components are guessable, so anyone who learned the key format could
 *   construct candidate keys for other users and brute-force a timestamp range.
 *
 *   Authorization (tenant -> org -> conversation participant) is what actually
 *   protects an object, and it is unchanged. But a predictable name means one
 *   authorization regression turns into BULK enumeration rather than a single
 *   exposed file. A random component makes key-guessing infeasible on its own,
 *   which is the defence-in-depth property Slack gets from opaque file IDs
 *   (`F012AB3CDE4`) rather than descriptive paths.
 *
 * FORMAT
 *   <prefix>_<32 hex chars>.<ext>      e.g. user_9f3c...a1.jpg
 *
 *   The prefix is retained purely for human readability when browsing a bucket;
 *   it carries no authorization meaning. 128 bits of entropy is the security
 *   boundary.
 *
 * COMPATIBILITY
 *   Only affects NEWLY written objects. Existing keys are untouched and keep
 *   resolving — the URL stored in each tenant DB is the source of truth, and
 *   nothing derives a key by recomputing a filename.
 */
import { randomUUID } from "crypto";

/** 32 hex chars (128 bits). `randomUUID` is CSPRNG-backed. */
function randomToken(): string {
    return randomUUID().replace(/-/g, "");
}

/**
 * Build an unguessable filename.
 *
 * @param prefix Short human hint (`user`, `chat`, `logo`). Sanitised, never
 *   trusted: it is cosmetic and must not be able to break out of the segment.
 * @param ext    Extension WITHOUT the dot, derived from the validated MIME
 *   type — never from the user's original filename.
 */
export function randomFilename(prefix: string, ext: string): string {
    const safePrefix = String(prefix || "file").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "file";
    const safeExt = String(ext || "bin").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "bin";
    return `${safePrefix}_${randomToken()}.${safeExt}`;
}

/**
 * True when a filename still uses the old guessable `<id>_<timestamp>.<ext>`
 * shape. Used by tests to assert the new format everywhere; also handy when
 * auditing a bucket for pre-hardening objects.
 */
export function isLegacyGuessableFilename(filename: string): boolean {
    return /^[a-zA-Z]*_?\d+_\d{10,}\.[a-zA-Z0-9]+$/.test(filename)
        || /^\d+_\d{10,}\.[a-zA-Z0-9]+$/.test(filename);
}
