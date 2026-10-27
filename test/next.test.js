import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { W, tmp, nextApp } from "./fixtures.js";
import { scanApi } from "../src/api.js";
import { scanDb } from "../src/dbcheck.js";
import { checkStructure } from "../src/structure.js";
import { buildGraph } from "../src/graph.js";
import { findServices } from "../src/services.js";
import { dockerInit, lintDocker } from "../src/docker.js";
import { generate } from "../src/generator.js";
import { loadConfig, validateConfig, normalizeLanguage } from "../src/config.js";
import { doctor, lintPrompts } from "../src/doctor.js";
import { runGate } from "../src/gate.js";
import { buildPipeline } from "../src/state.js";

const find = (r, re, level) => r.findings.filter((f) => re.test(f.msg) && (!level || f.level === level));
const ep = (r, m, p) => r.endpoints.find((e) => e.method === m && e.path === p);
const cli = new URL("../bin/cli.js", import.meta.url).pathname;
const run = (cwd, ...a) => spawnSync("node", [cli, ...a], { cwd, encoding: "utf8" });

test("detects Next.js, router type and TypeScript", () => {
  const [s] = findServices(nextApp());
  assert.equal(s.framework, "next"); assert.equal(s.router, "both"); assert.equal(s.typescript, true); assert.equal(s.kind, "frontend");
  assert.equal(findServices(nextApp({ ts: false }))[0].typescript, false);
});

test("next api: route handlers, dynamic segments, route groups, pages router, server actions", () => {
  const r = scanApi(nextApp());
  assert.ok(ep(r, "GET", "/api/tickets")); assert.ok(ep(r, "POST", "/api/tickets"));
  assert.ok(ep(r, "DELETE", "/api/tickets/:id")); assert.ok(ep(r, "PUT", "/api/tickets/:id"));
  assert.ok(ep(r, "DELETE", "/api/legacy/:id"));                              // pages/api, method found from req.method
  assert.ok(ep(r, "ACTION", "action:ticket.deleteTicket")); assert.ok(ep(r, "ACTION", "action:ticket.createTicket"));
  assert.equal(r.endpoints.some((e) => e.path.includes("shop")), false);       // page.tsx is not an endpoint, route groups are not URL segments
});

test("next api: auth detection from handler bodies and from the middleware matcher", () => {
  const r = scanApi(nextApp());
  assert.equal(ep(r, "GET", "/api/tickets").auth, false);
  assert.equal(ep(r, "POST", "/api/tickets").auth, true);
  assert.equal(ep(r, "POST", "/api/tickets").validation, true);               // zod .parse
  assert.equal(ep(r, "DELETE", "/api/tickets/:id").auth, false);
  assert.equal(ep(r, "GET", "/api/admin/users").auth, true);                  // covered by middleware matcher /api/admin/:path*, no check in the handler itself
  assert.equal(ep(r, "ACTION", "action:ticket.createTicket").auth, true);
  assert.equal(ep(r, "ACTION", "action:ticket.deleteTicket").auth, false);
});

test("next api: findings", () => {
  const r = scanApi(nextApp());
  assert.ok(find(r, /DELETE \/api\/tickets\/:id changes data without authentication/, "error").length);
  assert.ok(find(r, /DELETE \/api\/legacy\/:id changes data without authentication/, "error").length);
  assert.ok(find(r, /ACTION action:ticket\.deleteTicket changes data without authentication/, "error").length);
  assert.equal(find(r, /createTicket changes data without authentication/).length, 0);
  assert.ok(find(r, /GET \/api\/tickets is readable without authentication/, "warn").length);
  assert.equal(find(r, /PUT \/api\/tickets\/:id acts on a record by id.*IDOR/, "warn").length, 1);   // auth() is called but nothing ties the record to the user
  assert.equal(find(r, /createTicket acts on a record by id/).length, 0);             // "action:ticket.x" must not look like a :param route
  assert.ok(find(r, /GET \/api\/admin\/users is an admin route with no role/, "warn").length);
  assert.ok(find(r, /POST \/api\/auth\/login has no rate limiting/).length);
  assert.equal(find(r, /POST \/api\/auth\/login changes data without authentication/).length, 0);
  assert.equal(find(r, /helmet/).length, 0);                                    // helmet is an Express concern
  assert.equal(find(r, /nothing protects these routes/).length, 0);
});

test("next api: NEXT_PUBLIC secrets, server-only imports in client components, XSS, env in client", () => {
  const r = scanApi(nextApp());
  assert.ok(find(r, /NEXT_PUBLIC_API_SECRET is exposed to every visitor/, "error").length);
  assert.equal(find(r, /STRIPE_PUBLISHABLE_KEY/).length, 0);                    // publishable keys are meant to be public
  assert.ok(find(r, /server-only module "@prisma\/client" imported in a 'use client' component/, "error").length);
  assert.ok(find(r, /dangerouslySetInnerHTML without a sanitizer/, "warn").length);
  assert.ok(find(r, /server env var DB_PASSWORD read in a client component/, "warn").length);
  assert.equal(find(r, /no security headers configured/).length, 0);            // no next.config in the fixture
});

test("next api: auth cookie without httpOnly", () => {
  const d = nextApp();
  W(d, "src/app/api/session/route.ts", "import { cookies } from 'next/headers';\nexport async function POST() {\n  cookies().set('session_token', 'x', { path: '/' });\n  cookies().set('theme', 'dark');\n  cookies().set('auth', 'y', { httpOnly: true });\n  return Response.json({});\n}\n");
  assert.equal(find(scanApi(d), /auth cookie set without httpOnly/, "warn").length, 1);
});

test("middleware matcher with a negative lookahead covers everything except the listed paths", () => {
  const d = tmp();
  W(d, "package.json", JSON.stringify({ name: "n", dependencies: { next: "14", "next-auth": "4" } }));
  W(d, "app/layout.tsx", "export default () => null;\n");
  W(d, "app/api/private/route.ts", "export async function GET() { return Response.json({}); }\n");
  W(d, "app/api/webhook/route.ts", "export async function GET() { return Response.json({}); }\n");
  W(d, "middleware.ts", "import { getToken } from 'next-auth/jwt';\nexport function middleware(req) { return getToken({ req }); }\nexport const config = { matcher: ['/((?!api/webhook|_next/static|favicon.ico).*)'] };\n");
  const r = scanApi(d);
  assert.equal(ep(r, "GET", "/api/private").auth, true);
  assert.equal(ep(r, "GET", "/api/webhook").auth, false);
});

test("db: next route handlers and server actions are scanned; unvalidated request JSON is mass assignment", () => {
  const d = nextApp();
  W(d, "src/app/api/notes/route.ts", "export async function POST(req) {\n  const body = await req.json();\n  return Response.json(await prisma.note.create({ data: body }));\n}\n");
  W(d, "src/app/api/safe/route.ts", "export async function POST(req) {\n  const body = schema.parse(await req.json());\n  return Response.json(await prisma.note.create({ data: body }));\n}\n");
  const r = scanDb(d);
  const hits = find(r, /request JSON written to the database without validation/, "warn");
  assert.equal(hits.length, 1); assert.match(hits[0].file, /notes\/route\.ts$/);
});

test("graph: tsconfig path aliases (@/) become edges, with JSONC comments and trailing commas", () => {
  const g = buildGraph(nextApp());
  const names = Object.keys(g.modules[0].nodes);
  for (const n of ["app/api", "lib", "components", "actions"]) assert.ok(names.includes(n), n);
  assert.ok(g.modules[0].edges.some((e) => e.from === "app/api" && e.to === "lib"));
  assert.ok(g.modules[0].edges.some((e) => e.from === "lib" && e.to === "components"));
  assert.match(g.system.mermaid, /\(next\)/);
});

test("structure: next rules (lib imports components, missing layout) and TypeScript hygiene", () => {
  const d = nextApp();
  W(d, "src/lib/many.ts", Array.from({ length: 12 }, (_, i) => `export const v${i}: any = ${i};`).join("\n") + "\n// @ts-ignore\nconst z = 1;\n");
  W(d, "src/legacy.js", "module.exports = {};\n");
  const r = checkStructure(d);
  assert.ok(find(r, /lib imports UI code \(components\)/, "warn").length);
  assert.ok(find(r, /tsconfig "strict" is not true/, "warn").length);
  assert.ok(find(r, /12 uses of 'any'/, "warn").length);
  assert.ok(find(r, /1 @ts-ignore/, "warn").length);
  assert.ok(find(r, /1 JavaScript file\(s\) in a TypeScript project/, "info").length);
  fs.rmSync(path.join(d, "src/app/layout.tsx"));
  assert.ok(find(checkStructure(d), /no root layout/, "error").length);
  assert.match(checkStructure(d).services[0].recommended, /Client components never import server modules/);
});

test("structure: a route handler importing another route handler is an error", () => {
  const d = nextApp();
  W(d, "src/lib/x.ts", "import '@/app/api/tickets/route';\n");
  assert.ok(find(checkStructure(d), /imports a route handler \(app\/api\) directly/, "error").length);
});

test("docker init for Next.js: standalone Dockerfile, port 3000, warns when output is not standalone, lints clean", () => {
  const d = nextApp();
  const r = dockerInit(d);
  assert.ok(r.created.includes("Dockerfile"));
  const df = fs.readFileSync(path.join(d, "Dockerfile"), "utf8");
  assert.match(df, /\.next\/standalone/); assert.match(df, /USER node/); assert.match(df, /CMD \["node", "server\.js"\]/); assert.match(df, /mkdir -p public/);
  assert.match(fs.readFileSync(path.join(d, "docker-compose.yml"), "utf8"), /"3000:3000"/);
  assert.ok(r.notes.some((n) => /output: "standalone"/.test(n)));
  assert.deepEqual(lintDocker(d).findings, []);
  W(d, "next.config.js", "module.exports = { output: 'standalone' };\n");
  assert.equal(dockerInit(d, { force: true }).notes.length, 0);
});

test("language option: stored in config, written into the right agents, switchable", () => {
  const d = nextApp({ ts: false });
  const a = generate({ tool: "cursor", workflow: "full", specialists: ["nextjs", "backend", "frontend"], language: "javascript" }, d);
  assert.equal(a.language, "javascript");
  assert.equal(loadConfig(d).language, "javascript");
  const body = (n) => fs.readFileSync(path.join(d, `.cursor/rules/${n}.mdc`), "utf8");
  for (const n of ["nextjs", "backend", "frontend", "reviewer"]) assert.match(body(n), /## Language: JavaScript/, n);
  assert.doesNotMatch(body("qa"), /## Language:/); assert.doesNotMatch(body("planner"), /## Language:/);
  assert.match(fs.readFileSync(path.join(d, ".ai/project-context.md"), "utf8"), /\| Language mode \| JavaScript \|/);
  const sw = run(d, "language", "ts");
  assert.equal(sw.status, 0, sw.stderr);
  assert.equal(loadConfig(d).language, "typescript");
  assert.match(body("nextjs"), /## Language: TypeScript/); assert.doesNotMatch(body("nextjs"), /## Language: JavaScript/);
  assert.match(run(d, "language").stdout, /configured: typescript/);
  assert.notEqual(run(d, "language", "cobol").status, 0);
});

test("language is auto-detected, can be forced by flag, and is validated", () => {
  assert.equal(generate({ tool: "opencode", workflow: "standard" }, nextApp()).language, "typescript");
  assert.equal(generate({ tool: "opencode", workflow: "standard" }, nextApp({ ts: false })).language, "javascript");
  const py = tmp(); W(py, "requirements.txt", "fastapi\n"); W(py, "main.py", "");
  assert.equal(generate({ tool: "opencode", workflow: "standard" }, py).language, null);
  const d = nextApp(); const r = run(d, "init", "--yes", "--tool", "cursor", "--workflow", "standard", "--agents", "nextjs", "--language", "js");
  assert.equal(r.status, 0, r.stderr); assert.equal(loadConfig(d).language, "javascript");
  assert.notEqual(run(nextApp(), "init", "--yes", "--language", "rust").status, 0);
  assert.deepEqual([normalizeLanguage("TS"), normalizeLanguage("js"), normalizeLanguage("x")], ["typescript", "javascript", null]);
  assert.match(validateConfig({ tool: "cursor", workflow: "full", agents: [], gate: [], language: "perl" }).join(), /language/);
});

test("doctor: TypeScript config without a type check, and language mismatch", () => {
  const d = nextApp(); generate({ tool: "cursor", workflow: "standard", language: "typescript" }, d);
  assert.ok(loadConfig(d).gate.some((g) => /tsc/.test(g.cmd)), "init adds a type check for TypeScript projects");
  assert.match(doctor(d).map((c) => c.msg).join("\n"), /TypeScript project \(tsconfig found\)/);
  assert.doesNotMatch(doctor(d).map((c) => c.msg).join("\n"), /no type-check command/);
  const cfg = loadConfig(d); cfg.gate = cfg.gate.filter((g) => !/tsc/.test(g.cmd));
  fs.writeFileSync(path.join(d, ".ai/config.json"), JSON.stringify(cfg));
  assert.match(doctor(d).map((c) => c.msg).join("\n"), /no type-check command in the gate/);
  cfg.language = "javascript"; fs.writeFileSync(path.join(d, ".ai/config.json"), JSON.stringify(cfg));
  assert.match(doctor(d).map((c) => c.msg).join("\n"), /config says JavaScript but the project has a tsconfig/);
});

test("init on a Next.js app enables the gate checks and the gate blocks on Next findings", () => {
  const d = nextApp();
  generate({ tool: "cursor", workflow: "full", specialists: ["nextjs"] }, d);
  const cfg = loadConfig(d);
  assert.equal(cfg.apiCheck, true); assert.equal(cfg.dbCheck, true); assert.equal(cfg.structureCheck, true);
  const g = runGate(d);
  assert.equal(g.results.find((x) => x.name === "API Security").status, "FAIL");
  assert.equal(g.passed, false);
  assert.ok(fs.existsSync(path.join(d, ".cursor/rules/nextjs.mdc")));
});

test("nextjs agent: pipeline order and prompt lint", () => {
  assert.deepEqual(lintPrompts(), []);
  assert.deepEqual(buildPipeline({ workflow: "full", agents: ["orchestrator", "planner", "qa", "security", "reviewer", "docs", "git", "backend", "nextjs", "docker"] }),
    ["planner", "backend", "nextjs", "docker", "qa", "security", "reviewer", "gate", "docs", "git"]);
});

test("server actions: by-id actions need an ownership check; next.config without headers() is noted", () => {
  const d = nextApp();
  W(d, "src/actions/notes.ts", `'use server';
import { auth } from '@/lib/auth';
export async function updateNote(id, data) { const s = await auth(); return db.note.update({ where: { id }, data }); }
export async function renameNote(id, title) { const s = await auth(); return db.note.update({ where: { id, ownerId: s.user.id }, data: { title } }); }
`);
  const r = scanApi(d);
  assert.equal(find(r, /updateNote acts on a record by id/, "warn").length, 1);
  assert.equal(find(r, /renameNote acts on a record by id/).length, 0);
  W(d, "next.config.js", "module.exports = { reactStrictMode: true };\n");
  assert.equal(find(scanApi(d), /no security headers configured/, "info").length, 1);
  W(d, "next.config.js", "module.exports = { async headers() { return []; } };\n");
  assert.equal(find(scanApi(d), /no security headers configured/).length, 0);
});
