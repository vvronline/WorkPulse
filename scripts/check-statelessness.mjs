/**
 * GR5 (static half) — forbid new in-process state for cross-replica concerns.
 *
 * Phase D moved call/meeting signal buffers, meeting-leave timers and the
 * membership cache out of `ws.ts` Maps and into Redis. That work fails
 * *silently* if someone reintroduces a module-level Map: a call between two
 * users on different replicas simply never connects, and nothing logs an
 * error.
 *
 * This guard greps for module-level mutable collections in the realtime
 * transport layer. It is intentionally dumb and intentionally noisy — the
 * dynamic half (server/__tests__/statelessness.crossInstance.test.ts) proves
 * the behaviour; this one stops the pattern from reappearing at all.
 */
import fs from "node:fs";
import path from "node:path";

// State that is legitimately per-process: a socket registry cannot be shared,
// because the sockets themselves are local to the process holding them.
const ALLOWED = new Set([
  // A socket registry cannot be shared: the sockets are owned by this process.
  // Cross-replica delivery goes through the Redis `ws:broadcast` fan-out.
  "utils/ws.ts:clients",
  // A setTimeout handle is not serialisable, so the TIMER stays local — but
  // Redis owns the cancellation token (meetingLeaveStore), so a rejoin on
  // replica B correctly voids a cleanup scheduled on replica A.
  "utils/ws.ts:pendingMeetingLeaves",
  "realtime/meetingLeaveStore.ts:localTokens",
  // L1 read-through caches in front of Redis. Allowed ONLY inside the adapter
  // modules, which treat Redis as the source of truth and fail closed in
  // production when it is unavailable.
  "realtime/membershipCache.ts:l1",
  "realtime/signalStore.ts:local",
]);

// Files that participate in cross-replica realtime behaviour.
const WATCHED = [
  "utils/ws.ts",
  "realtime/signalStore.ts",
  "realtime/membershipCache.ts",
  "realtime/meetingLeaveStore.ts",
];

const serverRoot = path.resolve("server");
const failures = [];

// Module-level (column 0) `const x = new Map()/new Set()/{}` declarations.
const DECL = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*new (?:Map|Set|WeakMap)\s*[(<]/gm;

for (const rel of WATCHED) {
  const full = path.join(serverRoot, rel);
  if (!fs.existsSync(full)) continue;
  const source = fs.readFileSync(full, "utf8");

  for (const match of source.matchAll(DECL)) {
    const name = match[1];
    const key = `${rel}:${name}`;
    if (ALLOWED.has(key)) continue;
    const line = source.slice(0, match.index).split(/\r?\n/).length;
    failures.push(
      `${rel}:${line} — module-level '${name}' holds cross-replica state in process memory.\n` +
      `      Move it to Redis (see server/realtime/signalStore.ts), or add it to ALLOWED\n` +
      `      in scripts/check-statelessness.mjs with a written justification.`,
    );
  }
}

// The Phase D removals must stay removed.
const REMOVED = ["_callSignalBuffers", "_meetingSignalBuffers", "_membershipCache"];
const wsPath = path.join(serverRoot, "utils/ws.ts");
if (fs.existsSync(wsPath)) {
  const ws = fs.readFileSync(wsPath, "utf8");
  for (const symbol of REMOVED) {
    if (ws.includes(symbol)) {
      failures.push(`utils/ws.ts — '${symbol}' was removed in Phase D and must not return.`);
    }
  }
}

if (failures.length) {
  console.error("Statelessness guard (GR5) failed:\n" + failures.map((f) => `  ${f}`).join("\n"));
  process.exit(1);
}

console.log(`Statelessness guard passed (${WATCHED.length} realtime files checked).`);
