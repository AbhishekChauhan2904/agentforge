import fs from "node:fs";
import path from "node:path";

export const SKIP = new Set(["node_modules", "dist", "build", "coverage", ".git", ".ai", ".next", ".cursor", ".opencode", ".gemini", "venv", ".venv", "__pycache__", ".dart_tool", "vendor", ".terraform", "out", ".turbo", ".cache", "migrations"]);
const FLUTTER_SKIP = new Set(["android", "ios", "web", "linux", "macos", "windows"]);
export const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };

export function walk(root, { flutter = false } = {}, rel = "", out = [], d = 0) {
  let es = []; try { es = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    if (SKIP.has(e.name) || (e.name.startsWith(".") && e.isDirectory()) || (flutter && rel === "" && FLUTTER_SKIP.has(e.name))) continue;
    const r = path.join(rel, e.name);
    if (e.isDirectory()) { if (d < 10) walk(root, { flutter }, r, out, d + 1); } else out.push(r);
  }
  return out;
}

export const EXT = { node: /\.(m?[jt]sx?|cjs)$/, python: /\.py$/, flutter: /\.dart$/ };
export const GENERATED = /(\.min\.|\.generated\.|\.bundle\.|\.d\.ts$|-lock\.|\.pb\.|\.g\.dart$|\.freezed\.dart$)/;
export const isTestFile = (f) => /(\.(test|spec)\.[mc]?[jt]sx?$)|(^|\/)__tests__\/|(^|\/)(tests?|e2e|cypress)\/|(^|\/)test_[^/]+\.py$|_test\.py$|_test\.dart$|_test\.go$/.test(f.split(path.sep).join("/"));
export const langOf = (f) => ({ js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript", py: "Python", dart: "Dart" })[path.extname(f).slice(1).toLowerCase()];
export const lineOf = (t, i) => t.slice(0, i).split("\n").length;

// Code / comment / blank lines.
export function countLoc(text, lang) {
  let code = 0, comment = 0, blank = 0, block = false, doc = null;
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (!l) { blank++; continue; }
    if (lang === "python") {
      if (doc) { comment++; if (l.includes(doc)) doc = null; continue; }
      if (l.startsWith("#")) { comment++; continue; }
      const m = l.match(/^[rbfRBF]*("""|''')/);
      if (m) { comment++; if (!l.slice(m[0].length).includes(m[1])) doc = m[1]; continue; }
      code++; continue;
    }
    if (block) { comment++; if (l.includes("*/")) block = false; continue; }
    if (l.startsWith("//")) { comment++; continue; }
    if (l.startsWith("/*")) { comment++; if (!l.includes("*/")) block = true; continue; }
    code++;
  }
  return { code, comment, blank };
}

// Same-length copy of the source with comments and string contents blanked (newlines kept), so brackets and
// keywords can be counted without being fooled by text inside strings.
export function blankNoise(t) {
  let out = "", i = 0, q = null;
  while (i < t.length) {
    const c = t[i], n = t[i + 1];
    if (q) {
      if (c === "\\") { out += "  "; i += 2; continue; }
      if (c === q) { q = null; out += c; i++; continue; }
      out += c === "\n" ? "\n" : " "; i++; continue;
    }
    if (c === "/" && n === "/") { while (i < t.length && t[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && n === "*") { out += "  "; i += 2; while (i < t.length && !(t[i] === "*" && t[i + 1] === "/")) { out += t[i] === "\n" ? "\n" : " "; i++; } out += "  "; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

function match(c, open, o, cl) { let d = 0; for (let i = open; i < c.length; i++) { if (c[i] === o) d++; else if (c[i] === cl && --d === 0) return i; } return -1; }

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "with", "return", "function", "else", "do", "try", "constructor_"]);
const cxOf = (body) => 1 + (body.match(/\b(if|for|while|case|catch)\b|&&|\|\||\?\?|\?(?![.?:])/g) || []).length;
function depthOf(body) { let d = 0, m = 0; for (const ch of body) { if (ch === "{") m = Math.max(m, ++d); else if (ch === "}") d--; } return Math.max(0, m - 1); }

export function jsFunctions(text) {
  const c = blankNoise(text), seen = new Map();
  const add = (name, at, bodyStart, bodyEnd) => {
    if (bodyEnd < 0 || seen.has(bodyStart)) return;
    const body = c.slice(bodyStart, bodyEnd + 1);
    seen.set(bodyStart, { name: name || `anonymous@${lineOf(c, at)}`, line: lineOf(c, at), lines: lineOf(c, bodyEnd) - lineOf(c, at) + 1, complexity: cxOf(body), depth: depthOf(body) });
  };
  for (const m of c.matchAll(/(?:^|[^\w$.])(?:async\s+)?function\s*\*?\s*([\w$]*)\s*\(/g)) {
    const p = m.index + m[0].length - 1, pe = match(c, p, "(", ")"); if (pe < 0) continue;
    const bi = c.indexOf("{", pe), gap = c.slice(pe, bi < 0 ? pe : bi); if (bi < 0 || gap.includes(";") || gap.length > 200) continue;
    add(m[1], m.index + (/^[^\w$.]/.test(m[0]) ? 1 : 0), bi, match(c, bi, "{", "}"));
  }
  const arrow = /(?:^|[;\s])((?:const|let|var)\s+)?([\w$]+(?:\.[\w$]+)*)\s*(?::[^=;{]+?)?=\s*(?:async\s*)?(?:\([^()]*(?:\([^()]*\)[^()]*)*\)|[\w$]+)\s*(?::\s*[^=;{]+?)?\s*=>\s*/g;
  for (const m of c.matchAll(arrow)) {
    const at = m.index + m[0].length, from = m.index + (/^[;\s]/.test(m[0]) ? 1 : 0);
    if (c[at] === "{") add(m[2], from, at, match(c, at, "{", "}"));
    else { let d = 0, e = at; for (; e < c.length; e++) { const ch = c[e]; if ("([{".includes(ch)) d++; else if (")]}".includes(ch)) { if (d === 0) break; d--; } else if ((ch === ";" || ch === "\n") && d === 0) break; } add(m[2], from, at, e - 1 < at ? at : e - 1); }
  }
  for (const m of c.matchAll(/^[ \t]*(?:(?:public|private|protected|static|async|get|set|override|readonly)\s+)*([\w$]+)\s*(?:<[^>]*>)?\s*\(/gm)) {
    if (KEYWORDS.has(m[1])) continue;
    const p = m.index + m[0].length - 1, pe = match(c, p, "(", ")"); if (pe < 0) continue;
    const bi = c.indexOf("{", pe), gap = c.slice(pe + 1, bi < 0 ? pe + 1 : bi); if (bi < 0 || /[;=]/.test(gap) || gap.length > 120) continue;
    add(m[1], m.index, bi, match(c, bi, "{", "}"));
  }
  for (const m of c.matchAll(/(?:async\s*)?\([^()]*\)\s*=>\s*\{/g)) { const bi = m.index + m[0].length - 1; add(null, m.index, bi, match(c, bi, "{", "}")); }
  return [...seen.values()].sort((a, b) => a.line - b.line);
}

export function pyFunctions(text) {
  const lines = text.split("\n"), out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/);
    if (!m) continue;
    const base = m[1].length; let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || lines[j].length - lines[j].trimStart().length > base)) j++;
    let end = j - 1; while (end > i && !lines[end].trim()) end--;
    const body = lines.slice(i + 1, end + 1).filter((l) => !l.trim().startsWith("#")).join("\n");
    const unit = (body.match(/^( +)\S/m) || [, "    "])[1].length || 4;
    const depth = Math.max(0, ...body.split("\n").filter((l) => l.trim()).map((l) => Math.round((l.length - l.trimStart().length - (base + unit)) / unit) + 0)) ;
    out.push({ name: m[2], line: i + 1, lines: end - i + 1, complexity: 1 + (body.match(/\b(if|elif|for|while|except|and|or|case)\b/g) || []).length, depth });
  }
  return out;
}

export const functionsOf = (text, lang) => (lang === "python" ? pyFunctions(text) : lang === "node" ? jsFunctions(text) : []);
