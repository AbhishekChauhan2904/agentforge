import fs from "node:fs";
import path from "node:path";
import { findServices, isServerSide } from "./services.js";
import { splitTop } from "./api.js";

const SKIP = new Set(["node_modules", "dist", "build", "coverage", ".git", ".ai", "venv", ".venv", "__pycache__", "migrations"]);
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const lineOf = (t, i) => t.slice(0, i).split("\n").length;
function walk(root, rel = "", out = [], d = 0) {
  let es = []; try { es = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
    const r = path.join(rel, e.name);
    if (e.isDirectory()) { if (d < 8) walk(root, r, out, d + 1); } else out.push(r);
  }
  return out;
}
function balanced(t, open) {
  let depth = 0, q = null;
  for (let i = open; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if ("([{".includes(c)) depth++; else if (")]}".includes(c) && --depth === 0) return t.slice(open + 1, i);
  }
  return null;
}

function mongooseModels(text, file, add) {
  const models = [];
  for (const m of text.matchAll(/(?:const|let|var)?\s*(\w+)?\s*=?\s*new\s+(?:mongoose\.)?Schema\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const inner = balanced(text, open); if (inner == null) continue;
    const [defn, opts = ""] = splitTop(inner);
    const body = (defn || "").trim().replace(/^\{|\}$/g, "");
    const fields = {};
    for (const part of splitTop(body)) { const kv = part.match(/^\s*['"]?(\w+)['"]?\s*:\s*([\s\S]*)$/); if (kv) fields[kv[1]] = kv[2]; }
    const named = text.match(new RegExp(`model\\(\\s*['"](\\w+)['"]\\s*,\\s*${m[1] || "__none__"}\\b`));
    const name = named ? named[1] : (text.match(/model\(\s*['"](\w+)['"]/) || [])[1] || path.basename(file).replace(/\.\w+$/, "");
    const line = lineOf(text, m.index);
    const indexes = Object.values(fields).filter((v) => /\b(index|unique)\s*:\s*true/.test(v)).length + (text.match(/\.index\(/g) || []).length;
    for (const [k, v] of Object.entries(fields)) {
      if (/^(password|passwordHash|hash|passwd)$/i.test(k) && !/select\s*:\s*false/.test(v)) add("warn", file, line, `${name}.${k} is returned by default in queries: add select: false`);
      if (/^email$/i.test(k) && !/unique\s*:\s*true/.test(v) && !/\.index\([^)]*email[^)]*unique/.test(text)) add("warn", file, line, `${name}.email is not unique`);
      if (/^(role|roles|status)$/i.test(k) && !/enum/.test(v)) add("warn", file, line, `${name}.${k} has no enum: any string is accepted`);
      if (/ref\s*:/.test(v) && !/index\s*:\s*true/.test(v)) add("info", file, line, `${name}.${k} references another collection without an index (mongo does not index refs)`);
    }
    if (!/timestamps/.test(opts)) add("warn", file, line, `${name}: no timestamps option (createdAt/updatedAt)`);
    if (/strict\s*:\s*false/.test(opts)) add("warn", file, line, `${name}: strict:false lets unknown fields be stored`);
    if (!Object.values(fields).some((v) => /required/.test(v))) add("warn", file, line, `${name}: no field is required`);
    const relations = Object.entries(fields).flatMap(([k, v]) => { const r = v.match(/ref\s*:\s*['"](\w+)['"]/); return r ? [{ to: r[1], field: k, many: /^\s*\[/.test(v) }] : []; });
    models.push({ name, orm: "mongoose", fields: Object.keys(fields).length, indexes, relations, file, line });
  }
  return models;
}

function prismaModels(text, file, add) {
  const models = [];
  const known = [...text.matchAll(/^model\s+(\w+)/gm)].map((x) => x[1]);
  const bodies = Object.fromEntries([...text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map((x) => [x[1], x[2]]));
  for (const m of text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const body = m[2], line = lineOf(text, m.index), name = m[1];
    const fields = body.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("@@") && !l.startsWith("//"));
    const idxText = (body.match(/@@(index|unique)\([^)]*\)/g) || []).join(" ");
    for (const f of fields) {
      const [fname, ftype] = f.split(/\s+/);
      if (/^email$/i.test(fname) && !/@unique/.test(f) && !new RegExp(`@@unique\\([^)]*${fname}`).test(idxText)) add("warn", file, line, `${name}.email is not unique`);
      if (/Id$/.test(fname) && /^(Int|String|BigInt)\b/.test(ftype || "") && !/@(id|unique)/.test(f) && !new RegExp(`\\b${fname}\\b`).test(idxText)) add("warn", file, line, `${name}.${fname} is a foreign key with no @@index`);
    }
    const relations = [];
    for (const f of fields) {
      const [fname, ftype = ""] = f.split(/\s+/), base = ftype.replace(/[?\[\]]/g, "");
      if (!known.includes(base)) continue;
      if (/@relation\([^)]*fields:/.test(f)) relations.push({ to: base, field: fname, many: false });
      else if (ftype.endsWith("[]") && base !== name && name < base && !new RegExp(`^\\s*\\w+\\s+${name}\\??\\s`, "m").test(bodies[base] || "")) relations.push({ to: base, field: fname, many: true });
    }
    models.push({ name, orm: "prisma", fields: fields.length, indexes: (body.match(/@@index|@unique|@@unique|@id/g) || []).length, relations, file, line });
  }
  return models;
}

function pythonModels(text, file, add) {
  const models = [];
  for (const m of text.matchAll(/^class\s+(\w+)\(([^)]*(?:db\.Model|Base|DeclarativeBase|models\.Model|SQLModel)[^)]*)\):([\s\S]*?)(?=^class\s|(?![\s\S]))/gm)) {
    const body = m[3], name = m[1], line = lineOf(text, m.index);
    const orm = /models\.Model/.test(m[2]) ? "django" : "sqlalchemy";
    const emailLine = body.match(/^\s*email\s*=.*$/m);
    if (emailLine && !/unique\s*=\s*True/.test(emailLine[0])) add("warn", file, line, `${name}.email is not unique`);
    if (orm === "sqlalchemy") for (const fk of body.matchAll(/^\s*(\w+)\s*=.*ForeignKey\(.*$/gm)) if (!/index\s*=\s*True/.test(fk[0])) add("warn", file, line, `${name}.${fk[1]} is a foreign key without index=True`);
    if (orm === "django") for (const pw of body.matchAll(/^\s*(password|token|secret)\w*\s*=\s*models\.(Char|Text)Field/gm)) add("warn", file, line, `${name}: plain ${pw[1]} field (store hashes only; use Django auth)`);
    const relations = [];
    if (orm === "django") for (const r of body.matchAll(/^\s*(\w+)\s*=\s*models\.(ForeignKey|OneToOneField|ManyToManyField)\(\s*['"]?([\w.]+)['"]?/gm)) relations.push({ to: r[3].split(".").pop(), field: r[1], many: r[2] === "ManyToManyField" });
    else for (const r of body.matchAll(/^\s*(\w+)\s*=.*ForeignKey\(\s*['"](\w+)\.\w+['"]/gm)) relations.push({ toTable: r[2], field: r[1], many: false });
    const table = (body.match(/__tablename__\s*=\s*['"](\w+)['"]/) || [])[1];
    models.push({ name, orm, table, relations, fields: (body.match(/^\s+\w+\s*=\s*(?:\w+\.)?(?:Column|\w+Field|ForeignKey|relationship|mapped_column)/gm) || []).length, indexes: (body.match(/index\s*=\s*True|unique\s*=\s*True|db_index\s*=\s*True/g) || []).length, file, line });
  }
  return models;
}

export function scanDb(cwd) {
  const models = [], findings = [];
  for (const svc of findServices(cwd).filter(isServerSide)) {
    const root = path.join(cwd, svc.dir), pre = (f) => path.join(svc.dir === "." ? "" : svc.dir, f);
    const add = (level, file, line, msg) => findings.push({ level, file, line, msg });
    for (const f of walk(root)) {
      const full = pre(f), isTest = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.|test_/.test(f);
      const t = read(path.join(root, f));
      if (!t) continue;
      if (/\.(m?[jt]s|cjs)$/.test(f)) {
        if (/Schema\s*\(/.test(t)) models.push(...mongooseModels(t, full, add).map((m) => ({ ...m, service: svc.dir })));
        if (isTest) continue;
        const chk = (re, level, msg) => { for (const m of t.matchAll(re)) add(level, full, lineOf(t, m.index), msg); };
        chk(/\.(find|findOne|findOneAndUpdate|findOneAndDelete|updateOne|updateMany|deleteOne|deleteMany|countDocuments)\(\s*req\.(body|query|params)\s*[,)]/g, "error", "request data used directly as a Mongo filter (NoSQL injection)");
        for (const v of t.matchAll(/(?:const|let)\s+(\w+)\s*=\s*await\s+(?:req|request)\.json\(\)/g)) {
          const use = new RegExp(`\\.(create|update|updateMany|upsert|insertMany|findOneAndUpdate)\\(\\s*\\{[^}]*\\b(data|\\$set)\\s*:\\s*${v[1]}\\b`).exec(t);
          if (use && !/(safeParse|\.parse\(|validate|schema)/i.test(t)) add("warn", full, lineOf(t, use.index), "request JSON written to the database without validation (mass assignment): parse it with a schema (zod) first");
        }
        chk(/\$where\b/g, "error", "$where executes JavaScript in the database (injection risk)");
        chk(/\b(?:create|insertMany)\(\s*req\.body\s*\)|new\s+[A-Z]\w*\(\s*req\.body\s*\)|findByIdAndUpdate\([^,]+,\s*req\.body|findOneAndUpdate\([^,]+,\s*req\.body|updateOne\([^,]+,\s*(?:\{\s*\$set\s*:\s*)?req\.body/g, "warn", "whole request body written to the database (mass assignment): whitelist fields");
        chk(/\.(query|execute|raw|\$queryRawUnsafe|\$executeRawUnsafe)\(\s*(`[^`]*\$\{|['"][^'"]*['"]\s*\+)/g, "error", "SQL built by string concatenation (SQL injection)");
      }
      if (f.endsWith(".prisma")) models.push(...prismaModels(t, full, add).map((m) => ({ ...m, service: svc.dir })));
      if (f.endsWith(".py")) {
        if (/\bclass\s+\w+\(/.test(t)) models.push(...pythonModels(t, full, add).map((m) => ({ ...m, service: svc.dir })));
        if (isTest) continue;
        for (const m of t.matchAll(/\.(execute|executemany|raw)\(\s*(?:f['"][^'"]*(?:SELECT|INSERT|UPDATE|DELETE)[^'"]*\{|['"][^'"]*(?:SELECT|INSERT|UPDATE|DELETE)[^'"]*['"]\s*(?:%|\+|\.format))/gi)) add("error", full, lineOf(t, m.index), "SQL built by string formatting (SQL injection): use parameters");
        for (const m of t.matchAll(/\.(filter|get|exclude)\(\s*\*\*request\.(data|GET|POST|query_params)/g)) add("error", full, lineOf(t, m.index), "request data expanded into an ORM filter");
      }
    }
  }
  return { models, findings };
}

export function renderDbMap({ models, findings }) {
  return `# Database Map (auto-generated by \`agentforge db\`)

Static analysis of schema files and query code. It cannot see your real indexes or data; run \`explain\` on hot queries.

| Model | ORM | Fields | Index/unique decls | Source |
|-------|-----|--------|--------------------|--------|
${models.map((m) => `| ${m.name} | ${m.orm} | ${m.fields} | ${m.indexes} | ${m.file}:${m.line} |`).join("\n") || "| - | no models found | | | |"}

## Findings

${findings.length ? findings.map((f) => `- **${f.level}** \`${f.file}:${f.line}\` ${f.msg}`).join("\n") : "None."}
`;
}
