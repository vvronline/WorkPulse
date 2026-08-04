/**
 * Guards the `@/*` path alias.
 *
 * The alias is declared in THREE places that must agree — tsconfig.json
 * (`paths`), app.config.ts (`experiments.tsconfigPaths`, for Metro) and
 * jest.config.js (`moduleNameMapper`). If any one drifts, imports break in
 * that environment ONLY, which is a confusing failure to debug (green tests,
 * red bundle — or vice versa).
 *
 * This suite fails loudly if the Jest mapping stops resolving, and asserts the
 * other two declarations are still present in their config files.
 */
import { readFileSync } from "fs";
import { join } from "path";

// Resolved through the alias itself: if moduleNameMapper is wrong, this import
// throws at module load and the whole suite fails.
import { qk } from "@/query/queryKeys";
import { getErrorMessage } from "@/apiError";

const root = join(__dirname, "..", "..");

describe("@/* path alias", () => {
  it("resolves through Jest's moduleNameMapper", () => {
    expect(typeof qk.admin.home).toBe("function");
    expect(typeof getErrorMessage).toBe("function");
  });

  it("resolves to the same module as the equivalent relative import", () => {
    // Two specifiers must not produce two separate module instances — that
    // would duplicate module-level state (caches, singletons).
    const viaRelative = require("../query/queryKeys");
    const viaAlias = require("@/query/queryKeys");
    expect(viaAlias).toBe(viaRelative);
  });

  it("is declared in tsconfig.json for tsc and the editor", () => {
    const tsconfig = readFileSync(join(root, "tsconfig.json"), "utf8");
    expect(tsconfig).toMatch(/"@\/\*"/);
    expect(tsconfig).toMatch(/"paths"/);
    // `baseUrl` must stay OUT: TypeScript 6 errors on it (TS5101) and `paths`
    // has resolved relative to the tsconfig since TS 5.0.
    expect(tsconfig).not.toMatch(/"baseUrl"/);
  });

  it("is enabled for the Metro bundler in app.config.ts", () => {
    const appConfig = readFileSync(join(root, "app.config.ts"), "utf8");
    expect(appConfig).toMatch(/tsconfigPaths:\s*true/);
  });
});
