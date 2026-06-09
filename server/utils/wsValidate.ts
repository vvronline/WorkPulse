/**
 * Tiny, zero-dependency message-schema validator for WebSocket handlers.
 *
 * Why hand-roll this instead of pulling in zod?
 * ─────────────────────────────────────────────
 * Every WS handler in `handleChatMessage` opens with the same 5-10 lines of
 * `if (!x || typeof x !== 'string' || x.length > N) return;`. That's a
 * dozen handlers, each with subtly different bounds — exactly the kind of
 * place a typo silently lets bad input through.
 *
 * We DON'T need a fully general schema library. The patterns we use are:
 *   - required string (with optional max length + regex)
 *   - required number (with optional min/max)
 *   - optional same
 *   - required positive int (id / count)
 *   - boolean (true/false only — coerced)
 *   - enum of strings
 *
 * That's <100 LoC of pure JS, fully tested, zero dependencies, and the
 * resulting handler code reads like:
 *
 *   const { meetingId, text, clientMsgId } = parseOrReply({
 *     meetingId:    schema.posInt(),
 *     text:         schema.str({ max: 5_000, optional: true }),
 *     file_url:     schema.str({ max: 2_048, optional: true }),
 *     clientMsgId:  schema.str({ max: 64, optional: true }),
 *   }, msg.data, ws, 'meeting_message_error');
 *   if (!parsed) return; // validation failure already replied
 *
 * Why ship it now (Phase 6 part 2)?
 * ─────────────────────────────────
 * ADR-005 added per-handler observability. The next obvious move is to
 * make every handler bounce off a tight schema check — that turns
 * "garbage in → silently dropped → user thinks chat is broken" into
 * "garbage in → typed error reply → bug fixed in seconds with the
 * /api/internal/ws-stats latency panel as ground truth".
 */

interface ValidationResult {
    ok: boolean;
    error?: string;
    value?: unknown;
}

interface Validator {
    optional: boolean;
    validate(value: unknown): ValidationResult;
}

interface StrOptions {
    max?: number;
    min?: number;
    optional?: boolean;
    pattern?: RegExp | null;
}

interface OptionalOnly {
    optional?: boolean;
}

interface NumOptions {
    min?: number;
    max?: number;
    optional?: boolean;
}

interface Schema {
    str: (opts?: StrOptions) => Validator;
    posInt: (opts?: OptionalOnly) => Validator;
    num: (opts?: NumOptions) => Validator;
    bool: (opts?: OptionalOnly) => Validator;
    enumOf: (...allowed: unknown[]) => Validator;
}

/**
 * Schema-builder factory. Returns a tiny set of composable validators
 * that each implement `{ optional, validate(value) → { ok, error?, value? } }`.
 */
const schema: Schema = {
    /**
     * Required string. Optional max length + regex.
     *   schema.str()                       — any non-empty string
     *   schema.str({ max: 5000 })          — non-empty, ≤ 5000 chars
     *   schema.str({ optional: true })     — undefined OK, but if present must be a non-empty string
     */
    str: ({ max = Infinity, min = 1, optional = false, pattern = null }: StrOptions = {}) => ({
        optional,
        validate(v: unknown): ValidationResult {
            if (v == null || v === "") {
                return optional
                    ? { ok: true, value: undefined }
                    : { ok: false, error: "required" };
            }
            if (typeof v !== "string") return { ok: false, error: "not-a-string" };
            if (v.length < min) return { ok: false, error: "too-short" };
            if (v.length > max) return { ok: false, error: "too-long" };
            if (pattern && !pattern.test(v)) return { ok: false, error: "pattern-mismatch" };
            return { ok: true, value: v };
        },
    }),

    /** Positive integer (1, 2, 3, ...). Common for ids. */
    posInt: ({ optional = false }: OptionalOnly = {}) => ({
        optional,
        validate(v: unknown): ValidationResult {
            if (v == null) {
                return optional
                    ? { ok: true, value: undefined }
                    : { ok: false, error: "required" };
            }
            if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
                return { ok: false, error: "not-a-positive-int" };
            }
            return { ok: true, value: v };
        },
    }),

    /** Number with optional min/max bounds. */
    num: ({ min = -Infinity, max = Infinity, optional = false }: NumOptions = {}) => ({
        optional,
        validate(v: unknown): ValidationResult {
            if (v == null) {
                return optional
                    ? { ok: true, value: undefined }
                    : { ok: false, error: "required" };
            }
            if (typeof v !== "number" || !Number.isFinite(v)) {
                return { ok: false, error: "not-a-number" };
            }
            if (v < min) return { ok: false, error: "too-small" };
            if (v > max) return { ok: false, error: "too-large" };
            return { ok: true, value: v };
        },
    }),

    /** Boolean. Coerces truthy/falsy via `!!v`. */
    bool: ({ optional = false }: OptionalOnly = {}) => ({
        optional,
        validate(v: unknown): ValidationResult {
            if (v == null) {
                return optional
                    ? { ok: true, value: undefined }
                    : { ok: false, error: "required" };
            }
            return { ok: true, value: !!v };
        },
    }),

    /** Enum of allowed string values. */
    enumOf: (...allowed: unknown[]) => ({
        optional: false,
        validate(v: unknown): ValidationResult {
            if (!allowed.includes(v)) return { ok: false, error: `must-be-one-of:${allowed.join(",")}` };
            return { ok: true, value: v };
        },
    }),
};

type Shape = Record<string, Validator>;

interface ValidateSuccess {
    ok: true;
    value: Record<string, unknown>;
}

interface ValidateFailure {
    ok: false;
    errors: Record<string, string>;
}

/**
 * Validate `data` against `shape`. Returns
 *   { ok: true, value: { ...validatedFields } }
 * or
 *   { ok: false, errors: { fieldName: 'reason', ... } }
 *
 * Pure, doesn't touch the WS — callers wrap the reply.
 */
function validate(shape: Shape, data: unknown): ValidateSuccess | ValidateFailure {
    if (data == null || typeof data !== "object") {
        return { ok: false, errors: { _root: "not-an-object" } };
    }
    const out: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    const dataObj = data as Record<string, unknown>;
    for (const key of Object.keys(shape)) {
        const rule = shape[key];
        const result = rule.validate(dataObj[key]);
        if (result.ok) {
            if (result.value !== undefined) out[key] = result.value;
        } else {
            errors[key] = result.error as string;
        }
    }
    if (Object.keys(errors).length > 0) return { ok: false, errors };
    return { ok: true, value: out };
}

export { schema, validate };