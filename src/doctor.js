import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS } from "./registry.js";
import { validateConfig } from "./config.js";
import { hookInstalled } from "./hooks.js";
import { isRepo } from "./checkpoint.js";
import { findServices } from "./services.js";

const T = path.join(path.dirname(fileURLToPath(import.meta.url)), "../templates/agents");
const MAX_PROMPT_CHARS = 4500;

// Lint the agent prompt templates themselves (used by tests and `doctor --prompts`).
export function lintPrompts(dir = T) {
  const issues = [];
  for (const name of Object.keys(AGENTS)) {
    const f = path.join(dir, `${name}.md`);
    if (!fs.existsSync(f)) { issues.push(`${name}: template file missing`); continue; }
    const t = fs.readFileSync(f, "utf8");
    if (!/^## Role/m.test(t)) issues.push(`${name}: no "## Role" section`);
    if (!/^## Rules|^## Checklist/m.test(t)) issues.push(`${name}: no "## Rules"/"## Checklist" section`);
    if (!/^## Output|^## Before every task/m.test(t)) issues.push(`${name}: no "## Output" section`);
    if (name !== "orchestrator" && !/STOP/.test(t)) issues.push(`${name}: no STOP/approval instruction`);
    if (t.length > MAX_PROMPT_CHARS) issues.push(`${name}: ${t.length} chars (> ${MAX_PROMPT_CHARS}); shorten it`);
  }
  return issues;
}

export function doctor(cwd) {
  const checks = [];
  const add = (level, msg) => checks.push({ level, msg });
  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 18 ? "ok" : "fail", `Node ${process.versions.node} (need >= 18)`);
  add(isRepo(cwd) ? "ok" : "warn", isRepo(cwd) ? "Git repository found" : "Not a git repo: checkpoints and rollback need one");
  const cfgFile = path.join(cwd, ".ai/config.json");
  if (!fs.existsSync(cfgFile)) { add("fail", "No .ai/config.json: run `agentforge init`"); return checks; }
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")); } catch (e) { add("fail", "config.json is not valid JSON"); return checks; }
  const errs = validateConfig(cfg);
  errs.forEach((e) => add("fail", `config: ${e}`));
  if (!errs.length) {
    add("ok", `Config valid (${cfg.tool}, ${cfg.workflow}, ${cfg.agents.length} agents)`);
    if (cfg.language === "typescript") {
      const ts = findServices(cwd).some((x) => x.typescript);
      add(ts ? "ok" : "warn", ts ? "TypeScript project (tsconfig found)" : "config says TypeScript but no tsconfig.json was found");
      if (!cfg.gate.some((g) => /tsc|typecheck|type-check/i.test(g.cmd))) add("warn", "no type-check command in the gate: add { \"name\": \"Type Check\", \"cmd\": \"npx tsc --noEmit\" } to .ai/config.json");
    } else if (cfg.language === "javascript" && findServices(cwd).some((x) => x.typescript)) add("warn", "config says JavaScript but the project has a tsconfig.json: run `agentforge language typescript`");
    if (!cfg.gate.length) add("warn", "No gate commands configured: the gate only runs scans");
    const probe = { cursor: (n) => `.cursor/rules/${n}.mdc`, opencode: (n) => `.opencode/agents/${n}.md`, gemini: () => "GEMINI.md" }[cfg.tool];
    const missing = cfg.agents.filter((n) => !fs.existsSync(path.join(cwd, probe(n))));
    add(missing.length ? "fail" : "ok", missing.length ? `Missing agent files: ${missing.join(", ")} (run \`agentforge update\`)` : "All agent files present");
  }
  for (const f of ["project-context.md", "conventions.md", "security.md"]) add(fs.existsSync(path.join(cwd, ".ai", f)) ? "ok" : "warn", `.ai/${f}`);
  const ignore = fs.existsSync(path.join(cwd, ".gitignore")) ? fs.readFileSync(path.join(cwd, ".gitignore"), "utf8") : "";
  add(/^\.env\s*$/m.test(ignore) ? "ok" : "warn", ".env is git-ignored");
  add(hookInstalled(cwd) ? "ok" : "warn", hookInstalled(cwd) ? "pre-commit gate hook installed" : "pre-commit gate hook not installed (`agentforge install-hooks`)");
  return checks;
}
