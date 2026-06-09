/**
 * Shared client-side domain types.
 *
 * These describe the core entities that flow through the frontend — users,
 * tasks, sprints, leaves, chat, etc. They mirror the API response shapes
 * produced by the server. They are intentionally permissive where the legacy
 * JS is permissive, and will be tightened over time as components are migrated.
 *
 * Index signatures (`[key: string]: unknown`) are included on several types so
 * that fields not yet enumerated here do not cause type errors during the
 * incremental migration.
 */

/** Generic record alias used throughout the app for loosely-typed objects. */
export type AnyRecord = Record<string, unknown>;

/* ------------------------------------------------------------------ */
/* User & auth                                                         */
/* ------------------------------------------------------------------ */

export interface User {
    id: number;
    username?: string;
    full_name?: string;
    email?: string;
    avatar?: string | null;
    role?: string;
    role_level?: number;
    org_id?: number;
    tenant_id?: number | null;
    tenant_plan?: string;
    tenant_features?: Record<string, boolean> | null;
    has_reports?: boolean;
    impersonated?: boolean;
    impersonated_by_name?: string | null;
    impersonated_tenant_name?: string | null;
    [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* Tasks / agile                                                       */
/* ------------------------------------------------------------------ */

export interface Task {
    id: number;
    issue_key?: string;
    title?: string;
    description?: string | null;
    status?: string;
    priority?: string;
    type?: string;
    assignee_id?: number | null;
    reporter_id?: number | null;
    sprint_id?: number | null;
    parent_id?: number | null;
    project_id?: number | null;
    story_points?: number | null;
    labels?: TaskLabel[];
    created_at?: string;
    updated_at?: string;
    [key: string]: unknown;
}

export interface TaskLabel {
    id: number;
    name: string;
    color?: string;
    [key: string]: unknown;
}

export interface Sprint {
    id: number;
    name?: string;
    goal?: string | null;
    status?: string;
    start_date?: string | null;
    end_date?: string | null;
    project_id?: number | null;
    [key: string]: unknown;
}

export interface Project {
    id: number;
    name?: string;
    key?: string;
    description?: string | null;
    [key: string]: unknown;
}

export interface Comment {
    id: number;
    body?: string;
    author_id?: number;
    author_name?: string;
    created_at?: string;
    [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* Leaves & attendance                                                 */
/* ------------------------------------------------------------------ */

export interface LeaveRequest {
    id: number;
    user_id?: number;
    type?: string;
    status?: string;
    start_date?: string;
    end_date?: string;
    reason?: string | null;
    [key: string]: unknown;
}

export interface LeaveBalance {
    type: string;
    total?: number;
    used?: number;
    remaining?: number;
    [key: string]: unknown;
}

export interface TimeEntry {
    id?: number;
    user_id?: number;
    entry_type: "clock_in" | "clock_out" | "break_start" | "break_end";
    timestamp: string;
    work_mode?: string;
    approval_status?: string;
    [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* Chat                                                                */
/* ------------------------------------------------------------------ */

export interface Conversation {
    id: number;
    name?: string | null;
    is_group?: boolean;
    is_self_chat?: boolean;
    group_name?: string | null;
    other_full_name?: string | null;
    other_avatar?: string | null;
    other_user_id?: number | string;
    unread_count?: number;
    last_message?: ChatMessage | null;
    participants?: User[];
    [key: string]: unknown;
}

export interface ChatMessage {
    id: number;
    conversation_id?: number;
    sender_id?: number;
    body?: string;
    created_at?: string;
    [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* Custom fields                                                       */
/* ------------------------------------------------------------------ */

export interface CustomFieldDef {
    id: number;
    name: string;
    field_key?: string;
    type?: string;
    options?: unknown[];
    required?: boolean;
    [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* Calendar / events                                                   */
/* ------------------------------------------------------------------ */

export interface CalendarEvent {
    id: number;
    title?: string;
    start?: string;
    end?: string | null;
    all_day?: boolean;
    [key: string]: unknown;
}