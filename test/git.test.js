import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { generate, uninstall } from "../src/generator.js";
import { createCheckpoint, planRollback, rollback } from "../src/checkpoint.js";
import { runGate } from "../src/gate.js";
import { installHook, removeHook, hookInstalled } from "../src/hooks.js";
import { startTask, approve, loadState } from "../src/state.js";
import { loadConfig } from "../src/config.js";
import { readStats } from "../src/stats.js";

const sh = (cwd, ...a) => spawnSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, AGENTFORGE_SKIP: "" } });
function repo(extra = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "afg-"));
  sh(d, "init", "-q"); sh(d, "config", "user.email", "t@t"); sh(d, "config", "user.name", "t");
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "x", scripts: { test: 'node -e "process.exit(0)"' }, ...extra }));
  fs.writeFileSync(path.join(d, "app.js"), "v1\n");
  fs.writeFileSync(path.join(d, ".gitignore"), "node_modules\n.env\n");
  sh(d, "add", "-A"); sh(d, "commit", "-qm", "init");
  return d;
}
const R = (d, f) => path.join(d, f);

test("rollback restores edits, removes only new files, keeps ignored + protected files", () => {
  const d = repo();
  generate({ tool: "cursor", workflow: "full", specialists: ["backend"] }, d);
  fs.writeFileSync(R(d, "mine.txt"), "user file created BEFORE checkpoint\n"); // untracked at checkpoint time
  fs.mkdirSync(R(d, "node_modules")); fs.writeFileSync(R(d, "node_modules/keep.js"), "ignored");
  createCheckpoint(d, "t");
  fs.writeFileSync(R(d, "app.js"), "AI broke this\n");
  fs.writeFileSync(R(d, "ai_new.js"), "new");
  fs.rmSync(R(d, "mine.txt"));
  fs.writeFileSync(R(d, ".ai/reports/qa_report.md"), "report written during the task");
  const plan = planRollback(d);
  assert.deepEqual(plan.toDelete, ["ai_new.js"]);
  assert.deepEqual(plan.toRestore.sort(), ["app.js", "mine.txt"]);
  rollback(d);
  assert.equal(fs.readFileSync(R(d, "app.js"), "utf8"), "v1\n");
  assert.equal(fs.readFileSync(R(d, "mine.txt"), "utf8"), "user file created BEFORE checkpoint\n");
  assert.ok(!fs.existsSync(R(d, "ai_new.js")));
  assert.ok(fs.existsSync(R(d, "node_modules/keep.js")));
  assert.ok(fs.existsSync(R(d, ".ai/reports/qa_report.md")));
  assert.ok(fs.existsSync(R(d, ".cursor/rules/orchestrator.mdc")));
});

test("checkpoint never touches the user's real index or branch", () => {
  const d = repo();
  fs.writeFileSync(R(d, "staged.js"), "s"); sh(d, "add", "staged.js");
  const headBefore = sh(d, "rev-parse", "HEAD").stdout;
  const statusBefore = sh(d, "status", "--porcelain").stdout;
  createCheckpoint(d);
  assert.equal(sh(d, "rev-parse", "HEAD").stdout, headBefore);
  assert.equal(sh(d, "status", "--porcelain").stdout, statusBefore);
});

test("gate passes, then blocks on a failing command and on a leaked secret, and logs history", () => {
  const d = repo();
  generate({ tool: "cursor", workflow: "standard" }, d);
  assert.equal(runGate(d).passed, true);
  const cfg = loadConfig(d); cfg.gate.push({ name: "Boom", cmd: 'node -e "process.exit(3)"' });
  fs.writeFileSync(R(d, ".ai/config.json"), JSON.stringify(cfg));
  const bad = runGate(d);
  assert.equal(bad.passed, false);
  assert.ok(bad.results.find((r) => r.name === "Boom" && r.status === "FAIL"));
  const s = readStats(d);
  assert.equal(s.total, 2); assert.equal(s.blocked, 1); assert.equal(s.byCheck.Boom, 1);
});

test("invalid config gives a clear error", () => {
  const d = repo(); generate({ tool: "cursor", workflow: "standard" }, d);
  fs.writeFileSync(R(d, ".ai/config.json"), JSON.stringify({ tool: "vim", workflow: "x", agents: ["nope"], gate: "no" }));
  assert.throws(() => loadConfig(d), /tool.*workflow.*agents.*gate/s);
});

test("pre-commit hook blocks a failing gate and allows a passing one", () => {
  const d = repo(); generate({ tool: "cursor", workflow: "standard" }, d);
  installHook(d); assert.ok(hookInstalled(d));
  fs.writeFileSync(R(d, "ok.js"), "1"); sh(d, "add", "ok.js");
  assert.equal(sh(d, "commit", "-qm", "good").status, 0);
  fs.writeFileSync(R(d, "leak.js"), "const jwt_secret = 'hunter2hunter2';\n"); sh(d, "add", "leak.js");
  assert.notEqual(sh(d, "commit", "-qm", "bad").status, 0);
  assert.ok(removeHook(d) && !hookInstalled(d));
});

test("state machine: cannot approve without the report, advances with it", () => {
  const d = repo(); generate({ tool: "opencode", workflow: "standard", specialists: ["backend"] }, d);
  const s = startTask(d, "add tickets");
  assert.deepEqual(s.pipeline, ["planner", "backend", "reviewer", "gate"]);
  assert.ok(s.checkpoint);
  assert.equal(approve(d).ok, false);          // plan report missing
  fs.writeFileSync(R(d, ".ai/reports/implementation_plan.md"), "# Plan\n## Goal\nTickets for admins to manage.\n## Steps\n1. add model and routes carefully\n## Files\n- a.js\n## Risks\n- low risk overall\n");
  assert.equal(approve(d).ok, true);
  assert.equal(loadState(d).index, 1);
  assert.equal(approve(d).ok, true);           // backend has no contract
  assert.equal(approve(d).ok, false);          // review report missing
  fs.writeFileSync(R(d, ".ai/reports/review_report.md"), "# Review\n## Findings\nNo blockers found. The diff matches the plan and follows the project conventions.\n## Verdict: CHANGES REQUESTED\n");
  assert.equal(approve(d).ok, false);          // negative verdict blocks
  fs.writeFileSync(R(d, ".ai/reports/review_report.md"), "# Review\n## Findings\nNo blockers found. The diff matches the plan and follows the project conventions.\n## Verdict: APPROVED\n");
  assert.equal(approve(d).ok, true);
  assert.equal(approve(d).ok, true);           // gate passes
  assert.ok(loadState(d).finishedAt);
});

test("starting a new task archives stale reports", () => {
  const d = repo(); generate({ tool: "cursor", workflow: "standard" }, d);
  fs.writeFileSync(R(d, ".ai/reports/implementation_plan.md"), "old");
  startTask(d, "new task");
  assert.ok(!fs.existsSync(R(d, ".ai/reports/implementation_plan.md")));
  assert.ok(fs.readdirSync(R(d, ".ai/reports/archive")).length === 1);
});

test("update keeps user-edited agent files; uninstall removes only unedited ones", () => {
  const d = repo(); generate({ tool: "cursor", workflow: "standard" }, d);
  const planner = R(d, ".cursor/rules/planner.mdc");
  fs.appendFileSync(planner, "\nMY CUSTOM RULE\n");
  const r = generate({ tool: "cursor", workflow: "standard" }, d);
  assert.deepEqual(r.skipped, [".cursor/rules/planner.mdc"]);
  assert.match(fs.readFileSync(planner, "utf8"), /MY CUSTOM RULE/);
  const u = uninstall(d);
  assert.deepEqual(u.kept, [".cursor/rules/planner.mdc"]);
  assert.ok(!fs.existsSync(R(d, ".cursor/rules/orchestrator.mdc")));
});

test("python and go presets", async () => {
  const { analyze, detectGateCommands } = await import("../src/analyzer.js");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "afpy-"));
  fs.writeFileSync(R(d, "requirements.txt"), "fastapi\npytest\nruff\n");
  const g = detectGateCommands(analyze(d)).map((x) => x.cmd);
  assert.deepEqual(g, ["python -m pytest -q", "ruff check ."]);
});
