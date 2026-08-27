/**
 * Dependency rules — the layering contract (Phase B, task B2 / guardrail GR1).
 *
 * TARGET ARCHITECTURE
 *
 *     routes  ->  service  ->  repository  ->  db
 *        \                                      /
 *         `----------> platform/ <-------------'
 *
 *   - Route files parse HTTP and delegate. They must not contain SQL.
 *   - Repositories own SQL. They must not know about express/req/res.
 *   - A module may use another module's SERVICE, never its REPOSITORY.
 *   - `platform/` holds shared infrastructure and depends on no feature.
 *
 * SEVERITY: most rules are `warn` today because the current tree predates the
 * contract (Phase G migrates ~20 modules). Each rule flips to `error` as its
 * module lands — see GR1. Rules that already hold are `error` immediately so
 * they can never regress.
 *
 * Run: npm run lint:deps
 */
module.exports = {
    forbidden: [
        // ── Already true — locked at error so it stays true ─────────────────
        {
            name: "no-circular",
            severity: "error",
            comment:
                "Circular imports make load order significant and break the " +
                "module extraction in Phase G. Break the cycle by moving the " +
                "shared piece into platform/ or by injecting the dependency.",
            // KNOWN DEBT (2 cycles, both pre-existing and deliberately broken
            // with a lazy require() at the call site):
            //
            //   utils/migrationRunner <-> utils/tenantManager
            //     migrationRunner.sweepAllTenants() needs forEachTenant();
            //     tenantManager.createTenant() needs runTenantMigrations().
            //     Phase G resolves this by moving both to platform/db/.
            //
            //   services/status/broadcaster -> utils/ws -> services/status
            //     The broadcaster pushes through the WS fan-out, which reads
            //     status. Phase G/D2 resolves it by injecting the sender.
            //
            // Excluded so CI stays green on existing debt while still failing
            // on any NEW cycle. Remove each entry as Phase G untangles it.
            from: {
                pathNot: [
                    "^utils/(migrationRunner|tenantManager)\\.ts$",
                    "^services/status/(broadcaster|index)\\.ts$",
                    "^utils/ws\\.ts$",
                ],
            },
            to: { circular: true },
        },
        {
            name: "platform-is-independent",
            severity: "error",
            comment:
                "platform/ is shared infrastructure (storage, db, logging, " +
                "route inventory). It must not depend on feature code, or it " +
                "cannot be extracted or reused.",
            from: { path: "^platform/" },
            to: { path: "^(routes|services|middleware)/" },
        },
        {
            name: "no-orphan-platform",
            severity: "warn",
            comment: "Unused platform module — delete it or wire it up.",
            from: {
                orphan: true,
                pathNot: [
                    "\\.d\\.ts$",
                    "^types/",
                    "^__tests__/",
                    // Consumed only by tests, which are excluded from the
                    // cruise, so it looks orphaned from here.
                    "^platform/routeInventory\\.ts$",
                ],
            },
            to: {},
        },

        // ── The layering contract — warn now, error per-module in Phase G ───
        {
            name: "routes-no-direct-db",
            severity: "warn",
            comment:
                "LAYERING: a route must not import the db module directly. " +
                "Go through a service, which goes through a repository. " +
                "(Flip to error per module as Phase G migrates it.)",
            from: { path: "^routes/" },
            to: { path: "^db\\.ts$" },
        },
        {
            name: "repository-no-express",
            severity: "error",
            comment:
                "LAYERING: a repository owns SQL only. Importing express means " +
                "HTTP concerns leaked into the data layer, which makes it " +
                "untestable without a request.",
            from: { path: "repository\\.ts$" },
            to: { path: "^(express|middleware/)" },
        },
        {
            name: "no-cross-module-repository",
            severity: "error",
            comment:
                "LAYERING: use another module's SERVICE, never its REPOSITORY. " +
                "Reaching into a sibling's data layer defeats the boundary.",
            from: { path: "^modules/([^/]+)/" },
            to: { path: "^modules/(?!$1)[^/]+/.*repository\\.ts$" },
        },

        // ── GR1: migrated modules are held at ERROR ──────────────────────────
        // A file under modules/ has already been through Phase G, so the
        // contract is not aspirational there — it is enforced. Legacy paths
        // stay at `warn` above and become errors as each one is migrated.
        {
            name: "module-routes-no-direct-db",
            severity: "error",
            comment:
                "LAYERING (migrated module): a module route must not touch db.ts. " +
                "Call the module service, which calls the module repository.",
            from: { path: "^modules/[^/]+/.*routes\\.ts$" },
            to: { path: "^db\\.ts$" },
        },
        {
            name: "module-service-no-direct-db",
            severity: "error",
            comment:
                "LAYERING (migrated module): a service orchestrates; it must not " +
                "own SQL or a connection. Put the query in the repository.",
            from: { path: "^modules/[^/]+/.*service\\.ts$" },
            to: { path: "^db\\.ts$" },
        },
        {
            name: "module-routes-no-repository",
            severity: "error",
            comment:
                "LAYERING (migrated module): routes may not skip the service " +
                "layer and call the repository directly.",
            from: { path: "^modules/[^/]+/.*routes\\.ts$" },
            to: { path: "^modules/[^/]+/.*repository\\.ts$" },
        },
        {
            name: "module-repository-no-service",
            severity: "error",
            comment:
                "LAYERING (migrated module): dependencies point one way only " +
                "(routes -> service -> repository). A repository importing a " +
                "service is an inverted layer and usually a cycle in waiting.",
            from: { path: "^modules/[^/]+/.*repository\\.ts$" },
            to: { path: "^modules/[^/]+/.*service\\.ts$" },
        },

        // ── General hygiene ─────────────────────────────────────────────────
        {
            name: "no-deprecated-core",
            severity: "error",
            from: {},
            to: { dependencyTypes: ["core"], path: "^(punycode|domain|sys)$" },
        },
        {
            name: "not-to-dev-dep",
            severity: "error",
            comment:
                "Production code must not import a devDependency — it is absent " +
                "from the runtime image (npm ci --omit=dev).",
            from: { path: "^(routes|services|utils|platform|middleware)/", pathNot: "__tests__" },
            to: { dependencyTypes: ["npm-dev"] },
        },
        {
            name: "no-non-package-json",
            severity: "error",
            comment: "Dependency used but not declared in package.json.",
            from: {},
            to: { dependencyTypes: ["unknown", "undetermined", "npm-no-pkg", "npm-unknown"] },
        },
    ],

    options: {
        doNotFollow: { path: "node_modules" },
        exclude: {
            path: [
                "node_modules",
                "^dist/",
                "^uploads/",
                "^graphify-out/",
                "\\.test\\.ts$",
                "^__tests__/",
            ],
        },
        tsPreCompilationDeps: true,
        tsConfig: { fileName: "tsconfig.json" },
        enhancedResolveOptions: {
            exportsFields: ["exports"],
            conditionNames: ["require", "node", "default"],
            extensions: [".ts", ".js", ".json"],
        },
        reporterOptions: {
            text: { highlightFocused: true },
        },
    },
};
