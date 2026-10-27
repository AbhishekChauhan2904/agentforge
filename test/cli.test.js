import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const cli = new URL("../bin/cli.js", import.meta.url).pathname;
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const run = (...a) => spawnSync("node", [cli, ...a], { encoding: "utf8" });

test("--version, -v and version print the package version and exit 0", () => {
  for (const flag of ["--version", "-v", "version"]) { const r = run(flag); assert.equal(r.status, 0, flag); assert.equal(r.stdout.trim(), pkg.version); }
});

test("help shows the version and the bin path in package.json has no leading ./", () => {
  assert.match(run("help").stdout, new RegExp(`v${pkg.version.replace(/\./g, "\\.")}`));
  assert.ok(Object.values(pkg.bin).every((b) => !b.startsWith("./")), "npm 11 removes bin paths that start with ./");
  assert.equal(pkg.publishConfig?.access, "public");
});
