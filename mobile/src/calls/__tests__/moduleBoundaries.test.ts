/**
 * MODULE-BOUNDARY GUARD for the calls separation (src/calls/{shared,p2p,group}).
 *
 * The 1:1 (p2p) and group-call modules must stay INDEPENDENT: the earlier
 * production regressions ("call UI disappears but voice keeps going", stale
 * "Return to call" banner, blocked ring navigation) were all caused by group
 * code sharing/clobbering 1:1 state. This test statically scans the module
 * folders and FAILS THE SUITE if:
 *   • anything under src/calls/p2p imports from src/calls/group (or vice
 *     versa) — cross-module coupling is only allowed through src/calls/shared;
 *   • anything under src/calls/shared imports from p2p or group — shared must
 *     stay dependency-free of both.
 *
 * This is the CI guardrail (the project has no ESLint infra, so a jest test
 * plays the role of import/no-restricted-paths).
 *
 * NOTE ON TYPINGS: test files are excluded from the app tsconfig (see
 * mobile/tsconfig.json "exclude") and run under jest's node environment via
 * babel — so the node/jest globals are declared inline below instead of
 * pulling @types/node / @types/jest into the RN dependency tree.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const require: (id: string) => any;
declare const __dirname: string;
declare function describe(name: string, fn: () => void): void;
declare function it(name: string, fn: () => void): void;
declare function expect(actual: unknown): any;

const fs = require("fs");
const path = require("path");

const CALLS_ROOT: string = path.resolve(__dirname, "..");

function listSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue; // tests may import anything
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Extract every static/dynamic import specifier from a source file. */
function importSpecifiers(file: string): string[] {
  const src: string = fs.readFileSync(file, "utf8");
  const specs: string[] = [];
  const patterns = [
    /import\s+[^"']*?["']([^"']+)["']/g, // import x from "…" / import "…"
    /export\s+[^"']*?from\s+["']([^"']+)["']/g, // export … from "…"
    /require\(\s*["']([^"']+)["']\s*\)/g, // require("…")
    /import\(\s*["']([^"']+)["']\s*\)/g, // import("…")
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) specs.push(m[1]);
  }
  return specs;
}

/** Resolve a relative specifier against the importing file's directory. */
function resolveTarget(file: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // package import — out of scope
  return path.resolve(path.dirname(file), spec);
}

function violations(fromDir: string, forbiddenDir: string): string[] {
  const found: string[] = [];
  for (const file of listSourceFiles(fromDir)) {
    for (const spec of importSpecifiers(file)) {
      const target = resolveTarget(file, spec);
      if (!target) continue;
      if (
        target.startsWith(forbiddenDir + path.sep) ||
        target === forbiddenDir
      ) {
        found.push(`${path.relative(CALLS_ROOT, file)} → "${spec}"`);
      }
    }
  }
  return found;
}

const P2P: string = path.join(CALLS_ROOT, "p2p");
const GROUP: string = path.join(CALLS_ROOT, "group");
const SHARED: string = path.join(CALLS_ROOT, "shared");

describe("calls module boundaries", () => {
  it("p2p must not import from group", () => {
    expect(violations(P2P, GROUP)).toEqual([]);
  });

  it("group must not import from p2p", () => {
    expect(violations(GROUP, P2P)).toEqual([]);
  });

  it("shared must not import from p2p or group", () => {
    expect(violations(SHARED, P2P)).toEqual([]);
    expect(violations(SHARED, GROUP)).toEqual([]);
  });
});