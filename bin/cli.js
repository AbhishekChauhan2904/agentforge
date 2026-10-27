#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import prompts from "prompts";
import { AGENTS, SPECIALISTS, WORKFLOWS } from "../src/registry.js";
import { generate, uninstall } from "../src/generator.js";
import { analyze, renderContext } from "../src/analyzer.js";
import { runGate } from "../src/gate.js";
import { validateReports } from "../src/validate.js";
import { createCheckpoint, listCheckpoints, planRollback, rollback } from "../src/checkpoint.js";
import { installHook, removeHook } from "../src/hooks.js";
import { loadConfig, normalizeLanguage, migrateConfig } from "../src/config.js";
import { startTask, loadState, describe, approve } from "../src/state.js";
import { doctor, lintPrompts } from "../src/doctor.js";
import { readStats } from "../src/stats.js";
import { dockerInit, lintDocker } from "../src/docker.js";
import { findServices, isMicroservices } from "../src/services.js";
import { writeGraph } from "../src/graph.js";
import { CHECKS, runCheck } from "../src/audit.js";
import { cloudInit } from "../src/cloud.js";
import { createAdr } from "../src/adr.js";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const cwd = process.cwd();
const [cmd = "help", ...rest] = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) {
    const k = rest[i].slice(2);
    flags[k] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true;
  } else positional.push(rest[i]);
}
const c = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` };

const HELP = `${c.b("agentforge")} v${pkg.version} - turn your AI coding tool into a structured engineering team

${c.b("Setup")}
  init [--yes --tool T --workflow W --agents a,b --language ts|js]   Install agents (cursor | opencode | gemini)
  language [ts|js]                                  Show or switch TypeScript / JavaScript rules for the agents
  update [--force]                                  Re-generate agent files; skips ones you edited
  uninstall [--all]                                 Remove generated agent files (--all also removes .ai/)
  analyze                                           Refresh .ai/project-context.md
  doctor [--prompts]                                Check setup (and lint the prompt templates)

${c.b("Run a task (workflow enforced by code)")}
  start "task"       Begin a task: archives old reports, takes a checkpoint, builds the pipeline
  next               Show the current step and what to tell your AI
  approve [--force]  Verify the step's report (or gate) and advance
  status             Show progress

${c.b("Code audits (static, no running server needed)")}
  api                          Every endpoint with auth / roles / validation / rate-limit, plus findings (.ai/api-map.md)
  db                           Models, indexes, schema and query-safety findings (.ai/db-map.md)
  structure                    Layering (routes -> controllers -> services -> models), Flutter structure (.ai/structure.md)
  cloud                        AWS/Azure services used, IaC + CI findings (.ai/cloud.md)
  cloud init aws|azure         Scaffold a secure GitHub-OIDC deploy workflow + templates (never overwrites)
  tests                        Unit-test health: untested logic files, test quality (.only, no assertions), coverage (.ai/tests.md)
  metrics                      Lines of code, test:source ratio, function length, complexity, nesting (.ai/metrics.md)
  design                       Coupling and stability per module, god files, circular deps, ER data-model diagram (.ai/design.md)
  adr "title"                  Create a numbered Architecture Decision Record in docs/adr/
  audit                        Run every check above

${c.b("Docker & services")}
  graph [--print]             Draw the project: services, databases, calls, module dependencies, cycles (.ai/graph.md)
  services                     List detected services (api / frontend / worker)
  docker init [--force]        Scaffold Dockerfile, .dockerignore and docker-compose.yml (never overwrites)
  docker check                 Lint Dockerfiles and compose files (errors block the gate)

${c.b("Safety")}
  gate [--strict]              Tests, lint, build, audit, secret scan
  validate [agent]             Check agent reports against their contracts
  checkpoint [label]           Snapshot everything, including new files
  checkpoints                  List checkpoints
  rollback [tag] [--dry-run] [--yes] [--force]
  install-hooks | uninstall-hooks   Block commits when the gate fails
  stats                        Gate history`;

async function init() {
  let { tool, workflow } = flags;
  let language = typeof flags.language === "string" ? flags.language : undefined;
  let specialists = typeof flags.agents === "string" ? flags.agents.split(",").filter(Boolean) : [];
  if (!flags.yes) {
    const info = analyze(cwd);
    const hasNode = info.languages.some((l) => l === "JavaScript" || l === "TypeScript") || info.languages.length === 0;
    const guess = [info.frontend.includes("Next.js") ? "nextjs" : info.frontend.length && "frontend", info.backend.length && "backend", info.database.length && "database"].filter(Boolean);
    const a = await prompts([
      { type: "select", name: "tool", message: "Which AI tool do you use?", choices: [
        { title: "Cursor", value: "cursor" }, { title: "OpenCode", value: "opencode" }, { title: "Gemini CLI", value: "gemini" }] },
      { type: "select", name: "workflow", message: "Which workflow?", choices: Object.entries(WORKFLOWS).map(([value, w]) => ({ title: w.label, value })) },
      ...(hasNode ? [{ type: "select", name: "language", message: "Language for this project?", initial: info.languages.includes("TypeScript") ? 0 : 1, choices: [{ title: "TypeScript", value: "typescript" }, { title: "JavaScript", value: "javascript" }] }] : []),
      { type: "multiselect", name: "specialists", message: "Pick specialist agents (space to select)", hint: "detected stack is pre-selected",
        choices: SPECIALISTS.map((value) => ({ title: AGENTS[value].title, value, selected: guess.includes(value) })) }
    ], { onCancel: () => process.exit(1) });
    ({ tool, workflow } = a);
    language = a.language;
    specialists = a.specialists;
  }
  tool ||= "cursor"; workflow ||= "standard";
  report(generate({ tool, workflow, specialists, language }, cwd, { force: !!flags.force }), true);
}

function report(res, first) {
  console.log(c.g(first ? "\nWorkflow installed." : "\nUpdated.") + ` ${res.agents.length} agents: ${res.agents.join(", ")}`);
  if (res.language) console.log(c.d(`Language: ${res.language}`));
  if (res.skipped.length) console.log(c.y(`Kept your edited files (use --force to overwrite): ${res.skipped.join(", ")}`));
  if (first) console.log(`\nNext steps:\n  1. Review ${c.b(".ai/config.json")} (quality-gate commands)\n  2. ${c.b("agentforge install-hooks")} to block bad commits\n  3. ${c.b('agentforge start "your task"')} then ${c.b("agentforge next")}\n`);
}

function gate() {
  const { results, passed } = runGate(cwd, { strictReports: !!flags.strict });
  console.log(c.b("\nQUALITY GATE\n"));
  for (const r of results) console.log(`  ${r.name.padEnd(20)} ${r.status === "PASS" ? c.g("PASS") : r.status === "SKIP" ? c.y("SKIP") : c.r("FAIL")}`);
  console.log(`\n  STATUS: ${passed ? c.g("READY") : c.r("BLOCKED")}`);
  for (const r of results.filter((x) => x.detail && (!passed || x.status === "SKIP"))) console.log(`\n${c.b(r.name)}\n${r.detail}`);
  console.log(c.d("\n  Report saved to .ai/reports/quality_gate.md\n"));
  process.exit(passed ? 0 : 1);
}

function showStep(state) {
  const d = describe(state);
  if (!d) return console.log(c.g("Task complete. All steps approved."));
  console.log(`${c.b(`Step ${state.index + 1}/${state.pipeline.length}: ${d.step}`)}\n  ${d.instruction}`);
  if (d.report) console.log(`  Expected report: ${c.b(d.report)}`);
  console.log(c.d("  When the agent is done and you are happy: agentforge approve"));
}

try {
  switch (cmd) {
    case "init": await init(); break;
    case "update": { const cfg = loadConfig(cwd); const sp = cfg.agents.filter((a) => SPECIALISTS.includes(a)); const res = generate({ tool: cfg.tool, workflow: cfg.workflow, specialists: sp, language: cfg.language }, cwd, { force: !!flags.force });
      report(res, false);
      const added = migrateConfig(cwd, res.language);
      if (added.length) console.log(c.g(`Upgraded .ai/config.json, added: ${added.join(", ")}`) + c.d("\n  (checks are on by default for what was detected; set a check to false in .ai/config.json to turn it off)"));
      break; }
    case "language": {
      const cfg = loadConfig(cwd);
      if (!positional[0]) { const det = analyze(cwd).languages.filter((l) => /Script/.test(l)); console.log(`configured: ${cfg.language || "not set"}   detected: ${det.join(", ") || "none"}`); break; }
      const lang = normalizeLanguage(positional[0]);
      if (!lang) throw new Error("Usage: agentforge language typescript|javascript   (or ts|js)");
      cfg.language = lang;
      fs.writeFileSync(path.join(cwd, ".ai/config.json"), JSON.stringify(cfg, null, 2) + "\n");
      report(generate({ tool: cfg.tool, workflow: cfg.workflow, specialists: cfg.agents.filter((a) => SPECIALISTS.includes(a)), language: lang }, cwd, {}), false);
      console.log(c.g(`Language set to ${lang}.`)); break;
    }
    case "uninstall": { const r = uninstall(cwd, { all: !!flags.all }); console.log(c.g(`Removed ${r.removed.length} files.`) + (r.kept.length ? c.y(` Kept (edited by you): ${r.kept.join(", ")}`) : "")); break; }
    case "analyze": { fs.mkdirSync(path.join(cwd, ".ai"), { recursive: true }); const info = analyze(cwd); try { info.language = loadConfig(cwd).language; } catch { /* not initialised yet */ } fs.writeFileSync(path.join(cwd, ".ai/project-context.md"), renderContext(info)); writeGraph(cwd); console.log(c.g("Updated .ai/project-context.md and .ai/graph.md")); break; }
    case "doctor": {
      const checks = doctor(cwd);
      checks.unshift({ level: "ok", msg: `agentforge ${pkg.version} (${new URL("..", import.meta.url).pathname.replace(/\/$/, "")})` });
      if (flags.prompts) lintPrompts().forEach((m) => checks.push({ level: "warn", msg: `prompt: ${m}` }));
      for (const k of checks) console.log(`  ${k.level === "ok" ? c.g("ok  ") : k.level === "warn" ? c.y("warn") : c.r("FAIL")}  ${k.msg}`);
      process.exit(checks.some((k) => k.level === "fail") ? 1 : 0);
    }
    case "start": { if (!positional[0]) throw new Error('Usage: agentforge start "describe the task"'); const s = startTask(cwd, positional.join(" ")); console.log(c.g("Task started.") + (s.checkpoint ? c.d(` Checkpoint: ${s.checkpoint}`) : c.y(" (no git checkpoint: not a git repo)")) + `\nPipeline: ${s.pipeline.join(" -> ")}\n`); showStep(s); break; }
    case "next": { const s = loadState(cwd); if (!s) throw new Error('No active task. Run `agentforge start "task"`.'); showStep(s); break; }
    case "status": { const s = loadState(cwd); if (!s) throw new Error("No active task."); console.log(`Task: ${s.task}`); s.pipeline.forEach((p, i) => console.log(`  ${i < s.index ? c.g("done   ") : i === s.index ? c.y("current") : c.d("pending")} ${p}`)); break; }
    case "approve": {
      const r = approve(cwd, { force: !!flags.force });
      if (!r.ok) { console.log(c.r(`Cannot approve "${r.step}":\n  - ${r.problems.join("\n  - ")}`) + "\n" + c.d("Fix the problems, or use --force to override (recorded).")); process.exit(1); }
      console.log(c.g(`Approved: ${r.step}\n`)); const s = loadState(cwd); showStep(s); break;
    }
    case "validate": { const v = validateReports(cwd, loadConfig(cwd).agents, positional[0] || null); console.log(v.ok ? c.g(`All reports valid: ${v.checked.join(", ") || "(none required)"}`) : c.r("Problems:\n  - " + v.problems.join("\n  - "))); process.exit(v.ok ? 0 : 1); }
    case "cloud":
      if (positional[0] === "init") {
        const r = cloudInit(cwd, positional[1], { force: !!flags.force });
        r.created.forEach((f) => console.log(c.g("created ") + f)); r.skipped.forEach((f) => console.log(c.y("kept    ") + f + " (exists)")); r.notes.forEach((n) => console.log(c.y("note: ") + n));
        console.log(c.d(`\nImage context: ${r.context}. These are templates with <PLACEHOLDERS>: read infra/${positional[1]}/README.md, create the cloud resources, then set the GitHub variables.`));
        break;
      }
    // falls through to the shared audit runner when it is not `cloud init`
    case "api": case "db": case "structure": case "tests": case "metrics": case "design": case "audit": {
      const keys = cmd === "audit" ? Object.keys(CHECKS) : [cmd];
      let errors = 0;
      for (const k of keys) {
        const r = runCheck(cwd, k);
        const e = r.findings.filter((f) => f.level === "error").length, w = r.findings.filter((f) => f.level === "warn").length;
        errors += e;
        console.log(c.b(`\n${CHECKS[k].gate}`) + c.d(`  (.ai/${CHECKS[k].out})`));
        if (k === "api") console.log(`  ${r.endpoints.length} endpoint(s): ${r.endpoints.filter((x) => x.auth).length} with auth, ${r.endpoints.filter((x) => x.roles).length} with role checks`);
        if (k === "cloud") console.log(`  providers: ${r.cloud.providers.join(", ") || "none detected"}   services used: ${[...new Set(r.cloud.services.map((x) => `${x.provider}:${x.name}`))].join(", ") || "none"}   IaC files: ${r.cloud.iac.length}`);
        CHECKS[k].summary?.(r).forEach((l) => console.log(`  ${l}`));
        if (k === "db") console.log(`  ${r.models.length} model(s): ${r.models.map((m) => m.name).join(", ") || "none"}`);
        for (const f of r.findings.filter((x) => x.level !== "info").slice(0, flags.all ? 1e6 : 25)) console.log(`  ${f.level === "error" ? c.r("error") : c.y("warn ")}  ${f.file}:${f.line}  ${f.msg}`);
        if (r.findings.filter((x) => x.level !== "info").length > 25 && !flags.all) console.log(c.d("  ... more in the .ai report (or use --all)"));
        console.log(`  ${e} error(s), ${w} warning(s)`);
      }
      process.exit(errors ? 1 : 0);
    }
    case "adr": { const r = createAdr(cwd, positional.join(" ")); console.log(c.g("Created ") + r.file + c.d("  (edit it, then change Status to Accepted)")); break; }
    case "graph": {
      const g = writeGraph(cwd);
      console.log(c.g("Wrote .ai/graph.md") + c.d("  (Mermaid: renders on GitHub, VS Code preview, mermaid.live)"));
      console.log(`  services: ${g.services.length}   connections: ${g.system.edges.length}   infra: ${g.system.infra.join(", ") || "none"}   module views: ${g.modules.length}`);
      console.log(`  languages: ${g.languages.slice(0, 4).map(([l, n]) => `${l} ${n}`).join(", ") || "none detected"}`);
      if (g.cycles.length) { console.log(c.y("\n  Circular dependencies:")); g.cycles.forEach((x) => console.log(`    ${x.service}: ${x.groups.join(" <-> ")}`)); } else console.log(c.g("  No circular dependencies."));
      if (flags.print) console.log("\n" + g.system.mermaid);
      break;
    }
    case "services": { const sv = findServices(cwd); console.log(isMicroservices(sv) ? c.b("Multi-service system") : c.b("Single deployable")); sv.forEach((x) => console.log(`  ${x.dir.padEnd(18)} ${x.kind.padEnd(9)} ${x.needs.length ? "needs " + x.needs.join(", ") : ""}`)); break; }
    case "docker": {
      if (positional[0] === "init") { const r = dockerInit(cwd, { force: !!flags.force }); r.created.forEach((f) => console.log(c.g("created ") + f)); r.skipped.forEach((f) => console.log(c.y("kept    ") + f + " (exists)")); r.notes.forEach((n) => console.log(c.y("note: ") + n)); console.log(c.d("\nNext: edit ports/env, then `agentforge docker check` and `docker compose up --build`.")); break; }
      if (positional[0] === "check") {
        const { files, findings } = lintDocker(cwd);
        if (!files.length) { console.log("No Dockerfile or compose file found. Run `agentforge docker init`."); break; }
        findings.forEach((f) => console.log(`  ${f.level === "error" ? c.r("error") : c.y("warn ")}  ${f.file}:${f.line}  ${f.msg}`));
        const errs = findings.filter((f) => f.level === "error").length;
        console.log(`\n${files.length} file(s), ${errs} error(s), ${findings.length - errs} warning(s)`);
        process.exit(errs ? 1 : 0);
      }
      throw new Error("Usage: agentforge docker init | agentforge docker check");
    }
    case "gate": gate(); break;
    case "stats": {
      const s = readStats(cwd); if (!s) { console.log("No gate runs yet."); break; }
      console.log(`Gate runs: ${s.total}   passed: ${s.passed}   blocked: ${s.blocked}   pass rate: ${s.passRate}%`);
      const top = Object.entries(s.byCheck).sort((a, b) => b[1] - a[1]); if (top.length) console.log("Most common failures: " + top.map(([k, n]) => `${k} (${n})`).join(", ")); break;
    }
    case "checkpoint": { const r = createCheckpoint(cwd, positional[0]); console.log(c.g(`Checkpoint created: ${r.tag}`) + c.d(` (${r.commit})`)); break; }
    case "checkpoints": console.log(listCheckpoints(cwd).join("\n") || "No checkpoints yet."); break;
    case "rollback": {
      const plan = planRollback(cwd, positional[0], { force: !!flags.force });
      console.log(`Checkpoint: ${c.b(plan.target)}\n  restore: ${plan.toRestore.length} file(s)${plan.toRestore.map((f) => `\n    ~ ${f}`).join("")}\n  delete:  ${plan.toDelete.length} new file(s)${plan.toDelete.map((f) => `\n    - ${f}`).join("")}`);
      if (flags["dry-run"]) break;
      if (!flags.yes) { console.log(c.y("\nNothing changed. Re-run with --yes to apply (or --dry-run to only preview).")); process.exit(1); }
      rollback(cwd, positional[0], { force: !!flags.force }); console.log(c.g("\nRolled back.")); break;
    }
    case "install-hooks": console.log(c.g("Installed: ") + installHook(cwd, { force: !!flags.force })); break;
    case "uninstall-hooks": console.log(removeHook(cwd) ? c.g("Hook removed.") : "No agentforge hook found."); break;
    case "version": case "--version": case "-v": console.log(pkg.version); break;
    case "help": case "--help": case "-h": console.log(HELP); break;
    default: console.log(HELP); process.exit(1);
  }
} catch (e) { console.error(c.r("Error: ") + e.message); process.exit(1); }
