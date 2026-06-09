/**
 * API-layer helper types.
 *
 * The frontend uses axios; every endpoint helper returns a `Promise` of an
 * axios `AxiosResponse<T>`. These aliases give callers a concise way to type
 * the `data` payload without importing axios internals everywhere.
 */
import type { AxiosResponse } from "axios";

/** An axios response whose `.data` is typed as `T`. */
export type ApiResponse<T = unknown> = Promise<AxiosResponse<T>>;

/** A standard error body returned by the server's error handler. */
export interface ApiError {
    error?: string;
    message?: string;
    code?: string;
    [key: string]: unknown;
}

/** A paginated list envelope used by several list endpoints. */
export interface Paginated<T> {
    items: T[];
    total: number;
    page?: number;
    page_size?: number;
    [key: string]: unknown;
}