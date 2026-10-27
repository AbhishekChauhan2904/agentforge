import fs from "node:fs";
import path from "node:path";
import { findServices } from "./services.js";
import { moduleGraph, readJsonc } from "./graph.js";

const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const SKIP = new Set(["node_modules", "dist", "build", "coverage", ".git", ".ai", "venv", ".venv", "__pycache__", ".dart_tool", "android", "ios", "web", "linux", "macos", "windows"]);
function walk(root, rel = "", out = [], d = 0) {
  let es = []; try { es = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
    const r = path.join(rel, e.name);
    if (e.isDirectory()) { if (d < 8) walk(root, r, out, d + 1); } else out.push(r);
  }
  return out;
}

// Layer ranks: a lower layer must never import a higher one.
const WEB_LAYERS = { routes: 1, router: 1, routers: 1, api: 1, views: 1, controllers: 2, handlers: 2, services: 3, service: 3, repositories: 4, repository: 4, models: 5, model: 5, entities: 5, schemas: 5 };
const MAX_LINES = 400;

export const RECOMMENDED = {
  next: "app/ (routes + layouts; route.ts handlers stay thin) · components/ (UI) · lib/ (db client, auth config, helpers) · actions/ or services/ (server actions and business logic, with 'server-only') · validations/ (zod schemas) · middleware.ts (auth redirects, rate limiting). Client components never import server modules; lower layers never import components.",
  express: "routes/ (URL + middleware wiring only) -> controllers/ (HTTP in/out) -> services/ (business logic) -> models/ (data). Shared: middleware/ (auth, validate, error handler, rate limit), config/, utils/. Never import upward.",
  python: "routers|routes/ -> services/ -> models|schemas/. Shared: dependencies|middleware/ (auth), core|config/. Pydantic schemas separate from DB models.",
  flutter: "lib/{core, data (api, models, repositories), domain (optional), features/<name>/{presentation, state}, main.dart}. One state-management approach. Tokens in flutter_secure_storage."
};

function webStructure(cwd, svc, add) {
  const pre = (f) => path.join(svc.dir === "." ? "" : svc.dir, f);
  const g = moduleGraph(cwd, svc);
  const names = Object.keys(g.nodes);
  const has = (...k) => names.some((n) => k.includes(n));
  const isApi = svc.kind === "api";
  if (isApi && has("routes", "router", "routers") && !has("controllers", "handlers", "services") && g.nodes[names.find((n) => /routes?|routers?/.test(n))] > 0)
    add("warn", pre(""), 1, `${svc.name}: routes exist but there is no controllers/ or services/ layer: business logic is probably inside route files`);
  if (isApi && !has("middleware", "middlewares", "dependencies") && names.length > 2) add("info", pre(""), 1, `${svc.name}: no middleware/ (or dependencies/) folder: where do auth, validation and error handling live?`);
  for (const e of g.edges) {
    const a = WEB_LAYERS[e.from], b = WEB_LAYERS[e.to];
    if (a && b && a > b) add(b === 1 || a === 5 ? "error" : "warn", pre(e.from), 1, `layer violation: ${e.from} imports ${e.to} (${e.n} time${e.n > 1 ? "s" : ""}); dependencies must point down (routes -> controllers -> services -> models)`);
    if (a === 1 && b === 5) add("warn", pre(e.from), 1, `${e.from} imports ${e.to} directly, bypassing controllers/services`);
  }
  for (const c of g.cycles) add("error", pre(c[0]), 1, `circular dependency between ${c.join(", ")}`);
  const ext = svc.lang === "python" ? /\.py$/ : /\.(m?[jt]sx?|cjs)$/;
  for (const f of walk(path.join(cwd, svc.dir)).filter((x) => ext.test(x) && !/\.(test|spec)\.|(^|\/)(tests?|__tests__)\//.test(x))) {
    const n = read(path.join(cwd, svc.dir, f)).split("\n").length;
    if (n > MAX_LINES) add("warn", pre(f), 1, `${n} lines: split this file (limit ${MAX_LINES})`);
  }
  return { groups: g.nodes };
}

const isUi = (g) => g === "components" || g === "hooks" || g === "app" || g === "pages" || /^(app|pages)\/(?!api$)/.test(g);

function nextStructure(cwd, svc, add) {
  const root = path.join(cwd, svc.dir), pre = (f) => path.join(svc.dir === "." ? "" : svc.dir, f);
  const has = (f) => fs.existsSync(path.join(root, f));
  const g = moduleGraph(cwd, svc);
  if (svc.router === "both") add("info", pre(""), 1, "both app/ and pages/ routers are in use: migrate to one when practical");
  const appDir = has("src/app") ? "src/app" : has("app") ? "app" : null;
  if (appDir && !["layout.tsx", "layout.jsx", "layout.js", "layout.ts"].some((l) => has(path.join(appDir, l)))) add("error", pre(appDir), 1, "app/ has no root layout (layout.tsx): Next.js requires one");
  for (const e of g.edges) {
    if (/^(app|pages)\/api$/.test(e.to)) add("error", pre(e.from), 1, `${e.from} imports a route handler (${e.to}) directly: share logic through lib/ or services/ instead`);
    if (/^(lib|services|server|db|actions|utils|validations)$/.test(e.from) && isUi(e.to)) add("warn", pre(e.from), 1, `${e.from} imports UI code (${e.to}): lower layers must not depend on components or pages`);
  }
  for (const c of g.cycles) add("error", pre(c[0]), 1, `circular dependency between ${c.join(", ")}`);
  for (const f of walk(root).filter((x) => /\.(m?[jt]sx?)$/.test(x) && !/\.(test|spec)\.|(^|\/)(tests?|__tests__)\//.test(x))) {
    const n = read(path.join(root, f)).split("\n").length;
    if (n > MAX_LINES) add("warn", pre(f), 1, `${n} lines: split this file (limit ${MAX_LINES})`);
  }
  return { groups: g.nodes };
}

// TypeScript hygiene: strict mode, any, ts-ignore, leftover JavaScript.
function tsChecks(cwd, svc, add) {
  const root = path.join(cwd, svc.dir), pre = (f) => path.join(svc.dir === "." ? "" : svc.dir, f);
  const cfg = read(path.join(root, "tsconfig.json"));
  if (cfg) { let co = {}; try { co = readJsonc(cfg).compilerOptions || {}; } catch { /* unreadable tsconfig */ } if (co.strict !== true) add("warn", pre("tsconfig.json"), 1, 'tsconfig "strict" is not true: nullability and implicit-any mistakes go unchecked'); }
  const all = walk(root);
  const ts = all.filter((f) => /\.(ts|tsx|mts|cts)$/.test(f) && !/\.d\.ts$/.test(f) && !/\.(test|spec)\.|(^|\/)(tests?|__tests__|e2e)\//.test(f));
  let anyCount = 0, ignores = 0; const per = {};
  for (const f of ts) {
    const t = read(path.join(root, f));
    const a = (t.match(/:\s*any\b|\bas\s+any\b|<any>/g) || []).length;
    if (a) { anyCount += a; per[f] = a; }
    ignores += (t.match(/@ts-(ignore|nocheck)/g) || []).length;
  }
  if (ignores) add("warn", pre("."), 1, `${ignores} @ts-ignore/@ts-nocheck comment(s): fix the type, or use @ts-expect-error with a reason`);
  if (anyCount > 10) add("warn", pre("."), 1, `${anyCount} uses of 'any' (most in ${Object.entries(per).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f, n]) => `${f}: ${n}`).join(", ")}): prefer unknown + narrowing or real types`);
  const js = all.filter((f) => /\.(m?jsx?|cjs)$/.test(f) && !/(^|\/)[^/]*\.config\.[^/]*$/.test(f) && !/^(public|scripts)\//.test(f) && !/(^|\/)(tests?|__tests__)\//.test(f));
  if (ts.length && js.length) add("info", pre("."), 1, `${js.length} JavaScript file(s) in a TypeScript project (${js.slice(0, 2).join(", ")}${js.length > 2 ? ", ..." : ""})`);
}

function flutterStructure(cwd, svc, add) {
  const root = path.join(cwd, svc.dir), pre = (f) => path.join(svc.dir === "." ? "" : svc.dir, f);
  const pub = read(path.join(root, "pubspec.yaml"));
  const sm = [["flutter_bloc", "BLoC"], ["provider", "Provider"], ["riverpod", "Riverpod"], [/^\s*get:/m, "GetX"], ["mobx", "MobX"], ["redux", "Redux"]].filter(([k]) => (k instanceof RegExp ? k.test(pub) : pub.includes(k))).map(([, n]) => n);
  if (!sm.length) add("warn", pre("pubspec.yaml"), 1, "no state-management package (Provider, Riverpod, BLoC, ...): state will end up inside widgets");
  if (sm.length > 1) add("warn", pre("pubspec.yaml"), 1, `several state-management approaches (${sm.join(", ")}): pick one`);
  const libFiles = walk(root, "lib").filter((f) => f.endsWith(".dart"));
  const top = libFiles.filter((f) => path.dirname(f) === "lib");
  if (top.length > 8) add("warn", pre("lib"), 1, `${top.length} Dart files directly in lib/: group them (core/, data/, features/<name>/)`);
  const dirs = new Set(libFiles.map((f) => f.split(path.sep)[1]).filter((x) => x && !x.endsWith(".dart")));
  if (libFiles.length > 12 && !["features", "presentation", "screens", "pages", "ui"].some((d) => dirs.has(d))) add("warn", pre("lib"), 1, "no features/ or presentation/ (screens/pages) folder");
  if (libFiles.length > 12 && !["data", "services", "repositories", "api", "models"].some((d) => dirs.has(d))) add("warn", pre("lib"), 1, "no data/ or services/ layer: API calls are probably inside widgets");
  const g = moduleGraph(cwd, svc);
  for (const c of g.cycles) add("warn", pre("lib"), 1, `circular dependency between ${c.join(", ")}`);
  for (const f of libFiles) {
    const t = read(path.join(root, f)), full = pre(f);
    const chk = (re, level, msg) => { for (const m of t.matchAll(re)) add(level, full, t.slice(0, m.index).split("\n").length, msg); };
    const layer = f.split(path.sep).slice(1).join("/");
    if (/^(data|domain|core|models|services|repositories)\//.test(layer) || /^features\/[^/]+\/(data|domain)\//.test(layer))
      chk(/^\s*import\s+['"][^'"]*(?:^|\/)(presentation|ui|screens|pages|widgets|views)\/[^'"]*['"]/gm, "error", "layer violation: data/domain code imports UI code (data must not depend on presentation)");
    chk(/SharedPreferences[\s\S]{0,200}?set(String|StringList)\(\s*['"][^'"]*(token|jwt|password|secret|auth)[^'"]*['"]/gi, "error", "auth token/secret stored in SharedPreferences (plain text): use flutter_secure_storage");
    chk(/\bset(String)\(\s*['"](access_?token|refresh_?token|jwt|auth_?token|password)['"]/gi, "warn", "token written with setString: make sure it goes to secure storage");
    chk(/['"]http:\/\/(?!localhost|127\.0\.0\.1|10\.0\.2\.2)[^'"]+['"]/g, "warn", "cleartext http:// URL: use https");
    chk(/badCertificateCallback\s*=\s*\([^)]*\)\s*=>\s*true/g, "error", "TLS certificate check disabled (badCertificateCallback returns true)");
    chk(/(api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-/+=]{16,}['"]/gi, "error", "hardcoded key/secret in app code (anyone can extract it from the APK)");
    chk(/\bprint\(\s*['"][^'"]*(token|password|secret)/gi, "warn", "sensitive value printed to the log");
    if (t.split("\n").length > MAX_LINES) add("warn", full, 1, `${t.split("\n").length} lines: split this widget/file (limit ${MAX_LINES})`);
  }
  return { groups: g.nodes, stateManagement: sm };
}

export function checkStructure(cwd) {
  const findings = [], services = [];
  for (const svc of findServices(cwd)) {
    if (svc.kind === "lib") continue;
    const add = (level, file, line, msg) => findings.push({ level, file, line, msg });
    const r = svc.lang === "flutter" ? flutterStructure(cwd, svc, add) : svc.framework === "next" ? nextStructure(cwd, svc, add) : svc.kind === "frontend" ? { groups: moduleGraph(cwd, svc).nodes } : webStructure(cwd, svc, add);
    if (svc.lang === "node" && svc.typescript) tsChecks(cwd, svc, add);
    services.push({ name: svc.name, dir: svc.dir, lang: svc.lang, kind: svc.kind, framework: svc.framework, ...r,
      recommended: svc.framework === "next" ? RECOMMENDED.next : svc.lang === "flutter" ? RECOMMENDED.flutter : svc.lang === "python" ? RECOMMENDED.python : RECOMMENDED.express });
  }
  return { services, findings };
}

export function renderStructure({ services, findings }) {
  return `# Code Structure (auto-generated by \`agentforge structure\`)

${services.map((s) => `## ${s.name} (${s.dir}, ${s.framework || s.lang} ${s.kind})

Folders found: ${Object.entries(s.groups || {}).map(([g, n]) => `\`${g}\` (${n})`).join(", ") || "none"}${s.stateManagement ? `\n\nState management: ${s.stateManagement.join(", ") || "none"}` : ""}

Recommended: ${s.recommended}
`).join("\n")}
## Findings

${findings.length ? findings.map((f) => `- **${f.level}** \`${f.file}:${f.line}\` ${f.msg}`).join("\n") : "None."}
`;
}
