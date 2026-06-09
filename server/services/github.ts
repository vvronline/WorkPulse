// GitHub OAuth + REST helper.
//
// Why this exists
// ───────────────
// Stage 3 originally shipped a "paste the webhook secret into GitHub yourself"
// flow. The follow-up was the real Jira-style connection: an admin clicks
// "Connect GitHub", logs in on github.com, picks repos, and we automatically
// install a webhook on each one. That's what this service implements.
//
// Flow
// ────
//   1. Admin clicks Connect → GET /api/integrations/github/oauth/start
//      generates a random `state`, persists it in Redis (5-min TTL) bound
//      to (org_id, user_id), and redirects to github.com/login/oauth/authorize.
//   2. GitHub redirects back to /api/integrations/github/oauth/callback?code=…&state=…
//      We exchange the code for an access token, then upsert an
//      org_integrations row + the token in org_integration_secrets.
//   3. Admin picks repositories from /api/integrations/github/repos.
//   4. POST /api/integrations/github/repos/connect with selected repos:
//      we generate a webhook signing secret, hit the GitHub
//      `POST /repos/{owner}/{repo}/hooks` API to install the webhook
//      pointing at our /api/webhooks/github/:integrationId, and persist
//      the hook ids back so we can delete them on disconnect.
//
// Required env (set on Railway / .env):
//   GITHUB_CLIENT_ID
//   GITHUB_CLIENT_SECRET
//   PUBLIC_BASE_URL   (optional; auto-derived from request host when omitted)
//
// Without those two env vars the OAuth endpoints return a clear setup error
// so a dev can still test the rest of the app.

import crypto from "crypto";
import type { Request } from "express";
import * as redis from "../redis";
import { logger } from "../utils/logger";

const GITHUB_API = "https://api.github.com";
const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";
const SCOPES = ["repo", "admin:repo_hook", "read:user", "user:email"];
const STATE_TTL = 5 * 60; // 5 minutes

interface OAuthStatePayload {
    orgId: number;
    userId: number;
    tenantId: number | null;
    ts: number;
}

interface OAuthStateFallbackEntry {
    payload: OAuthStatePayload;
    expiresAt: number;
}

interface GitHubTokenResponse {
    access_token: string;
    scope?: string;
    token_type?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
}

interface GitHubRepoSummary {
    full_name: string;
    name: string;
    owner: string | undefined;
    private: boolean;
    description: string | null;
    default_branch: string;
    html_url: string;
}

interface GitHubApiError extends Error {
    status?: number;
    body?: unknown;
}

declare global {
    // eslint-disable-next-line no-var
    var __ghStateFallback: Map<string, OAuthStateFallbackEntry> | undefined;
}

function isConfigured(): boolean {
    return !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}

function publicBaseUrl(req: Request): string {
    if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
    const proto = (req.headers["x-forwarded-proto"] as string) || (req.secure ? "https" : "http");
    const host = (req.headers["x-forwarded-host"] as string) || req.headers.host;
    return `${proto}://${host}`;
}

function callbackUrl(req: Request): string {
    return `${publicBaseUrl(req)}/api/integrations/github/oauth/callback`;
}

function webhookUrl(req: Request, integrationId: string | number): string {
    return `${publicBaseUrl(req)}/api/webhooks/github/${integrationId}`;
}

// ─── OAuth state (anti-CSRF for the round-trip) ────────────────────────────
// We can't use cookies because GitHub round-trips through a top-level browser
// redirect. We sign a random nonce, persist it server-side in Redis, and only
// accept it once.
// redis.set/get already JSON-(de)serialise values, so we pass the object
// directly. Redis isn't required — when it's unavailable we fall back to an
// in-process Map (good for single-instance dev/test; in prod every node hits
// Redis so OAuth round-trips work across replicas).
async function issueState(orgId: number, userId: number, tenantId: number | null): Promise<string> {
    const state = crypto.randomBytes(24).toString("hex");
    const payload: OAuthStatePayload = { orgId, userId, tenantId, ts: Date.now() };
    const key = `gh:oauth:state:${state}`;
    await redis.set(key, payload, STATE_TTL);
    if (!global.__ghStateFallback) global.__ghStateFallback = new Map();
    global.__ghStateFallback.set(state, { payload, expiresAt: Date.now() + STATE_TTL * 1000 });
    return state;
}

async function consumeState(state: string): Promise<OAuthStatePayload | null> {
    const key = `gh:oauth:state:${state}`;
    const cached = await redis.get<OAuthStatePayload>(key);
    if (cached) {
        await redis.del(key);
        // Best-effort cleanup of the local fallback so we don't accept the
        // same state twice if Redis hiccups between issue/consume.
        if (global.__ghStateFallback) global.__ghStateFallback.delete(state);
        return cached;
    }
    if (global.__ghStateFallback) {
        const row = global.__ghStateFallback.get(state);
        if (row && row.expiresAt > Date.now()) {
            global.__ghStateFallback.delete(state);
            return row.payload;
        }
    }
    return null;
}

function buildAuthorizeUrl(req: Request, state: string): string {
    const params = new URLSearchParams({
        client_id: process.env.GITHUB_CLIENT_ID || "",
        redirect_uri: callbackUrl(req),
        scope: SCOPES.join(" "),
        state,
        allow_signup: "false",
    });
    return `${GITHUB_AUTHORIZE}?${params.toString()}`;
}

async function exchangeCodeForToken(code: string, req: Request): Promise<GitHubTokenResponse> {
    const body = new URLSearchParams({
        client_id: process.env.GITHUB_CLIENT_ID || "",
        client_secret: process.env.GITHUB_CLIENT_SECRET || "",
        code,
        redirect_uri: callbackUrl(req),
    });
    const res = await fetch(GITHUB_TOKEN, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`GitHub token exchange failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as GitHubTokenResponse;
    if (data.error) {
        throw new Error(`GitHub token exchange error: ${data.error_description || data.error}`);
    }
    if (!data.access_token) {
        throw new Error("GitHub token exchange returned no access_token");
    }
    return data; // { access_token, scope, token_type, refresh_token?, expires_in? }
}

// Thin wrapper around the REST API. Uses the personal/installation OAuth
// token; for very-high-traffic apps you'd want to switch to a GitHub App
// with installation tokens, but the OAuth approach is plenty for a
// per-org connect.
async function gh<T = unknown>(token: string, method: string, pathname: string, body?: unknown): Promise<T | null> {
    const res = await fetch(`${GITHUB_API}${pathname}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "WorkPulse",
            ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
        const err: GitHubApiError = new Error(
            (json.message as string) || `GitHub API ${method} ${pathname} failed (${res.status})`,
        );
        err.status = res.status;
        err.body = json;
        throw err;
    }
    return json as T;
}

async function getViewer(token: string): Promise<unknown> {
    return gh(token, "GET", "/user");
}

interface RawGitHubRepo {
    full_name: string;
    name: string;
    owner?: { login?: string };
    private?: boolean;
    description: string | null;
    default_branch: string;
    html_url: string;
    permissions?: { admin?: boolean; maintain?: boolean; push?: boolean };
}

// List repos the user has push access to. We page through up to 5 pages
// (500 repos) which is plenty for almost any org.
async function listAccessibleRepos(token: string): Promise<GitHubRepoSummary[]> {
    const out: GitHubRepoSummary[] = [];
    for (let page = 1; page <= 5; page++) {
        const rows = await gh<RawGitHubRepo[]>(
            token,
            "GET",
            `/user/repos?per_page=100&page=${page}&affiliation=owner,collaborator,organization_member&sort=updated`,
        );
        if (!Array.isArray(rows) || rows.length === 0) break;
        for (const r of rows) {
            // Only repos where we can manage webhooks.
            if (r.permissions?.admin || r.permissions?.maintain || r.permissions?.push) {
                out.push({
                    full_name: r.full_name,
                    name: r.name,
                    owner: r.owner?.login,
                    private: !!r.private,
                    description: r.description,
                    default_branch: r.default_branch,
                    html_url: r.html_url,
                });
            }
        }
        if (rows.length < 100) break;
    }
    return out;
}

interface RawGitHubHook {
    id: number;
    config?: { url?: string };
}

// Install (or re-install) our webhook on a single repo. Returns the GitHub
// hook id so we can delete it on disconnect. If a hook with the same URL
// already exists we return the existing id instead of creating a duplicate
// (GitHub returns 422 on duplicates).
async function ensureRepoWebhook(token: string, fullName: string, hookUrl: string, hookSecret: string): Promise<number> {
    const existing = await gh<RawGitHubHook[]>(token, "GET", `/repos/${fullName}/hooks?per_page=100`);
    if (Array.isArray(existing)) {
        const match = existing.find((h) => h.config?.url === hookUrl);
        if (match) {
            // Re-issue the secret so a rotated secret is honoured.
            await gh(token, "PATCH", `/repos/${fullName}/hooks/${match.id}`, {
                config: {
                    url: hookUrl,
                    content_type: "json",
                    secret: hookSecret,
                    insecure_ssl: "0",
                },
                events: ["create", "push", "pull_request"],
                active: true,
            });
            return match.id;
        }
    }
    const created = await gh<RawGitHubHook>(token, "POST", `/repos/${fullName}/hooks`, {
        name: "web",
        active: true,
        events: ["create", "push", "pull_request"],
        config: {
            url: hookUrl,
            content_type: "json",
            secret: hookSecret,
            insecure_ssl: "0",
        },
    });
    return created!.id;
}

async function deleteRepoWebhook(token: string, fullName: string, hookId: number): Promise<void> {
    try {
        await gh(token, "DELETE", `/repos/${fullName}/hooks/${hookId}`);
    } catch (e) {
        const err = e as GitHubApiError;
        // 404 = already gone — that's fine.
        if (err.status !== 404) {
            logger.warn({ err: err.message, fullName, hookId }, "Failed to delete GitHub hook");
        }
    }
}

export {
    isConfigured,
    issueState,
    consumeState,
    buildAuthorizeUrl,
    exchangeCodeForToken,
    callbackUrl,
    webhookUrl,
    publicBaseUrl,
    getViewer,
    listAccessibleRepos,
    ensureRepoWebhook,
    deleteRepoWebhook,
};