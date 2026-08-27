import test from "node:test";
import assert from "node:assert/strict";
import { selectOrigin, assertOrigins, cacheHeaders } from "../src/router.js";

const origins = {
  legacy: "https://legacy.up.railway.app",
  web: "https://web.up.railway.app",
  realtime: "https://realtime.up.railway.app",
  spa: "https://spa.aino.org.in",
};

test("legacy mode routes everything to the rollback origin", () => {
  for (const path of ["/", "/api/auth", "/uploads/a", "/ws", "/collab"]) {
    assert.equal(selectOrigin(path, "legacy", origins), origins.legacy);
  }
});

test("split mode routes API and private uploads to web", () => {
  assert.equal(selectOrigin("/api/auth", "split", origins), origins.web);
  assert.equal(selectOrigin("/uploads/tenant_1/a", "split", origins), origins.web);
  assert.notEqual(selectOrigin("/uploads/tenant_1/a", "split", origins), origins.spa);
});

test("split mode routes websocket upgrades to realtime", () => {
  assert.equal(selectOrigin("/ws", "split", origins), origins.realtime);
  assert.equal(selectOrigin("/collab", "split", origins), origins.realtime);
});

test("split mode routes SPA paths to the static origin", () => {
  assert.equal(selectOrigin("/", "split", origins), origins.spa);
  assert.equal(selectOrigin("/tasks/123", "split", origins), origins.spa);
  assert.equal(selectOrigin("/assets/app.abc.js", "split", origins), origins.spa);
});

test("rejects a recursive origin", () => {
  assert.throws(
    () => assertOrigins("aino.org.in", { ...origins, web: "https://aino.org.in" }, "split"),
    /recursively points/,
  );
});

test("legacy mode requires only the rollback origin", () => {
  assert.doesNotThrow(() => assertOrigins("aino.org.in", {
    legacy: origins.legacy,
    web: undefined,
    realtime: undefined,
    spa: undefined,
  }, "legacy"));
});

test("split mode requires every split origin", () => {
  assert.throws(() => assertOrigins("aino.org.in", {
    ...origins,
    realtime: undefined,
  }, "split"), /Missing realtime origin/);
});

test("cache headers distinguish immutable assets from mutable shell files", () => {
  assert.match(cacheHeaders("/assets/app.abc.js"), /immutable/);
  assert.match(cacheHeaders("/models/face.bin"), /immutable/);
  assert.match(cacheHeaders("/index.html"), /no-store/);
  assert.match(cacheHeaders("/sw.js"), /no-store/);
  assert.equal(cacheHeaders("/tasks/1"), "no-cache");
});