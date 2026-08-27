/**
 * Route inventory — walks an Express app and lists every mounted endpoint.
 *
 * WHY THIS EXISTS (Phase B, task B1)
 *   Phases C and G move ~30 routers and split 4,000-line route files apart. The
 *   single worst failure mode in that work is silently DROPPING or RENAMING an
 *   endpoint: nothing throws, tests that don't cover it still pass, and the
 *   break only surfaces as a 404 in production.
 *
 *   `__tests__/routes.snapshot.test.ts` snapshots this inventory, so any such
 *   change fails CI with an exact diff of what moved.
 *
 * IMPLEMENTATION NOTE
 *   Express 5 exposes the stack as `app.router.stack` (Express 4 used
 *   `app._router.stack`). Both are handled. Layers are walked recursively so
 *   nested routers — e.g. `routes/tasks/index.ts`, which mounts crud/backlog/
 *   comments/... under `/api/tasks` — are fully expanded.
 */

export interface RouteEntry {
    /** Uppercase HTTP method, or "USE" for middleware-only mounts. */
    method: string;
    /** Full path from the app root, e.g. "/api/tasks/:id/comments". */
    path: string;
}

type Matcher = (input: string) => false | { path: string; params: Record<string, string> };

interface Layer {
    name?: string;
    /** Express 4 only. Express 5 removed this in favour of `matchers`. */
    regexp?: RegExp & { fast_slash?: boolean };
    path?: string;
    /** Express 5: compiled path matchers that also report what they matched. */
    matchers?: Matcher[];
    keys?: Array<{ name: string | number }>;
    route?: {
        path?: string | string[];
        methods?: Record<string, boolean>;
        stack?: Layer[];
    };
    handle?: {
        stack?: Layer[];
    };
}

/**
 * Property used to stash a router's mount path at registration time.
 *
 * WHY INSTRUMENTATION IS REQUIRED
 *   Express 4 kept the mount path recoverable from `layer.regexp`. Express 5
 *   removed it: a layer carries only opaque matcher functions, and a matcher
 *   accepts ONLY its exact mount path — probing `/api/...` against a router
 *   mounted at `/api/auth` simply returns false, so the prefix cannot be
 *   reverse-engineered.
 *
 *   `instrumentExpress()` therefore records each mount path as `use()` is
 *   called, which is exact and cheap. It must run BEFORE the app module is
 *   loaded (see __tests__/routes.snapshot.test.ts).
 */
export const MOUNT_PATH_KEY = "__ainoMountPath";

type Instrumentable = {
    use: (...args: unknown[]) => unknown;
};

/**
 * Patch `app.use` / `Router.use` so every mounted handler remembers the path
 * it was mounted at. Idempotent, and safe to leave installed — it only adds a
 * hidden property.
 *
 * @param express the `express` module object
 */
export function instrumentExpress(express: unknown): void {
    const ex = express as {
        application?: Instrumentable & { [k: string]: unknown };
        Router?: { (): unknown; [k: string]: unknown };
    };

    const patch = (target: Instrumentable | undefined, label: string): void => {
        if (!target || typeof target.use !== "function") return;
        // Own-property check: an inherited flag from another instance must not
        // suppress patching this one.
        if (Object.prototype.hasOwnProperty.call(target, `${MOUNT_PATH_KEY}_patched`)) return;

        const originalUse = target.use;
        target.use = function patchedUse(this: unknown, ...args: unknown[]) {
            const first = args[0];
            if (typeof first === "string") {
                for (const handler of args.slice(1)) {
                    if (typeof handler === "function" || (handler && typeof handler === "object")) {
                        try {
                            // The SAME router object can be mounted more than
                            // once (e.g. `app.use('/api/admin', r)` and
                            // `app.use('/api/admin/tenants', r)`). Keep every
                            // path so walk() can expand each mount separately —
                            // overwriting would silently lose one of them.
                            const existing = (handler as Record<string, unknown>)[MOUNT_PATH_KEY];
                            const paths = Array.isArray(existing) ? [...existing as string[]] : [];
                            if (!paths.includes(first)) paths.push(first);

                            Object.defineProperty(handler, MOUNT_PATH_KEY, {
                                value: paths,
                                enumerable: false,
                                configurable: true,
                                writable: true,
                            });
                        } catch { /* frozen handler — skip */ }
                    }
                }
            }
            return originalUse.apply(this, args);
        };
        (target as Record<string, unknown>)[`${MOUNT_PATH_KEY}_patched`] = true;
        void label;
    };

    patch(ex.application as Instrumentable, "application");

    // Express 5 gives every Router its own `use` (instances do NOT share a
    // prototype), so patching a prototype is useless. Wrap the factory and
    // patch each instance as it is created.
    const mod = express as Record<string, unknown>;
    if (typeof mod.Router === "function" && !mod[`${MOUNT_PATH_KEY}_routerPatched`]) {
        const OriginalRouter = mod.Router as (...a: unknown[]) => Instrumentable;
        const WrappedRouter = function wrappedRouter(...args: unknown[]) {
            const instance = OriginalRouter(...args);
            patch(instance, "router-instance");
            return instance;
        };
        // Preserve statics such as Router.use / Router.param.
        Object.assign(WrappedRouter, OriginalRouter);
        mod.Router = WrappedRouter;
        mod[`${MOUNT_PATH_KEY}_routerPatched`] = true;
    }
}

/**
 * Recover the literal prefix a router was mounted at.
 *
 * Preference order:
 *   1. the path recorded by instrumentExpress() — exact
 *   2. `layer.path` when Express sets it
 *   3. Express 4's `layer.regexp` reconstruction
 */
function mountPathsOf(layer: Layer): string[] {
    const recorded = (layer.handle as Record<string, unknown> | undefined)?.[MOUNT_PATH_KEY];
    if (Array.isArray(recorded) && recorded.length > 0) {
        return (recorded as string[]).map((p) => (p === "/" ? "" : p));
    }
    if (typeof recorded === "string") return [recorded === "/" ? "" : recorded];

    return [mountPathOf(layer)];
}

function mountPathOf(layer: Layer): string {
    if (typeof layer.path === "string" && layer.path) return layer.path;

    // Express 5 with no recorded path: the prefix is unrecoverable, so treat
    // it as root rather than inventing one.
    if (Array.isArray(layer.matchers) && layer.matchers.length > 0) return "";

    // ── Express 4 ──
    const re = layer.regexp;
    if (!re || re.fast_slash) return "";

    let src = re.source
        .replace(/^\^/, "")
        .replace(/\$$/, "")
        .replace(/\\\/\?\(\?=\\\/\|\$\)$/, "")
        .replace(/\(\?=\\\/\|\$\)$/, "")
        .replace(/\\\/\?$/, "");

    const keys = layer.keys || [];
    let keyIdx = 0;
    src = src.replace(/\(\?:\(\[\^\\\/\]\+\?\)\)|\(\[\^\\\/\]\+\?\)/g, () => {
        const k = keys[keyIdx++];
        return k ? `:${k.name}` : ":param";
    });

    return src
        .replace(/\\\//g, "/")
        .replace(/\\\./g, ".")
        .replace(/\\-/g, "-")
        .replace(/[()?]/g, "");
}

/** Join a parent prefix and a child path into one clean path. */
function joinPaths(prefix: string, sub: string): string {
    const a = (prefix || "").replace(/\/+$/, "");
    const b = (sub || "").replace(/^\/+/, "");
    if (!a && !b) return "/";
    if (!b) return a || "/";
    return `${a}/${b}`;
}

function walk(stack: Layer[], prefix: string, out: RouteEntry[], depth: number): void {
    // Cheap cycle guard — real apps never nest this deep.
    if (!Array.isArray(stack) || depth > 12) return;

    for (const layer of stack) {
        if (layer.route) {
            // A concrete endpoint.
            const paths = Array.isArray(layer.route.path)
                ? layer.route.path
                : [layer.route.path || ""];
            const enabled = Object.keys(layer.route.methods || {})
                .filter((m) => (layer.route!.methods as Record<string, boolean>)[m])
                .map((m) => m.toUpperCase())
                .sort();

            // `router.all()` registers every verb Node knows about (40+),
            // which would bury the snapshot in noise. Collapse it to "ALL".
            const methods = enabled.length > 20 ? ["ALL"] : enabled;

            for (const p of paths) {
                for (const method of methods) {
                    out.push({ method, path: joinPaths(prefix, String(p)) });
                }
            }
            continue;
        }

        // A nested router — recurse once per mount point, since the same
        // router object may be mounted at several paths.
        const nested = layer.handle?.stack;
        if (nested) {
            for (const mount of mountPathsOf(layer)) {
                walk(nested, joinPaths(prefix, mount), out, depth + 1);
            }
        }
    }
}

/**
 * Every routable endpoint in the app, sorted and de-duplicated.
 *
 * Middleware-only mounts are intentionally excluded: they are an
 * implementation detail that Phase C will legitimately reorganise, whereas the
 * set of endpoints is the public contract that must not change.
 */
export function listRoutes(app: unknown): RouteEntry[] {
    const a = app as { router?: { stack?: Layer[] }; _router?: { stack?: Layer[] } };
    const stack = a?.router?.stack || a?._router?.stack;
    if (!stack) return [];

    const out: RouteEntry[] = [];
    walk(stack, "", out, 0);

    const seen = new Set<string>();
    return out
        .filter((r) => {
            const k = `${r.method} ${r.path}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        })
        .sort((x, y) => (x.path === y.path ? x.method.localeCompare(y.method) : x.path.localeCompare(y.path)));
}

/** Stable `METHOD /path` lines — the snapshot format. */
export function formatRoutes(routes: RouteEntry[]): string[] {
    return routes.map((r) => `${r.method.padEnd(6)} ${r.path}`);
}
