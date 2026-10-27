import fs from "node:fs";
import path from "node:path";
import { AGENTS, WORKFLOWS } from "./registry.js";
import { findServices } from "./services.js";
import { defaultFlags } from "./audit.js";

export const normalizeLanguage = (v) => ({ ts: "typescript", typescript: "typescript", js: "javascript", javascript: "javascript" })[String(v || "").toLowerCase()] || null;

export function validateConfig(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== "object") return ["config must be a JSON object"];
  if (!["cursor", "opencode", "gemini"].includes(cfg.tool)) errors.push(`"tool" must be cursor, opencode or gemini (got ${JSON.stringify(cfg.tool)})`);
  if (!WORKFLOWS[cfg.workflow]) errors.push(`"workflow" must be one of ${Object.keys(WORKFLOWS).join(", ")}`);
  if (!Array.isArray(cfg.agents) || cfg.agents.some((a) => !AGENTS[a])) errors.push(`"agents" must be a list of known agent names`);
  if (cfg.language !== undefined && !["typescript", "javascript"].includes(cfg.language)) errors.push(`"language" must be typescript or javascript (got ${JSON.stringify(cfg.language)})`);
  if (!Array.isArray(cfg.gate)) errors.push(`"gate" must be a list of { name, cmd }`);
  else cfg.gate.forEach((g, i) => { if (!g || typeof g.name !== "string" || typeof g.cmd !== "string" || !g.cmd.trim()) errors.push(`gate[${i}] needs string "name" and non-empty "cmd"`); });
  return errors;
}

export function loadConfig(cwd) {
  const file = path.join(cwd, ".ai/config.json");
  if (!fs.existsSync(file)) throw new Error("Missing .ai/config.json. Run `agentforge init` first.");
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { throw new Error(`.ai/config.json is not valid JSON: ${e.message}`); }
  const errors = validateConfig(cfg);
  if (errors.length) throw new Error(".ai/config.json problems:\n  - " + errors.join("\n  - "));
  return cfg;
}

// Upgrade a config written by an older agentforge: add only the keys that are missing (never change or remove
// anything the user set), so new checks and the language rules are available without a full re-init.
export function migrateConfig(cwd, language) {
  const file = path.join(cwd, ".ai/config.json");
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  const added = [];
  for (const [k, v] of Object.entries(defaultFlags(findServices(cwd), cwd))) if (!(k in cfg)) { cfg[k] = v; added.push(k); }
  if (language && !cfg.language) { cfg.language = language; added.push("language"); }
  if (added.length) fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  return added;
}
