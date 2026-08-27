/**
 * Repository hygiene guard: generated Graphify output must never be tracked.
 *
 * Local graphify-out directories are allowed (and gitignored). This checks the
 * Git index so CI catches accidental `git add -f` or stale tracked artifacts.
 */
import { execFileSync } from "node:child_process";

const tracked = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\0")
  .filter(Boolean);

// During a local cleanup, deleted-but-not-yet-committed paths remain in
// `git ls-files`. Exclude those pending deletions so the guard can validate the
// intended tree. In CI a tracked artifact exists on disk, so it is never in
// this set and still fails.
const deleted = new Set(
  execFileSync("git", ["ls-files", "--deleted", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean),
);

const generated = tracked.filter(
  (file) => /(^|\/)graphify-out(\/|$)/.test(file) && !deleted.has(file),
);

if (generated.length > 0) {
  console.error(
    `Generated Graphify artifacts are tracked (${generated.length} file(s)):\n`
      + generated.map((file) => `  ${file}`).join("\n")
      + "\nRemove them from Git and keep only source/hand-maintained architecture docs.",
  );
  process.exit(1);
}

console.log("Generated-artifact guard passed: no graphify-out files are tracked.");