import fs from "node:fs";
import path from "node:path";
import { findServices, isServerSide } from "./services.js";

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

// ---- tiny parsing helpers (balanced brackets, string aware) ----
function balanced(text, open) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  let depth = 0, q = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && --depth === 0) return { inner: text.slice(open + 1, i), end: i };
  }
  return null;
}
export function splitTop(s) {
  const out = []; let depth = 0, q = null, cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === "\\") cur += s[++i] ?? ""; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; cur += c; continue; }
    if ("([{".includes(c)) depth++; else if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const unq = (s) => (s || "").trim().replace(/^['"`]|['"`]$/g, "");
const join = (a, b) => ("/" + a + "/" + b).replace(/\/+/g, "/").replace(/(.)\/$/, "$1");

// ---- classifiers (names of middleware / decorators / dependencies) ----
const AUTH = /\b(auth(?!oriz)\w*|protect\w*|jwt\w*|verifyToken\w*|require(Auth|Login|User)\w*|isAuthenticated\w*|isLoggedIn\w*|ensureAuth\w*|checkAuth\w*|authenticate\w*|checkJwt|withAuth|passport\.authenticate)\b/i;
const ROLES = /(role|admin|permission|authoriz|rbac|restrictTo|can\(|ability|policy|scope)/i;
const VALID = /(validat|celebrate|joi|zod|schema|checkSchema|body\(|check\(|query\(|param\()/i;
const RATE = /(rateLimit|limiter|throttle|slowDown)/i;
const classify = (t) => ({ auth: AUTH.test(t), roles: ROLES.test(t), validation: VALID.test(t), rateLimit: RATE.test(t) });
const or = (a, b) => ({ auth: a.auth || b.auth, roles: a.roles || b.roles, validation: a.validation || b.validation, rateLimit: a.rateLimit || b.rateLimit });
const NONE = { auth: false, roles: false, validation: false, rateLimit: false };
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PUBLIC = /(^|\/)(login|signin|register|signup|forgot|reset|verify|refresh|logout|health|ping|status|webhooks?|callback|oauth|auth|token|public|docs|swagger|openapi|metrics)(\/|$|-)/i;
const AUTHISH = /(login|signin|register|signup|forgot|reset|otp|password)/i;

// ================= Express =================
function scanExpress(cwd, svc) {
  const root = path.join(cwd, svc.dir);
  const files = walk(root).filter((f) => /\.(m?[jt]s|cjs)$/.test(f) && !/\.(test|spec)\.|(^|\/)(__tests__|tests?)\//.test(f));
  const texts = Object.fromEntries(files.map((f) => [f, read(path.join(root, f))]));
  const resolve = (from, spec) => {
    const base = path.join(path.dirname(from), spec);
    return [base, base + ".js", base + ".ts", base + ".mjs", path.join(base, "index.js"), path.join(base, "index.ts")].find((c) => texts[c] !== undefined) || null;
  };
  const routes = [], mounts = [], uses = {};
  for (const f of files) {
    const t = texts[f];
    const idents = {};
    for (const m of t.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) idents[m[1]] = resolve(f, m[2]);
    for (const m of t.matchAll(/import\s+(\w+)(?:\s*,\s*\{[^}]*\})?\s+from\s+['"](\.[^'"]+)['"]/g)) idents[m[1]] = resolve(f, m[2]);
    const recv = new Set([...t.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:express\.)?(?:Router|express|fastify)\(/g)].map((m) => m[1]));
    const isRecv = (n) => recv.has(n) || /^(app|router|routes?|api\w*|\w+Router|\w+Routes)$/.test(n);
    uses[f] = [];
    for (const m of t.matchAll(/\b(\w+)\.use\s*\(/g)) {
      if (!isRecv(m[1])) continue;
      const b = balanced(t, m.index + m[0].length - 1); if (!b) continue;
      const args = splitTop(b.inner);
      const hasPath = /^['"`]/.test(args[0] || "");
      const prefix = hasPath ? unq(args[0]) : "";
      const rest = hasPath ? args.slice(1) : args;
      const last = rest[rest.length - 1] || "";
      const inline = last.match(/require\(\s*['"](\.[^'"]+)['"]\s*\)/);
      const target = inline ? resolve(f, inline[1]) : idents[last.trim()] || null;
      const mws = target ? rest.slice(0, -1) : rest;
      const flags = classify(mws.join(","));
      uses[f].push({ idx: m.index, recv: m[1], flags });
      if (target) mounts.push({ from: f, to: target, prefix, idx: m.index, recv: m[1], flags });
    }
    const addRoute = (r, method, p, args, idx) => routes.push({ file: f, recv: r, method: method.toUpperCase(), path: p, args, idx, text: t });
    for (const m of t.matchAll(/\b(\w+)\.(get|post|put|patch|delete|all)\s*\(/g)) {
      if (!isRecv(m[1])) continue;
      const b = balanced(t, m.index + m[0].length - 1); if (!b) continue;
      const args = splitTop(b.inner);
      if (args.length < 2 || !/^['"`]/.test(args[0])) continue;
      addRoute(m[1], m[2], unq(args[0]), args.slice(1), m.index);
    }
    for (const m of t.matchAll(/\b(\w+)\.route\s*\(\s*(['"`])([^'"`]*)\2\s*\)/g)) {
      if (!isRecv(m[1])) continue;
      let pos = m.index + m[0].length;
      for (;;) {
        const mm = t.slice(pos).match(/^\s*\.(get|post|put|patch|delete|all)\s*\(/);
        if (!mm) break;
        const b = balanced(t, pos + mm[0].length - 1); if (!b) break;
        addRoute(m[1], mm[1], m[3], splitTop(b.inner), m.index);
        pos = b.end + 1;
      }
    }
  }
  const inherit = (file, seen = new Set()) => {
    const m = mounts.find((x) => x.to === file);
    if (!m || seen.has(file)) return { prefix: "", flags: NONE };
    seen.add(file);
    const up = inherit(m.from, seen);
    const before = (uses[m.from] || []).filter((u) => u.recv === m.recv && u.idx < m.idx && !mounts.some((x) => x.idx === u.idx && x.from === m.from));
    const flags = before.reduce((acc, u) => or(acc, u.flags), or(up.flags, m.flags));
    return { prefix: join(up.prefix, m.prefix), flags };
  };
  const bodyOf = (name) => {
    for (const t of Object.values(texts)) {
      const m = t.match(new RegExp(`(?:exports\\.|module\\.exports\\.|const\\s+|let\\s+|async\\s+function\\s+|function\\s+|\\b)${name}\\s*(?:=|\\()`));
      if (!m) continue;
      const rest = t.slice(m.index + 1, m.index + 3000);
      const next = rest.search(/\n(?:exports\.|module\.exports|const\s|let\s|var\s|async\s+function|function\s|export\s)/);
      return next < 0 ? rest : rest.slice(0, next);   // stop at the next top-level declaration
    }
    return "";
  };
  return routes.map((r) => {
    const inh = inherit(r.file);
    const local = (uses[r.file] || []).filter((u) => u.recv === r.recv && u.idx < r.idx && !mounts.some((x) => x.idx === u.idx && x.from === r.file)).reduce((a, u) => or(a, u.flags), NONE);
    const handler = r.args[r.args.length - 1] || "";
    const mw = r.args.slice(0, -1).join(",");
    const flags = or(or(inh.flags, local), classify(mw));
    const hname = /^(async\s*)?(\(|function|\w+\s*=>)/.test(handler.trim()) ? null : handler.trim().split(".").pop();
    const body = hname ? bodyOf(hname) : handler;
    return { framework: "express", method: r.method, path: join(inh.prefix, r.path), file: r.file, line: lineOf(r.text, r.idx), ...flags, body };
  });
}

// ================= FastAPI / Flask / Django REST =================
const PY_ROLE = /(require_role|require_admin|require_permission|role|admin|permission|has_perm|RoleChecker|scope)/i;
const PY_AUTH = /(current_user|get_current|authenticate|jwt|verify|token|oauth2|security|login_required)/i;
const pyFlags = (t) => { const roles = PY_ROLE.test(t); return { auth: PY_AUTH.test(t) || roles, roles, validation: false, rateLimit: false }; };
function scanPython(cwd, svc) {
  const root = path.join(cwd, svc.dir);
  const files = walk(root).filter((f) => f.endsWith(".py") && !/(^|\/)(tests?|test_[^/]*)\b|_test\.py$/.test(f));
  const out = [];
  const prefixByName = {};
  const texts = Object.fromEntries(files.map((f) => [f, read(path.join(root, f))]));
  for (const t of Object.values(texts)) {
    for (const m of t.matchAll(/include_router\s*\(/g)) {
      const b = balanced(t, m.index + m[0].length - 1); if (!b) continue;
      const args = splitTop(b.inner);
      const name = (args[0] || "").replace(/\.router$/, "").split(".").pop();
      const rest = args.slice(1).join(",");
      prefixByName[name] = { prefix: (rest.match(/prefix\s*=\s*['"]([^'"]*)['"]/) || [])[1] || "", flags: pyFlags(rest) };
    }
    for (const m of t.matchAll(/register_blueprint\(\s*(\w+)\s*(?:,([^)]*))?\)/g)) {
      const pre = ((m[2] || "").match(/url_prefix\s*=\s*['"]([^'"]*)['"]/) || [])[1];
      if (pre) prefixByName[m[1]] = { prefix: pre, flags: NONE };
    }
  }
  const settings = Object.values(texts).join("\n");
  const drfDefault = /DEFAULT_PERMISSION_CLASSES[\s\S]{0,120}IsAuthenticated/.test(settings);
  for (const f of files) {
    const t = texts[f], base = path.basename(f, ".py");
    const routerDecl = {};
    for (const m of t.matchAll(/(\w+)\s*=\s*(APIRouter|Blueprint)\s*\(/g)) {
      const b = balanced(t, m.index + m[0].length - 1); if (!b) continue;
      routerDecl[m[1]] = { prefix: (b.inner.match(/(?:prefix|url_prefix)\s*=\s*['"]([^'"]*)['"]/) || [])[1] || "", flags: pyFlags((b.inner.match(/dependencies\s*=\s*\[[\s\S]*\]/) || [""])[0]) };
    }
    const lines = t.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const dec = lines[i].match(/^\s*@(\w+)\.(get|post|put|patch|delete)\(\s*['"]([^'"]*)['"]([^)]*)\)?/) || lines[i].match(/^\s*@(\w+)\.route\(\s*['"]([^'"]*)['"](?:\s*,\s*methods\s*=\s*\[([^\]]*)\])?/);
      if (!dec) continue;
      const isRoute = lines[i].includes(".route(");
      const methods = isRoute ? (dec[3] ? dec[3].match(/[A-Za-z]+/g).map((x) => x.toUpperCase()) : ["GET"]) : [dec[2].toUpperCase()];
      const rpath = isRoute ? dec[2] : dec[3];
      const extra = isRoute ? "" : dec[4] || "";
      let j = i + 1, decorators = lines[i] + " " + extra;
      while (j < lines.length && /^\s*@/.test(lines[j])) decorators += " " + lines[j++];
      let sig = "";
      for (; j < lines.length; j++) { sig += lines[j] + " "; if (/\)\s*(->[^:]+)?:\s*$/.test(lines[j]) || /:\s*$/.test(lines[j])) break; }
      const body = lines.slice(j + 1, j + 60).join("\n");
      const decl = routerDecl[dec[1]] || { prefix: "", flags: NONE };
      const mount = prefixByName[base] || prefixByName[dec[1]] || { prefix: "", flags: NONE };
      const dFlags = classify(decorators.replace(/@\w+\.(get|post|put|patch|delete|route)/g, ""));
      const dep = (sig.match(/Depends\([^)]*\)|Security\([^)]*\)/g) || []).join(" ");
      const depFlags = pyFlags(dep + (/Security\(/.test(dep) ? " token" : ""));
      const pyAuth = /(login_required|jwt_required|auth_required|token_required|require_auth|requires_auth|verify_jwt|permission_required|fresh_jwt_required)/.test(decorators);
      const pyRole = /(roles?_required|admin_required|requires_role|role_required|permission_required)/.test(decorators);
      const typed = /:\s*(?!Request\b|Depends|Session\b|dict\b|Dict\b|str\b|int\b|bool\b|float\b)[A-Z]\w*/.test(sig.replace(/Depends\([^)]*\)/g, ""));
      for (const method of methods) {
        out.push({
          framework: svc.framework || "python", method, path: join(mount.prefix, join(decl.prefix, rpath)), file: f, line: i + 1,
          auth: pyAuth || depFlags.auth || decl.flags.auth || mount.flags.auth,
          roles: pyRole || depFlags.roles || decl.flags.roles || mount.flags.roles,
          validation: typed || /(validate|schema|marshmallow|pydantic|\.load\()/.test(body),
          rateLimit: /(limiter|rate_limit|throttle|@limit)/i.test(decorators), body
        });
      }
    }
    // Django REST Framework classes
    for (const m of t.matchAll(/^class\s+(\w+)\(([^)]*(?:APIView|ViewSet|GenericAPIView|ListAPIView|CreateAPIView|RetrieveAPIView|UpdateAPIView|DestroyAPIView|ModelViewSet)[^)]*)\):([\s\S]*?)(?=^class\s|(?![\s\S]))/gm)) {
      const cls = m[3].slice(0, 2500);
      const perm = (cls.match(/permission_classes\s*=\s*[\[(]([^\])]*)[\])]/) || [])[1];
      const open = perm !== undefined && /AllowAny/.test(perm);
      out.push({
        framework: "django", method: "CLASS", path: m[1], file: f, line: lineOf(t, m.index),
        auth: perm !== undefined ? !open && /(IsAuthenticated|IsAdminUser|DjangoModelPermissions|DjangoObjectPermissions|permissions\.)/.test(perm) : drfDefault,
        roles: perm !== undefined && /(IsAdminUser|DjangoModelPermissions|DjangoObjectPermissions|Is\w*(Owner|Admin|Staff)\w*)/.test(perm),
        validation: /serializer_class|Serializer/.test(cls), rateLimit: /throttle_classes/.test(cls), body: cls, mutating: /\b(def (post|put|patch|delete|create|update|destroy)|ModelViewSet|CreateAPIView|UpdateAPIView|DestroyAPIView)\b/.test(cls)
      });
    }
  }
  return out;
}


// ================= Next.js (App Router, Pages Router, server actions, middleware) =================
const NEXT_AUTH = /(\bauth\(|getServerSession|getToken\b|currentUser|getCurrentUser|getSession|requireAuth|withAuth|verifyToken|jwtVerify|jwt\.verify|supabase\.auth\.getUser|clerkClient|validateRequest|isAuthenticated|authenticate)/;
const NEXT_VALID = /(zod|\.parse\(|safeParse|yup|valibot|joi|validate|schema)/i;
const METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS";

function matcherToRegex(m) {
  const r = m.replace(/\(\.\*\)/g, "\u0001").replace(/[.^${}|[\]\\]/g, "\\$&")
    .replace(/\/:(\w+)\*/g, "(?:/.*)?").replace(/\/:(\w+)\+/g, "/.+").replace(/:(\w+)/g, "[^/]+").replace(/\u0001/g, ".*");
  return new RegExp("^" + r + "$");
}

// Does middleware.ts perform an auth check, and which paths does its matcher cover?
function nextMiddleware(root, texts) {
  const file = Object.keys(texts).find((f) => /^(src\/)?(middleware|proxy)\.(m?[jt]s)$/.test(f));
  if (!file) return { exists: false, covers: () => false, rate: false };
  const t = texts[file];
  const auth = NEXT_AUTH.test(t) || /(clerkMiddleware|authMiddleware|NextAuth\(|export\s*\{\s*default\s*\}\s*from\s*['"]next-auth\/middleware)/.test(t);
  const rate = RATE.test(t);
  const mm = t.match(/matcher\s*:\s*(\[[\s\S]*?\]|['"][^'"]+['"])/);
  const matchers = mm ? [...mm[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]) : [];
  const excluded = matchers.flatMap((m) => { const e = m.match(/\(\?!([^)]*)\)/); return e ? e[1].split("|").map((w) => w.replace(/[^\w-/]/g, "").replace(/^\//, "")).filter(Boolean) : []; });
  const negative = matchers.some((m) => m.includes("(?!"));
  const regs = matchers.filter((m) => !m.includes("(?!")).map(matcherToRegex);
  const covers = (p) => {
    if (!auth) return false;
    if (!matchers.length) return true;                                   // no matcher: runs for every request
    if (negative && !excluded.some((w) => p.replace(/^\//, "").startsWith(w))) return true;
    return regs.some((re) => re.test(p));
  };
  return { exists: true, file, auth, covers, rate };
}

const nextSegments = (dir) => dir.split("/").filter((x) => x && !/^\(.*\)$/.test(x) && !x.startsWith("@") && !x.startsWith("_"))
  .map((x) => x.replace(/^\[\[\.\.\.(\w+)\]\]$/, ":$1*").replace(/^\[\.\.\.(\w+)\]$/, ":$1*").replace(/^\[(\w+)\]$/, ":$1"));
const exportBody = (t, idx) => { const rest = t.slice(idx + 1, idx + 4000); const n = rest.search(/\n(?:export\s|'use server'|"use server")/); return n < 0 ? rest : rest.slice(0, n); };

function scanNext(cwd, svc) {
  const root = path.join(cwd, svc.dir);
  const files = walk(root).filter((f) => /\.(m?[jt]sx?)$/.test(f) && !/\.(test|spec)\.|(^|\/)(__tests__|tests?|e2e)\//.test(f));
  const texts = Object.fromEntries(files.map((f) => [f, read(path.join(root, f))]));
  const mw = nextMiddleware(root, texts);
  const out = [];
  const mk = (e) => ({ framework: "next", validation: false, roles: false, rateLimit: false, ...e });
  for (const f of files) {
    const t = texts[f];
    // ---- App Router route handlers
    const app = f.match(/(?:^|\/)app\/(?:(.*)\/)?route\.(?:m?[jt]s)$/);
    if (app) {
      const p = "/" + nextSegments(app[1] || "").join("/");
      const found = [];
      for (const m of t.matchAll(new RegExp(`export\\s+(?:async\\s+)?function\\s+(${METHODS})\\b|export\\s+const\\s+(${METHODS})\\b`, "g"))) found.push({ method: m[1] || m[2], body: exportBody(t, m.index), idx: m.index });
      for (const m of t.matchAll(/export\s*\{([^}]*)\}/g)) for (const x of m[1].matchAll(new RegExp(`as\\s+(${METHODS})\\b`, "g"))) found.push({ method: x[1], body: t, idx: m.index });
      for (const m of t.matchAll(/export\s+const\s*\{([^}]*)\}\s*=/g)) for (const x of m[1].matchAll(new RegExp(`\\b(${METHODS})\\b`, "g"))) found.push({ method: x[1], body: t, idx: m.index });
      for (const h of found) {
        if (h.method === "HEAD" || h.method === "OPTIONS") continue;
        out.push(mk({ method: h.method, path: p.replace(/\/+/g, "/"), file: f, line: lineOf(t, h.idx), auth: NEXT_AUTH.test(h.body) || mw.covers(p), roles: ROLES.test(h.body), validation: NEXT_VALID.test(h.body), rateLimit: RATE.test(h.body) || mw.rate, body: h.body }));
      }
    }
    // ---- Pages Router API routes
    const pg = f.match(/(?:^|\/)pages\/api\/(.*)\.(?:m?[jt]sx?)$/);
    if (pg) {
      const p = ("/api/" + nextSegments(pg[1]).join("/")).replace(/\/index$/, "").replace(/\/+/g, "/");
      const ms = [...new Set([...t.matchAll(new RegExp(`req\\.method\\s*[!=]==?\\s*['"](${METHODS})['"]|case\\s+['"](${METHODS})['"]`, "g"))].map((m) => m[1] || m[2]))];
      const flags = { auth: NEXT_AUTH.test(t) || mw.covers(p), roles: ROLES.test(t), validation: NEXT_VALID.test(t), rateLimit: RATE.test(t) || mw.rate, body: t };
      if (!ms.length) out.push(mk({ method: "ALL", path: p, file: f, line: 1, mutating: /req\.body/.test(t), ...flags }));
      for (const m of ms) out.push(mk({ method: m, path: p, file: f, line: 1, ...flags }));
    }
    // ---- Server actions: public POST endpoints that look like function calls
    if (/\.(m?[jt]sx?)$/.test(f) && !app) {
      const topLevel = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use server['"]/.test(t);
      const names = [];
      if (topLevel) for (const m of t.matchAll(/export\s+async\s+function\s+(\w+)\s*\(|export\s+const\s+(\w+)\s*=\s*async/g)) names.push({ name: m[1] || m[2], idx: m.index });
      for (const m of t.matchAll(/async\s+function\s+(\w+)\s*\([^)]*\)\s*\{\s*['"]use server['"]/g)) names.push({ name: m[1], idx: m.index });
      for (const a of names) {
        const body = exportBody(t, a.idx);
        out.push(mk({ method: "ACTION", path: `action:${path.basename(f).replace(/\.\w+$/, "")}.${a.name}`, file: f, line: lineOf(t, a.idx), mutating: true, auth: NEXT_AUTH.test(body), roles: ROLES.test(body), validation: NEXT_VALID.test(body), rateLimit: RATE.test(body), body }));
      }
    }
  }
  return { endpoints: out, middleware: mw, texts };
}

// Next.js specific mistakes that are not about a single endpoint.
function nextSmells(cwd, svc, texts, add, prefix) {
  const root = path.join(cwd, svc.dir);
  const publicOk = /(PUBLISHABLE|ANON|PUBLIC_KEY|SITE_KEY|CLIENT_ID|MAPS|ANALYTICS|POSTHOG|SENTRY_DSN)/i;
  const seen = new Set();
  const flagVar = (name, file, line) => {
    if (seen.has(name + file)) return; seen.add(name + file);
    if (/(SECRET|PRIVATE|PASSWORD|SERVICE_ROLE|JWT)/i.test(name) && !publicOk.test(name)) add("error", file, line, `${name} is exposed to every visitor (NEXT_PUBLIC_ variables are inlined into browser JavaScript): remove the prefix and read it on the server only`);
    else if (/(TOKEN|API_?KEY|KEY)/i.test(name) && !publicOk.test(name)) add("warn", file, line, `${name} is public in the browser bundle: make sure it is meant to be public`);
  };
  for (const ef of [".env", ".env.local", ".env.production", ".env.development"]) {
    const t = read(path.join(root, ef)); if (!t) continue;
    t.split("\n").forEach((l, i) => { const m = l.match(/^\s*(NEXT_PUBLIC_\w+)\s*=/); if (m) flagVar(m[1], prefix(ef), i + 1); });
  }
  for (const [f, t] of Object.entries(texts)) {
    for (const m of t.matchAll(/process\.env\.(NEXT_PUBLIC_\w+)/g)) flagVar(m[1], prefix(f), lineOf(t, m.index));
    const client = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(t);
    if (client) {
      for (const m of t.matchAll(/from\s+['"](@prisma\/client|mongoose|pg|mysql2|bcrypt|bcryptjs|jsonwebtoken|fs|node:fs|child_process|server-only)['"]|require\(['"](@prisma\/client|mongoose|pg|fs)['"]\)/g))
        add("error", prefix(f), lineOf(t, m.index), `server-only module "${m[1] || m[2]}" imported in a 'use client' component (it would be bundled for the browser or fail to build)`);
      for (const m of t.matchAll(/process\.env\.(?!NEXT_PUBLIC_|NODE_ENV)(\w+)/g)) add("warn", prefix(f), lineOf(t, m.index), `server env var ${m[1]} read in a client component: it is undefined in the browser`);
    }
    if (/\.(tsx|jsx)$/.test(f) && /dangerouslySetInnerHTML/.test(t) && !/(DOMPurify|sanitize|sanitizeHtml|xss\()/i.test(t))
      add("warn", prefix(f), lineOf(t, t.indexOf("dangerouslySetInnerHTML")), "dangerouslySetInnerHTML without a sanitizer (XSS risk)");
    for (const m of t.matchAll(/\bcookies\(\)\s*\.set\s*\(|\bcookies\s*\.set\s*\(|\.cookies\s*\.set\s*\(/g)) {
      const b = balanced(t, m.index + m[0].length - 1);
      if (b && /(token|session|jwt|auth)/i.test(b.inner.slice(0, 80)) && !/httpOnly\s*:\s*true/.test(b.inner)) add("warn", prefix(f), lineOf(t, m.index), "auth cookie set without httpOnly: true (readable by any script on the page)");
    }
  }
  const cfg = ["next.config.js", "next.config.mjs", "next.config.ts"].find((f) => fs.existsSync(path.join(root, f)));
  if (cfg && !/headers\s*\(/.test(read(path.join(root, cfg)))) add("info", prefix(cfg), 1, "no security headers configured in next.config (CSP, X-Frame-Options, Referrer-Policy)");
}

// ================= project-level checks + report =================
export function scanApi(cwd) {
  const services = findServices(cwd).filter(isServerSide);
  const endpoints = [], findings = [];
  const add = (level, file, line, msg) => findings.push({ level, file, line, msg });
  for (const svc of services) {
    let eps, nextInfo = null;
    if (svc.framework === "next") { nextInfo = scanNext(cwd, svc); eps = nextInfo.endpoints; }
    else eps = svc.lang === "python" ? scanPython(cwd, svc) : svc.lang === "node" ? scanExpress(cwd, svc) : [];
    const root = path.join(cwd, svc.dir);
    const prefix = (f) => path.join(svc.dir === "." ? "" : svc.dir, f);
    const projectHasAuth = eps.some((e) => e.auth) || /jsonwebtoken|passport|next-auth|@clerk|@auth\/|better-auth|lucia|supabase|"jose"|flask_jwt|flask_login|fastapi\.security|python-jose|pyjwt|djangorestframework-simplejwt/i.test(JSON.stringify(svc.deps) + read(path.join(root, "requirements.txt")) + read(path.join(root, "pyproject.toml")));
    if (eps.length && !projectHasAuth) add("warn", prefix(eps[0].file), eps[0].line, `no authentication found anywhere in ${svc.name}: all ${eps.length} endpoints are public`);
    for (const e of eps) {
      const mutating = e.mutating ?? MUTATING.has(e.method);
      const where = [prefix(e.file), e.line];
      const label = `${e.method} ${e.path}`;
      const isPublic = PUBLIC.test(e.path);
      if (!e.auth && !isPublic) {
        if (mutating) add(projectHasAuth ? "error" : "warn", ...where, `${label} changes data without authentication`);
        else add("warn", ...where, `${label} is readable without authentication`);
      }
      if (e.auth && !e.roles && /(^|\/)admin(\/|$)/i.test(e.path)) add("warn", ...where, `${label} is an admin route with no role/permission check`);
      if (AUTHISH.test(e.path) && mutating && !e.rateLimit) add("warn", ...where, `${label} has no rate limiting (brute-force risk)`);
      if (mutating && e.method !== "DELETE" && !e.validation && !/(^|\/)(logout|refresh)(\/|$)/i.test(e.path) && !/(validat|schema|safeParse|Joi|zod)/i.test(e.body || "")) add("warn", ...where, `${label} has no visible input validation`);
      if (e.auth && !e.roles && mutating && (e.method === "ACTION" ? /^[^\n{]*\(\s*[^)]*\b(id|\w+Id)\b/i.test(e.body || "") : /:\w+|\{\w+\}|<\w+>/.test(e.path)) && e.body && !/(req\.(user|auth)\b|userId|user\.id|user\._id|ownerId|createdBy|\.owner\b|current_user|request\.user|g\.user|session\??\.user|token\.(sub|id)|role|admin|permission)/i.test(e.body))
        add("warn", ...where, `${label} acts on a record by id with no visible ownership/role check (possible IDOR)`);
    }
    // global code smells
    for (const f of walk(root).filter((x) => /\.(m?[jt]s|cjs|py)$/.test(x) && !/(^|\/)(tests?|__tests__)\/|\.(test|spec)\./.test(x))) {
      const t = read(path.join(root, f));
      const chk = (re, level, msg) => { for (const m of t.matchAll(re)) add(level, prefix(f), lineOf(t, m.index), msg); };
      chk(/(JWT_SECRET|jwtSecret|SECRET_KEY|secret_key)\s*(?:\|\||\?\?|=|,)\s*(?:process\.env\.\w+\s*\|\|\s*)?['"][^'"$]{3,}['"]/g, "error", "hardcoded or fallback JWT/secret key");
      chk(/jwt\.sign\([^)]*,\s*['"][^'"]{3,}['"]/g, "error", "jwt.sign with a literal secret");
      chk(/jwt\.(encode)\([^)]*,\s*['"][^'"]{3,}['"]/g, "error", "jwt.encode with a literal secret");
      chk(/jwt\.verify\([^)]*,\s*['"][^'"]{3,}['"]/g, "error", "jwt.verify with a literal secret");
      chk(/jwt\.decode\([^)]*,\s*['"][^'"]{3,}['"]/g, "error", "jwt.decode with a literal secret");
      chk(/cors\(\s*\)|origin\s*:\s*['"]\*['"]|allow_origins\s*=\s*\[\s*['"]\*['"]/g, "warn", "CORS allows every origin");
      chk(/\bDEBUG\s*=\s*True|app\.run\([^)]*debug\s*=\s*True/g, "warn", "debug mode enabled");
      chk(/verify\s*=\s*False|rejectUnauthorized\s*:\s*false/g, "error", "TLS certificate verification disabled");
    }
    if (nextInfo) {
      nextSmells(cwd, svc, nextInfo.texts, add, prefix);
      if (!nextInfo.middleware.exists && eps.length && !eps.some((e) => e.auth)) add("warn", prefix("."), 1, "no middleware.ts and no endpoint checks auth: nothing protects these routes");
    }
    if (svc.lang === "node" && svc.framework !== "next" && eps.length && !svc.deps.helmet) add("warn", prefix("package.json"), 1, "helmet (security headers) is not installed");
    if (svc.lang === "node" && svc.framework !== "next" && eps.length && !svc.deps["express-rate-limit"] && !svc.deps["rate-limiter-flexible"] && !svc.deps["express-slow-down"]) add("info", prefix("package.json"), 1, "no rate-limiting library installed");
    endpoints.push(...eps.map((e) => ({ ...e, file: prefix(e.file), service: svc.dir, body: undefined })));
  }
  return { endpoints, findings };
}

export function renderApiMap({ endpoints, findings }) {
  const yn = (b) => (b ? "yes" : "NO");
  const rows = endpoints.map((e) => `| ${e.method} | \`${e.path}\` | ${yn(e.auth)} | ${yn(e.roles)} | ${yn(e.validation)} | ${yn(e.rateLimit)} | ${e.file}:${e.line} |`);
  return `# API Map (auto-generated by \`agentforge api\`)

Static analysis: it reads route definitions, router mounts, middleware, decorators and dependencies. Treat "NO" as "not visible to the scanner", then verify.

| Method | Path | Auth | Roles | Validation | Rate limit | Source |
|--------|------|------|-------|------------|------------|--------|
${rows.join("\n") || "| - | no endpoints found | | | | | |"}

## Findings

${findings.length ? findings.map((f) => `- **${f.level}** \`${f.file}:${f.line}\` ${f.msg}`).join("\n") : "None."}
`;
}
