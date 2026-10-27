import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generate } from "../src/generator.js";
import { analyze, detectGateCommands } from "../src/analyzer.js";
import { validateReports } from "../src/validate.js";
import { scanSecrets } from "../src/secrets.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "af-"));

test("analyzer detects a MERN stack", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({
    dependencies: { react: "1", express: "1", mongoose: "1", jsonwebtoken: "1" },
    devDependencies: { jest: "1" }, scripts: { test: "jest", build: "vite build" } }));
  const info = analyze(d);
  assert.deepEqual(info.frontend, ["React"]);
  assert.ok(info.database.includes("MongoDB (Mongoose)"));
  assert.deepEqual(detectGateCommands(info).map((g) => g.name), ["Tests", "Build"]);
});

for (const [tool, probe] of [["cursor", ".cursor/rules/orchestrator.mdc"], ["opencode", ".opencode/agents/orchestrator.md"], ["gemini", "GEMINI.md"]]) {
  test(`generator writes ${tool} files and memory`, () => {
    const d = tmp();
    generate({ tool, workflow: "full", specialists: ["backend"] }, d);
    for (const f of [probe, ".ai/project-context.md", ".ai/config.json", ".ai/security.md"]) assert.ok(fs.existsSync(path.join(d, f)), f);
    assert.match(fs.readFileSync(path.join(d, probe), "utf8"), /FULL PIPELINE/);
  });
}

test("contract validation catches missing and incomplete reports", () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, ".ai/reports"), { recursive: true });
  assert.equal(validateReports(d, ["planner"]).ok, false);
  fs.writeFileSync(path.join(d, ".ai/reports/implementation_plan.md"),
    "# Plan\n## Goal\nBuild it well enough.\n## Steps\n1. do things carefully and in order\n## Files\n- a.js\n## Risks\n- none that we know of today\n");
  assert.equal(validateReports(d, ["planner"]).ok, true);
});

test("secret scanner flags hardcoded secrets", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "a.js"), "const jwt_secret = 'supersecretvalue123';\n");
  assert.equal(scanSecrets(d).length, 1);
});

import { lintPrompts } from "../src/doctor.js";
test("all shipped agent prompts pass the linter", () => {
  assert.deepEqual(lintPrompts(), []);
});
