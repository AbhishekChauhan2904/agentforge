import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { scanSecrets } from "./secrets.js";
import { validateReports } from "./validate.js";
import { loadConfig } from "./config.js";
import { lintDocker } from "./docker.js";
import { buildGraph } from "./graph.js";
import { CHECKS, runCheck } from "./audit.js";

function run(cmd, cwd) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: "utf8", timeout: 10 * 60 * 1000 });
  const out = ((r.stdout || "") + (r.stderr || "")).trim();
  return { ok: r.status === 0, tail: out.split("\n").slice(-15).join("\n") };
}

export function runGate(cwd, { strictReports = false } = {}) {
  const cfg = loadConfig(cwd);
  const results = [];

  for (const g of cfg.gate || []) {
    const r = run(g.cmd, cwd);
    results.push({ name: g.name, status: r.ok ? "PASS" : "FAIL", detail: r.ok ? "" : r.tail });
  }
  if (cfg.audit && fs.existsSync(path.join(cwd, "package-lock.json"))) {
    const r = run("npm audit --audit-level=high", cwd);
    results.push({ name: "Dependency Audit", status: r.ok ? "PASS" : "FAIL", detail: r.ok ? "" : r.tail });
  }
  if (cfg.secretScan) {
    const hits = scanSecrets(cwd);
    results.push({ name: "Secret Scan", status: hits.length ? "FAIL" : "PASS", detail: hits.map((h) => `${h.file}:${h.line} ${h.rule}`).join("\n") });
  }
  if (cfg.dockerLint !== false) {
    const d = lintDocker(cwd);
    if (d.files.length) {
      const errs = d.findings.filter((f) => f.level === "error");
      results.push({ name: "Docker Lint", status: errs.length ? "FAIL" : "PASS", detail: errs.map((f) => `${f.file}:${f.line} ${f.msg}`).join("\n") });
    }
  }
  for (const [key, c] of Object.entries(CHECKS)) {
    if (cfg[c.flag] !== true) continue;
    try {
      const errs = runCheck(cwd, key).findings.filter((f) => f.level === "error");
      results.push({ name: c.gate, status: errs.length ? "FAIL" : "PASS", detail: errs.map((f) => `${f.file}:${f.line} ${f.msg}`).join("\n") });
    } catch (e) {   // a bug in a checker must never block your commit: report it and carry on
      results.push({ name: c.gate, status: "SKIP", detail: `internal error in this check (${e.message}). Please report it; set "${c.flag}": false in .ai/config.json to silence it.` });
    }
  }
  if (cfg.graphCheck === true) {
    const cyc = buildGraph(cwd).cycles;
    results.push({ name: "Dependency Cycles", status: cyc.length ? "FAIL" : "PASS", detail: cyc.map((c) => `${c.service}: ${c.groups.join(" <-> ")}`).join("\n") });
  }
  if (strictReports) {
    const v = validateReports(cwd, cfg.agents || []);
    results.push({ name: "Agent Reports", status: v.ok ? "PASS" : "FAIL", detail: v.problems.join("\n") });
  }
  if (results.length === 0) results.push({ name: "No checks configured", status: "FAIL", detail: "Add commands to .ai/config.json under \"gate\"." });

  const passed = results.every((r) => r.status !== "FAIL");
  const report = renderReport(results, passed);
  fs.mkdirSync(path.join(cwd, ".ai/reports"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".ai/reports/quality_gate.md"), report);
  fs.appendFileSync(path.join(cwd, ".ai/runs.jsonl"), JSON.stringify({ ts: new Date().toISOString(), passed, failed: results.filter((r) => r.status === "FAIL").map((r) => r.name) }) + "\n");
  return { results, passed, report };
}

function renderReport(results, passed) {
  const rows = results.map((r) => `| ${r.name} | ${r.status} |`).join("\n");
  const details = results.filter((r) => r.detail).map((r) => `### ${r.name}\n\`\`\`\n${r.detail}\n\`\`\``).join("\n\n");
  return `# QUALITY GATE\n\n| Check | Result |\n|-------|--------|\n${rows}\n\n**STATUS: ${passed ? "READY" : "BLOCKED"}**\n\n${details}\n`;
}
