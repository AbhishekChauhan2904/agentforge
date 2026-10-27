import fs from "node:fs";
import path from "node:path";
import { findServices } from "./services.js";
import { cloudUsage } from "./cloud.js";

const SKIP = new Set(["node_modules", "dist", "build", "coverage", ".git", ".next", ".ai", ".cursor", ".opencode", ".gemini", "__pycache__", "vendor"]);
const CODE = /\.(m?[jt]sx?|cjs|py|dart)$/;
const EXT = { node: /\.(m?[jt]sx?|cjs)$/, python: /\.py$/, flutter: /\.dart$/ };
const TESTFILE = /(\.(test|spec)\.|_test\.dart$|(^|\/)test_[^/]+\.py$|_test\.py$|(^|\/)(tests?|__tests__)\/)/;
const LANGS = { js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JavaScript", ts: "TypeScript", tsx: "TypeScript", py: "Python", go: "Go", java: "Java", kt: "Kotlin", rs: "Rust", dart: "Dart", rb: "Ruby", php: "PHP", cs: "C#", css: "CSS", scss: "CSS", html: "HTML" };
const INFRA = { mongo: ["MongoDB", "mongo|mongodb"], postgres: ["PostgreSQL", "postgres|postgresql|db"], mysql: ["MySQL", "mysql"], redis: ["Redis", "redis|cache"], rabbitmq: ["RabbitMQ", "rabbitmq|rabbit"], kafka: ["Kafka", "kafka"] };

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const id = (s) => "n_" + s.replace(/[^A-Za-z0-9_]/g, "_");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function walk(root, rel = "", out = [], depth = 0) {
  let entries = [];
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP.has(e.name) || (e.name.startsWith(".") && e.isDirectory())) continue;
    const r = path.join(rel, e.name);
    if (e.isDirectory()) { if (depth < 8) walk(root, r, out, depth + 1); } else out.push(r);
  }
  return out;
}

export function languageBreakdown(cwd) {
  const counts = {};
  for (const f of walk(cwd)) { const l = LANGS[path.extname(f).slice(1).toLowerCase()]; if (l) counts[l] = (counts[l] || 0) + 1; }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

export function readJsonc(text) {
  return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
}

// tsconfig/jsconfig "paths" (e.g. "@/*": ["./src/*"]) so aliased imports become graph edges.
function loadAliases(root) {
  for (const f of ["tsconfig.json", "jsconfig.json"]) {
    let t; try { t = fs.readFileSync(path.join(root, f), "utf8"); } catch { continue; }
    try {
      const j = readJsonc(t);
      const co = j.compilerOptions || {}, base = co.baseUrl || ".";
      const out = Object.entries(co.paths || {}).map(([k, v]) => ({ prefix: k.replace(/\*$/, ""), target: path.posix.normalize(path.posix.join(base, String(v[0] || "").replace(/\*$/, ""))).replace(/^\.\//, "").replace(/^\.$/, "") }));
      if (!out.length && co.baseUrl && co.baseUrl !== ".") out.push({ prefix: "", target: path.posix.normalize(co.baseUrl).replace(/^\.\//, "") });
      return out.filter((a) => a.prefix);
    } catch { return []; }
  }
  return [];
}

function importsFor(lang, text, aliases = []) {
  const out = []; let m;
  if (lang === "python") {
    const re1 = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+([\w, *]+)/gm, re2 = /^[ \t]*import[ \t]+([\w.]+)/gm;
    while ((m = re1.exec(text))) out.push({ dots: m[1].length, mod: m[2], names: m[3] });
    while ((m = re2.exec(text))) out.push({ dots: 0, mod: m[1], names: "" });
  } else if (lang === "flutter") {
    const re = /^[ \t]*(?:import|export)[ \t]+['"]([^'"]+)['"]/gm;
    while ((m = re.exec(text))) out.push(m[1]);
  } else {
    const re = /(?:import\s+(?:[^'";]*?\s+from\s+)?|require\(\s*|import\(\s*|export\s+[^'";]*?\s+from\s+)['"]([^'"]+)['"]/g;
    while ((m = re.exec(text))) if (m[1].startsWith(".") || aliases.some((a) => m[1].startsWith(a.prefix))) out.push(m[1]);
  }
  return out;
}

// Resolve an import to a path relative to the service root (or null if external).
function targetOf(lang, root, fileRel, imp, pkgName, aliases = []) {
  const dir = path.dirname(fileRel);
  const rel = (spec) => path.relative(root, path.resolve(root, dir, spec));
  if (lang === "python") {
    const parts = imp.mod ? imp.mod.split(".") : [];
    if (imp.dots > 0) {
      const base = dir.split(path.sep).filter((x) => x && x !== ".");
      for (let i = 1; i < imp.dots; i++) base.pop();
      if (!parts.length && imp.names) parts.push(imp.names.split(",")[0].trim());
      return [...base, ...parts].join(path.sep);
    }
    if (!parts.length) return null;
    for (const pre of ["", "src"]) if (fs.existsSync(path.join(root, pre, parts[0])) || fs.existsSync(path.join(root, pre, parts[0] + ".py"))) return path.join(pre, ...parts);
    return null;
  }
  if (lang === "flutter") {
    if (imp.startsWith(`package:${pkgName}/`)) return path.join("lib", imp.slice(`package:${pkgName}/`.length));
    return /^(package|dart):/.test(imp) ? null : rel(imp);
  }
  if (!imp.startsWith(".")) { const a = aliases.find((x) => imp.startsWith(x.prefix)); return a ? path.join(a.target, imp.slice(a.prefix.length)) : null; }
  return rel(imp);
}

// Which top-level folder does a path belong to? (a directory import counts as that folder)
function groupOf(relPath, lang, root, fw) {
  const parts = relPath.split(path.sep).filter(Boolean);
  const isDir = parts.length === 1 && root && (() => { try { return fs.statSync(path.join(root, relPath)).isDirectory(); } catch { return false; } })();
  if (parts[0] === "src" || (lang === "flutter" && parts[0] === "lib") || (lang === "python" && parts[0] === "app")) {
    const wasDir = parts.length === 2 && root && (() => { try { return fs.statSync(path.join(root, relPath)).isDirectory(); } catch { return false; } })();
    parts.shift();
    if (parts.length === 1 && wasDir) return parts[0];
  }
  if (lang === "flutter" && parts[0] === "features" && parts.length > 2) return `features/${parts[1]}`;
  if (fw === "next" && (parts[0] === "app" || parts[0] === "pages") && parts.length > 2) return `${parts[0]}/${parts[1]}`;   // split app/ and pages/ by section
  return parts.length <= 1 && !isDir ? "(root)" : parts[0];
}

export function moduleGraph(cwd, svc) {
  const lang = svc.lang || "node";
  const root = path.join(cwd, svc.dir);
  const files = walk(root).filter((f) => EXT[lang].test(f) && !TESTFILE.test(f));
  const nodes = {}, edges = {}, fileOut = {}, fileIn = {};
  const aliases = lang === "node" ? loadAliases(root) : [];
  for (const f of files) {
    const g = groupOf(f, lang, undefined, svc.framework);
    nodes[g] = (nodes[g] || 0) + 1;
    let text = ""; try { text = fs.readFileSync(path.join(root, f), "utf8"); } catch { continue; }
    for (const imp of importsFor(lang, text, aliases)) {
      const target = targetOf(lang, root, f, imp, svc.name, aliases);
      if (target == null || target.startsWith("..")) continue;
      const tg = groupOf(target, lang, root, svc.framework);
      fileOut[f] = (fileOut[f] || 0) + 1;
      const tkey = target.replace(/\.(m?[jt]sx?|cjs|py|dart)$/, "").replace(/\/index$/, ""); fileIn[tkey] = (fileIn[tkey] || 0) + 1;
      if (tg === g) continue;
      const k = `${g}\u0000${tg}`;
      edges[k] = (edges[k] || 0) + 1;
    }
  }
  const list = Object.entries(edges).map(([k, n]) => { const [from, to] = k.split("\u0000"); return { from, to, n }; });
  return { nodes, edges: list, cycles: findCycles(Object.keys(nodes), list), fileOut, fileIn };
}

// Strongly connected groups of size > 1 (circular dependencies between folders).
export function findCycles(nodes, edges) {
  const adj = {}; nodes.forEach((n) => (adj[n] = []));
  edges.forEach((e) => { (adj[e.from] ||= []).push(e.to); (adj[e.to] ||= []); });
  const reach = (s) => { const seen = new Set(); const st = [s]; while (st.length) for (const nx of adj[st.pop()] || []) if (!seen.has(nx)) { seen.add(nx); st.push(nx); } return seen; };
  const R = Object.fromEntries(Object.keys(adj).map((n) => [n, reach(n)]));
  const done = new Set(), cycles = [];
  for (const n of Object.keys(adj)) {
    if (done.has(n) || !R[n].has(n)) continue;
    const comp = Object.keys(adj).filter((m) => R[n].has(m) && R[m].has(n));
    comp.forEach((m) => done.add(m));
    cycles.push(comp.sort());
  }
  return cycles;
}

function sourceText(cwd, svc) {
  const root = path.join(cwd, svc.dir);
  let text = "";
  for (const f of walk(root).filter((x) => CODE.test(x) || /\.env(\.example)?$/.test(x)).slice(0, 400)) {
    try { const t = fs.readFileSync(path.join(root, f), "utf8"); if (t.length < 200_000) text += "\n" + t; } catch { /* skip */ }
  }
  return text;
}

function composeDepends(cwd) {
  const file = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"].map((f) => path.join(cwd, f)).find((f) => fs.existsSync(f));
  if (!file) return [];
  const out = []; let svc = null, inDeps = false;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const indent = raw.length - raw.trimStart().length, t = raw.trim();
    if (!t || t.startsWith("#")) continue;
    if (indent === 2 && t.endsWith(":")) { svc = t.slice(0, -1); inDeps = false; continue; }
    if (indent === 4) inDeps = t === "depends_on:";
    if (inDeps && indent > 4 && svc) { const m = t.match(/^-\s*(\S+)$|^([A-Za-z0-9_.-]+):/); const dep = m && (m[1] || m[2]); if (dep && dep !== "condition") out.push([svc, dep]); }
  }
  return out;
}

export function systemGraph(cwd, services) {
  const nodes = [], edges = [];
  const infra = new Set();
  const addEdge = (from, to, label, dashed) => { if (!edges.some((e) => e.from === from && e.to === to)) edges.push({ from, to, label, dashed }); };
  const texts = Object.fromEntries(services.map((s) => [s.dir, sourceText(cwd, s)]));
  const apis = services.filter((s) => s.kind === "api");

  for (const s of services) {
    nodes.push(`  ${id(s.dir)}["${s.name}<br/>${s.kind}${s.framework || (s.lang && s.lang !== "node") ? " (" + (s.framework || s.lang) + ")" : ""} · ${s.dir}"]`);
    for (const n of s.needs) { infra.add(n); addEdge(id(s.dir), `infra_${n}`, "uses", false); }
  }
  for (const a of services) for (const b of services) {
    if (a === b || a.kind === "lib") continue;
    const nm = esc(b.name.replace(/^@?[^/]*\//, ""));
    const url = new RegExp(`https?://[\\w.-]*${nm}[\\w.-]*(?::\\d+)?`, "i");
    const env = new RegExp(`${esc(b.name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase())}_(SERVICE_)?(URL|HOST|ADDR|ENDPOINT)`);
    if (url.test(texts[a.dir]) || env.test(texts[a.dir])) addEdge(id(a.dir), id(b.dir), "HTTP", false);
  }
  for (const f of services.filter((s) => s.kind === "frontend" || s.kind === "mobile")) {
    const talks = /\b(fetch|axios|Dio|dio|http\.(get|post|put|delete))\b|\/api\//.test(texts[f.dir]);
    if (talks && apis.length === 1) addEdge(id(f.dir), id(apis[0].dir), "HTTP", edges.some((e) => e.from === id(f.dir)) ? false : true);
  }
  for (const [from, dep] of composeDepends(cwd)) {
    const a = services.find((s) => norm(s.name) === norm(from) || norm(path.basename(s.dir)) === norm(from));
    const b = services.find((s) => norm(s.name) === norm(dep) || norm(path.basename(s.dir)) === norm(dep));
    const inf = Object.entries(INFRA).find(([, [, re]]) => new RegExp(`^(${re})$`).test(dep.toLowerCase()));
    if (a && b) addEdge(id(a.dir), id(b.dir), "depends_on", true);
    else if (a && inf) { infra.add(inf[0]); addEdge(id(a.dir), `infra_${inf[0]}`, "depends_on", true); }
  }
  const cloudNodes = new Map();
  for (const sv of services) for (const u of cloudUsage(cwd, sv)) { const cid = `cloud_${u.provider}_${u.name.replace(/[^A-Za-z0-9]/g, "_")}`; cloudNodes.set(cid, `${u.provider === "aws" ? "AWS" : "Azure"} ${u.name}`); addEdge(id(sv.dir), cid, "uses", false); }
  const lines = ["flowchart LR"];
  if (services.some((s) => s.kind === "frontend" || s.kind === "mobile")) {
    lines.push('  user(["Users / Browser"])');
    services.filter((s) => s.kind === "frontend" || s.kind === "mobile").forEach((s) => lines.push(`  user --> ${id(s.dir)}`));
  }
  lines.push(...nodes);
  for (const i of infra) lines.push(`  infra_${i}[("${INFRA[i][0]}")]`);
  for (const [cid, label] of cloudNodes) lines.push(`  ${cid}{{"${label}"}}`);
  for (const e of edges) lines.push(`  ${e.from} ${e.dashed ? "-.->" : "-->"}|${e.label}| ${e.to}`);
  return { mermaid: lines.join("\n"), edges, infra: [...infra] };
}

function moduleMermaid(g) {
  const names = Object.keys(g.nodes);
  const lines = ["flowchart TD", ...names.map((n) => `  m_${id(n)}["${n} (${g.nodes[n]} file${g.nodes[n] > 1 ? "s" : ""})"]`)];
  for (const e of g.edges) lines.push(`  m_${id(e.from)} -->|${e.n}| m_${id(e.to)}`);
  const bad = [...new Set(g.cycles.flat())];
  if (bad.length) lines.push("  classDef cycle stroke:#d33,stroke-width:3px,color:#d33", `  class ${bad.map((n) => "m_" + id(n)).join(",")} cycle`);
  return lines.join("\n");
}

export function buildGraph(cwd) {
  const services = findServices(cwd);
  const system = systemGraph(cwd, services);
  const modules = services.map((s) => ({ svc: s, ...moduleGraph(cwd, s) })).filter((m) => Object.keys(m.nodes).length > 1);
  const languages = languageBreakdown(cwd);
  const cycles = modules.flatMap((m) => m.cycles.map((c) => ({ service: m.svc.dir, groups: c })));
  const md = [
    "# Project Graph (auto-generated by `agentforge graph`)", "",
    "Agents MUST read this before planning: it shows which parts connect. Solid arrows have direct evidence (a dependency, or a URL/env var naming the other service). Dotted arrows are inferred (docker-compose `depends_on`, or a frontend calling an API without naming it). Regenerate with `agentforge graph`.", "",
    "## System view", "", "```mermaid", system.mermaid, "```", "",
    ...modules.flatMap((m) => [`## Module view: ${m.svc.dir}`, "", "Numbers on arrows = import count. Red = part of a circular dependency.", "", "```mermaid", moduleMermaid(m), "```", ""]),
    "## Circular dependencies", "", cycles.length ? cycles.map((c) => `- \`${c.service}\`: ${c.groups.join(" <-> ")}`).join("\n") : "None found.", "",
    "## Language breakdown (files)", "", "| Language | Files |", "|----------|-------|", ...languages.map(([l, n]) => `| ${l} | ${n} |`), ""
  ].join("\n");
  return { services, system, modules, cycles, languages, markdown: md };
}

export function writeGraph(cwd) {
  const g = buildGraph(cwd);
  fs.mkdirSync(path.join(cwd, ".ai"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".ai/graph.md"), g.markdown);
  return g;
}
