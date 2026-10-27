import fs from "node:fs";
import path from "node:path";
import { AGENTS, CONTRACTS } from "./registry.js";
import { loadConfig } from "./config.js";
import { validateReports } from "./validate.js";
import { runGate } from "./gate.js";
import { createCheckpoint } from "./checkpoint.js";

const ORDER = ["planner", "architect", "microservices", "database", "backend", "python", "frontend", "nextjs", "mobile", "flutter", "ui-css", "docker", "devops", "aws", "azure", "developer", "tester", "qa", "security", "performance", "reviewer", "gate", "docs", "git"];
const DEVS = ["database", "backend", "python", "frontend", "nextjs", "mobile", "flutter", "ui-css", "docker", "devops", "aws", "azure", "microservices"];
const file = (cwd) => path.join(cwd, ".ai/state.json");

export function buildPipeline(cfg) {
  const has = new Set(cfg.agents);
  const hasDev = DEVS.some((d) => has.has(d));
  return ORDER.filter((s) => (s === "gate" ? cfg.workflow !== "minimal" : s === "developer" ? !hasDev : has.has(s)));
}

export function loadState(cwd) {
  try { return JSON.parse(fs.readFileSync(file(cwd), "utf8")); } catch { return null; }
}
const save = (cwd, s) => fs.writeFileSync(file(cwd), JSON.stringify(s, null, 2) + "\n");

function archiveReports(cwd) {
  const dir = path.join(cwd, ".ai/reports");
  if (!fs.existsSync(dir)) return;
  const old = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  if (!old.length) return;
  const dest = path.join(dir, "archive", new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(dest, { recursive: true });
  for (const f of old) fs.renameSync(path.join(dir, f), path.join(dest, f));
}

export function startTask(cwd, task) {
  const cfg = loadConfig(cwd);
  archiveReports(cwd); // stale reports from the previous task must not satisfy this one
  let checkpoint = null;
  try { checkpoint = createCheckpoint(cwd, "task").tag; } catch { /* not a git repo yet: continue without */ }
  const state = { task, startedAt: new Date().toISOString(), pipeline: buildPipeline(cfg), index: 0, checkpoint, done: [] };
  save(cwd, state);
  return state;
}

export function describe(state) {
  const step = state.pipeline[state.index];
  if (!step) return null;
  const contract = CONTRACTS[step];
  let instruction;
  if (step === "gate") instruction = "Run `agentforge gate --strict` (approve does this for you).";
  else if (step === "developer") instruction = `Tell your AI: "Implement this with the smallest possible diff, following .ai/conventions.md: ${state.task}"`;
  else instruction = `Tell your AI: "Act as the ${AGENTS[step].title} agent (see its rule file) for this task: ${state.task}"`;
  return { step, report: contract ? `.ai/reports/${contract.file}` : null, instruction };
}

export function approve(cwd, { force = false } = {}) {
  const state = loadState(cwd);
  if (!state) throw new Error("No active task. Run `agentforge start \"your task\"` first.");
  const cfg = loadConfig(cwd);
  const step = state.pipeline[state.index];
  if (!step) throw new Error("Task already complete. Start a new one with `agentforge start`.");
  const problems = [];
  if (!force) {
    if (CONTRACTS[step]) problems.push(...validateReports(cwd, cfg.agents, step).problems);
    if (step === "gate") {
      const g = runGate(cwd);
      problems.push(...g.results.filter((r) => r.status === "FAIL").map((r) => `${r.name}: FAIL`));
    }
  }
  if (problems.length) return { ok: false, problems, step };
  state.done.push({ step, at: new Date().toISOString(), forced: force });
  state.index += 1;
  if (state.index >= state.pipeline.length) state.finishedAt = new Date().toISOString();
  save(cwd, state);
  return { ok: true, step, next: describe(state) };
}
