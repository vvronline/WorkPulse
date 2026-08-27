/** Public types for the attendance module boundary. */

export interface AttendanceDb {
    query: (
        sql: string,
        params?: unknown[],
    ) => Promise<{ rows: any[]; rowCount: number }>;
    transaction?: <T>(fn: (client: AttendanceDb) => Promise<T>) => Promise<T>;
}

export interface CreateOvertimeInput {
    date: string;
    hours: number;
    reason: string;
}

export interface AttendanceActor {
    userId: number;
    orgId: number | null;
    tenantId: number | null;
}

export type Theme = "dark" | "light";

export interface ManualBreak {
    start: string;
    end: string;
}

export interface ManualEntryInput {
    date: string;
    clockIn: string;
    clockOut: string | null;
    breaks: ManualBreak[];
    timezoneOffset: number;
    workMode: "office" | "remote" | "hybrid";
    toUtc: (time: string) => string;
}

export class AttendanceError extends Error {
    constructor(
        message: string,
        readonly statusCode = 400,
    ) {
        super(message);
        this.name = "AttendanceError";
    }
}