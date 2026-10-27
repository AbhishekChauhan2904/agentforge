import fs from "node:fs";
import path from "node:path";

const API = ["express", "fastify", "@nestjs/core", "koa", "hono"];
const UI = ["react", "next", "vue", "svelte", "@angular/core", "vite"];
const SKIP = new Set(["node_modules", "dist", "build", "coverage", "venv", ".venv", "__pycache__", "android", "ios"]);
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const readPkg = (dir) => { try { return JSON.parse(read(path.join(dir, "package.json"))); } catch { return null; } };

function classifyNode(pkg) {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const has = (list) => list.some((d) => deps[d]);
  const api = has(API), ui = has(UI);
  const framework = deps.next ? "next" : deps["@nestjs/core"] ? "nest" : deps.express ? "express" : deps.fastify ? "fastify" : deps.koa ? "koa" : deps.hono ? "hono"
    : deps.react ? "react" : deps.vue ? "vue" : deps.svelte ? "svelte" : deps["@angular/core"] ? "angular" : null;
  return {
    lang: "node", framework,
    kind: api ? "api" : ui ? "frontend" : pkg.scripts?.start ? "worker" : "lib",
    deps,
    needs: [deps.mongoose || deps.mongodb ? "mongo" : null, deps.pg ? "postgres" : null, deps.mysql2 ? "mysql" : null,
      deps.redis || deps.ioredis || deps.bullmq || deps.bull ? "redis" : null, deps.amqplib ? "rabbitmq" : null, deps.kafkajs ? "kafka" : null].filter(Boolean),
    staticBuildDir: deps["react-scripts"] ? "build" : "dist"
  };
}

function detectPython(dir, rel, cwd) {
  const text = ["requirements.txt", "pyproject.toml", "Pipfile"].map((f) => read(path.join(dir, f)) || "").join("\n").toLowerCase();
  if (!text.trim()) return null;
  const framework = ["fastapi", "flask", "django"].find((f) => text.includes(f)) || null;
  const has = (...k) => k.some((x) => text.includes(x));
  const entry = ["main.py", "app.py", "manage.py", "wsgi.py"].some((f) => fs.existsSync(path.join(dir, f)));
  return {
    name: rel === "." ? path.basename(cwd) : path.basename(rel), dir: rel, scripts: {}, lang: "python", framework,
    kind: framework ? "api" : entry ? "worker" : "lib", deps: {}, staticBuildDir: "dist",
    needs: [has("pymongo", "motor", "mongoengine") ? "mongo" : null, has("psycopg", "asyncpg", "postgres") ? "postgres" : null, has("mysql") ? "mysql" : null,
      has("redis") ? "redis" : null, has("pika") ? "rabbitmq" : null, has("kafka") ? "kafka" : null].filter(Boolean)
  };
}

function detectFlutter(dir, rel, cwd) {
  const text = read(path.join(dir, "pubspec.yaml"));
  if (!text || !/^\s*flutter:/m.test(text)) return null;
  const name = (text.match(/^name:\s*(\S+)/m) || [])[1] || (rel === "." ? path.basename(cwd) : path.basename(rel));
  return { name, dir: rel, scripts: {}, lang: "flutter", kind: "mobile", deps: {}, needs: [], staticBuildDir: "build" };
}

// Find deployable units: root package, plus packages one level down and under services/apps/packages.
export function findServices(cwd) {
  const found = [];
  const add = (rel) => {
    const dir = path.join(cwd, rel);
    const pkg = readPkg(dir);
    const svc = pkg
      ? { name: pkg.name || (rel === "." ? path.basename(cwd) : path.basename(rel)), dir: rel, scripts: pkg.scripts || {}, main: pkg.main, ...classifyNode(pkg) }
      : detectPython(dir, rel, cwd) || detectFlutter(dir, rel, cwd);
    if (svc && svc.lang === "node") {
      svc.typescript = fs.existsSync(path.join(dir, "tsconfig.json")) || !!svc.deps.typescript;
      if (svc.framework === "next") {
        const has = (x) => fs.existsSync(path.join(dir, x));
        const app = has("app") || has("src/app"), pages = has("pages") || has("src/pages");
        svc.router = app && pages ? "both" : app ? "app" : "pages";
      }
    }
    if (svc) found.push(svc);
  };
  const subdirs = (rel) => { try { return fs.readdirSync(path.join(cwd, rel), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".") && !SKIP.has(d.name)).map((d) => path.join(rel === "." ? "" : rel, d.name)); } catch { return []; } };
  const nested = subdirs(".").flatMap((d) => (["services", "apps", "packages"].includes(d) ? subdirs(d) : [d]));
  for (const rel of nested) add(rel);
  if (found.length === 0) add(".");
  return found;
}

// Services that run server-side code (Next.js counts: route handlers, server actions, middleware).
export const isServerSide = (s) => s.kind === "api" || s.kind === "worker" || s.framework === "next";

export const isMicroservices = (services) => services.filter((s) => s.kind === "api" || s.kind === "worker").length > 1;
