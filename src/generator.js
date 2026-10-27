import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS, WORKFLOWS } from "./registry.js";
import { analyze, detectGateCommands, renderContext } from "./analyzer.js";
import { normalizeLanguage } from "./config.js";
import { writeGraph } from "./graph.js";
import { defaultFlags } from "./audit.js";
import { scanCloud, renderCloud } from "./cloud.js";

const T = path.join(path.dirname(fileURLToPath(import.meta.url)), "../templates");
const rd = (...p) => fs.readFileSync(path.join(T, ...p), "utf8");

const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
let CTX = null; // per-run context: { cwd, manifest, force, skipped }

function write(file, content, written) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  written.push(file);
}

// Agent files are "managed": overwritten only if the user has not edited them since we wrote them.
function writeManaged(file, content, written) {
  const rel = path.relative(CTX.cwd, file);
  if (fs.existsSync(file) && !CTX.force) {
    const cur = sha(fs.readFileSync(file, "utf8"));
    if (cur !== sha(content) && CTX.manifest[rel] !== cur) { CTX.skipped.push(rel); return; }
  }
  write(file, content, written);
  CTX.manifest[rel] = sha(content);
}

export function loadManifest(cwd) {
  try { return JSON.parse(fs.readFileSync(path.join(cwd, ".ai/manifest.json"), "utf8")); } catch { return {}; }
}

export function uninstall(cwd, { all = false } = {}) {
  const manifest = loadManifest(cwd);
  const removed = [], kept = [];
  for (const [rel, hash] of Object.entries(manifest)) {
    const f = path.join(cwd, rel);
    if (!fs.existsSync(f)) continue;
    if (sha(fs.readFileSync(f, "utf8")) === hash || all) { fs.rmSync(f); removed.push(rel); } else kept.push(rel);
  }
  for (const d of [".cursor/rules", ".cursor", ".opencode/agents", ".opencode"]) { try { fs.rmdirSync(path.join(cwd, d)); } catch { /* not empty or absent */ } }
  if (all) fs.rmSync(path.join(cwd, ".ai"), { recursive: true, force: true });
  return { removed, kept };
}

export function selectAgents(workflow, specialists = []) {
  const set = new Set([...WORKFLOWS[workflow].core, ...specialists]);
  return [...set].filter((a) => AGENTS[a]);
}

const LANG_AGENTS = ["frontend", "backend", "nextjs", "reviewer"];

function agentBody(name, workflow) {
  let body = rd("agents", `${name}.md`);
  if (CTX.language && LANG_AGENTS.includes(name)) body += "\n\n" + rd("lang", `${CTX.language}.md`);
  if (name === "orchestrator") body += "\n\n" + rd("workflows", `${workflow}.md`);
  return body;
}

const formats = {
  cursor(cwd, names, workflow, written) {
    for (const n of names) {
      const fm = `---\ndescription: ${AGENTS[n].desc}\nalwaysApply: ${n === "orchestrator"}\n---\n\n`;
      writeManaged(path.join(cwd, ".cursor/rules", `${n}.mdc`), fm + agentBody(n, workflow), written);
    }
  },
  opencode(cwd, names, workflow, written) {
    for (const n of names) {
      const fm = `---\ndescription: ${AGENTS[n].desc}\nmode: ${n === "orchestrator" ? "primary" : "subagent"}\n---\n\n`;
      writeManaged(path.join(cwd, ".opencode/agents", `${n}.md`), fm + agentBody(n, workflow), written);
    }
    const cfg = path.join(cwd, ".opencode/opencode.json");
    if (!fs.existsSync(cfg)) write(cfg, JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2) + "\n", written);
  },
  gemini(cwd, names, workflow, written) {
    const parts = ["# AI Team Instructions\n\nYou are the Orchestrator by default. When the Orchestrator delegates, adopt the delegated role fully and follow only that role's rules.\n"];
    for (const n of names) parts.push(`\n---\n\n<!-- ROLE: ${n} -->\n${agentBody(n, workflow)}`);
    writeManaged(path.join(cwd, "GEMINI.md"), parts.join("\n"), written);
  }
};

export function generate({ tool, workflow, specialists = [], language }, cwd, { force = false } = {}) {
  if (!formats[tool]) throw new Error(`Unknown tool: ${tool}`);
  if (!WORKFLOWS[workflow]) throw new Error(`Unknown workflow: ${workflow}`);
  const written = [];
  const names = selectAgents(workflow, specialists);
  const info = analyze(cwd);
  if (language && !normalizeLanguage(language)) throw new Error(`Unknown language: ${language} (use typescript or javascript)`);
  const detected = info.languages.includes("TypeScript") ? "typescript" : info.languages.includes("JavaScript") ? "javascript" : null;
  const lang = normalizeLanguage(language) || detected;
  CTX = { cwd, manifest: loadManifest(cwd), force, skipped: [], language: lang };
  formats[tool](cwd, names, workflow, written);

  // Project memory (existing memory is never overwritten unless --force)
  const ai = path.join(cwd, ".ai");
  info.language = lang;
  write(path.join(ai, "project-context.md"), renderContext(info), written);
  for (const f of ["architecture.md", "conventions.md", "security.md", "decisions.md"]) {
    const dest = path.join(ai, f);
    if (force || !fs.existsSync(dest)) write(dest, rd("ai", f), written);
  }
  write(path.join(ai, "reports/.gitkeep"), "", written);
  try { writeGraph(cwd); written.push(path.join(ai, "graph.md")); } catch { /* graph is best-effort */ }
  try { const c = scanCloud(cwd); if (c.cloud.providers.length) write(path.join(ai, "cloud.md"), renderCloud(c), written); } catch { /* cloud map is best-effort */ }

  const configPath = path.join(ai, "config.json");
  if (force || !fs.existsSync(configPath)) {
    const config = { tool, workflow, agents: names, ...(lang ? { language: lang } : {}), gate: detectGateCommands(info), audit: true, secretScan: true, ...defaultFlags(info.services, cwd) };
    write(configPath, JSON.stringify(config, null, 2) + "\n", written);
  }
  write(path.join(ai, "manifest.json"), JSON.stringify(CTX.manifest, null, 2) + "\n", written);
  return { written, agents: names, info, skipped: CTX.skipped, language: lang };
}
