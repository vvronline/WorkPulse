/** Require a README.md in every first-level server/modules/<feature> directory. */
import fs from "node:fs";
import path from "node:path";

const modulesRoot = path.resolve("server/modules");
if (!fs.existsSync(modulesRoot)) {
  console.log("No server/modules directory yet; README guard ready for Phase G.");
  process.exit(0);
}

const missing = fs.readdirSync(modulesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => !fs.existsSync(path.join(modulesRoot, name, "README.md")));

if (missing.length) {
  console.error("Module README guard failed:\n" + missing.map((name) => `  server/modules/${name}/README.md`).join("\n"));
  process.exit(1);
}

console.log("Module README guard passed.");