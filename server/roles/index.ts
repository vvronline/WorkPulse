import type { Express } from "express";

type ProcessRole = "all" | "web" | "realtime" | "worker";

/**
 * Dispatch to a process role.
 *
 * ROLE defaults to `all` for backwards compatibility. Railway can now run the
 * same image as independent web/realtime/worker services.
 */
async function runRole(app?: Express): Promise<void> {
    const role = (process.env.ROLE || "all").toLowerCase() as ProcessRole;
    if (!(["all", "web", "realtime", "worker"] as string[]).includes(role)) {
        throw new Error(`Unknown ROLE=${role}; expected all|web|realtime|worker`);
    }

    if (role === "web") {
        if (!app) throw new Error("ROLE=web requires the Express app");
        return require("./web").runWebRole(app);
    }
    if (role === "realtime") {
        if (!app) throw new Error("ROLE=realtime requires the Express app");
        return require("./realtime").runRealtimeRole(app);
    }
    if (role === "worker") return require("./worker").runWorkerRole();
    if (!app) throw new Error("ROLE=all requires the Express app");
    return require("./all").runAllRole(app);
}

export { runRole };
export type { ProcessRole };