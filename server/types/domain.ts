/**
 * Shared domain types for the server.
 *
 * These describe the shapes that flow across module boundaries: the per-request
 * tenant database context, query helpers, and common row shapes. They are
 * intentionally permissive where the legacy JS is permissive (e.g. `query`
 * returns `QueryResult<any>`), and will be tightened over time.
 */
import type { QueryResult, QueryResultRow, PoolClient } from "pg";

/**
 * A bound query function — matches pg's `pool.query` / `client.query` shape
 * closely enough for callers, returning a `QueryResult`.
 *
 * The generic defaults to `QueryResultRow` so callers can pass a row type:
 *   const { rows } = await query<UserRow>('SELECT ...');
 */
export type QueryFn = <R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
) => Promise<QueryResult<R>>;

/**
 * A transaction runner — takes an async callback that receives a connected
 * client and returns a result. Mirrors `masterTransaction` / pool-bound
 * `transaction` helpers.
 */
export type TransactionFn = <T = unknown>(
    asyncFn: (client: PoolClient) => Promise<T>,
) => Promise<T>;

/**
 * The per-request tenant database context attached by middleware as `req.db`.
 * Provides tenant-scoped `query` + `transaction` helpers plus identifying
 * metadata about which tenant/database is in play.
 */
export interface DbContext {
    query: QueryFn;
    transaction: TransactionFn;
    tenantId: number | null;
    tenantSlug?: string | null;
    databaseName?: string | null;
    isMaster?: boolean;
    pool?: unknown;
}

/**
 * Minimal shape of an authenticated user attached to `req.user` by auth
 * middleware. Permissive by design; tighten as routes are converted.
 */
export interface AuthUser {
    id: number;
    org_id?: number;
    email?: string;
    role?: string;
    role_level?: number;
    tenant_id?: number | null;
    token_version?: number;
    session_id?: string;
    impersonated?: boolean;
    [key: string]: unknown;
}

/**
 * A single time-tracking event row (clock in/out, break start/end).
 */
export interface TimeEntry {
    id?: number;
    user_id?: number;
    entry_type: "clock_in" | "clock_out" | "break_start" | "break_end";
    timestamp: string | Date;
    work_mode?: string;
    approval_status?: string;
    [key: string]: unknown;
}

/**
 * The attendance state derived from a sequence of time entries.
 */
export type AttendanceState = "logged_out" | "on_floor" | "on_break";

/**
 * A computed summary of a single day's time entries.
 */
export interface DaySummary {
    floorMinutes: number;
    breakMinutes: number;
    totalMinutes: number;
    workMode: string;
    entries: TimeEntry[];
}

/**
 * A row from the master `tenants` table. Permissive by design; tighten over
 * time as the tenant lifecycle code is converted.
 */
export interface TenantRow {
    id: number;
    slug: string;
    db_name: string;
    db_host?: string | null;
    org_name?: string;
    plan?: string;
    features?: Record<string, unknown> | string | null;
    status?: string;
    is_active?: boolean;
    max_users?: number | null;
    max_storage_mb?: number | null;
    created_at?: string | Date;
    [key: string]: unknown;
}

export type { QueryResult, QueryResultRow, PoolClient };
