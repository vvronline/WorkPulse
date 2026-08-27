/** Verify a Vite SPA build before its mutable shell is promoted to R2. */
import fs from "node:fs";
import path from "node:path";

const dist = path.resolve(process.argv[2] || "client/dist");
const fail = (message) => { console.error(`FAIL: ${message}`); process.exitCode = 1; };

if (!fs.existsSync(dist)) {
  fail(`build directory does not exist: ${dist}`);
} else {
  for (const required of ["index.html", "sw.js", "manifest.json"]) {
    if (!fs.existsSync(path.join(dist, required))) fail(`missing ${required}`);
  }

  const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
  const refs = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((value) => value.startsWith("/") && !value.startsWith("//"));

  for (const ref of refs) {
    const clean = ref.split("?")[0].replace(/^\//, "");
    if (clean && !fs.existsSync(path.join(dist, clean))) fail(`index.html references missing ${ref}`);
  }

  const sw = fs.readFileSync(path.join(dist, "sw.js"), "utf8");
  if (!sw.includes("request.mode === 'navigate'")) fail("service worker lacks navigation handling");
  if (!sw.includes("cache: 'no-store'")) fail("navigation is not network-first/no-store");
  if (!sw.includes("url.pathname.startsWith('/uploads')")) fail("service worker may cache private uploads");

  if (!process.exitCode) {
    console.log(`SPA build verified: ${refs.length} root-relative index reference(s), safe service worker.`);
  }
}