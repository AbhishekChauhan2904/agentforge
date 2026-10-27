import fs from "node:fs";
import path from "node:path";
import { findServices } from "./services.js";

const SECRET_NAME = /(secret|password|passwd|token|api[_-]?key|private[_-]?key|access[_-]?key)/i;

function pythonDockerfile(svc) {
  const cmd = svc.framework === "fastapi" ? ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
    : svc.framework === "django" ? ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000"] : ["gunicorn", "app:app", "--bind", "0.0.0.0:8000"];
  return `# syntax=docker/dockerfile:1
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN useradd --create-home appuser
USER appuser
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')" || exit 1
# Adjust the module path below to your app (and add gunicorn/uvicorn to requirements.txt)
CMD ${JSON.stringify(cmd)}
`;
}

function nextDockerfile() {
  return `# syntax=docker/dockerfile:1
# Requires \`output: "standalone"\` in next.config.js (agentforge docker init warns if it is missing)
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p public
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s CMD wget -qO- http://127.0.0.1:3000/ || exit 1
CMD ["node", "server.js"]
`;
}

function dockerfileFor(svc) {
  if (svc.lang === "python") return pythonDockerfile(svc);
  if (svc.framework === "next") return nextDockerfile();
  if (svc.kind === "frontend" && !svc.deps.express) {
    return `# syntax=docker/dockerfile:1
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=build /app/${svc.staticBuildDir} /usr/share/nginx/html
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/ || exit 1
`;
  }
  const start = svc.scripts.start ? "npm start" : `node ${svc.main || "index.js"}`;
  return `# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ${JSON.stringify(start.split(" "))}
`;
}

const DOCKERIGNORE = `node_modules
.next
__pycache__
.venv
npm-debug.log
.git
.gitignore
.env
.env.*
.ai
.cursor
.opencode
.gemini
GEMINI.md
Dockerfile
docker-compose*.yml
coverage
dist
build
`;

function composeFor(services) {
  const lines = ["services:"];
  const infra = new Set();
  const defs = {
    mongo: ["    image: mongo:7", "    volumes:", "      - mongo-data:/data/db", "    restart: unless-stopped"],
    postgres: ["    image: postgres:16-alpine", "    environment:", "      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}", "    volumes:", "      - pg-data:/var/lib/postgresql/data", "    restart: unless-stopped"],
    redis: ["    image: redis:7-alpine", "    restart: unless-stopped"],
    rabbitmq: ["    image: rabbitmq:3-management-alpine", "    restart: unless-stopped"]
  };

  let port = 3000;
  for (const s of services) {
    const name = s.name.replace(/[^a-z0-9-]/gi, "-").replace(/^@?[^/]*\//, "").toLowerCase() || "app";
    const front = s.kind === "frontend" && !s.deps.express && s.framework !== "next";
    lines.push(`  ${name}:`, `    build: ./${s.dir === "." ? "" : s.dir}`.replace(/\.\/$/, "."), `    ports:`, `      - "${front ? 8080 : port++}:${front ? 8080 : s.lang === "python" ? 8000 : 3000}"`);
    if (!front) lines.push(`    env_file:`, `      - ./${s.dir === "." ? "" : s.dir + "/"}.env`);
    const known = s.needs.filter((n) => defs[n]);
    if (known.length) { lines.push(`    depends_on:`); known.forEach((n) => { lines.push(`      - ${n}`); infra.add(n); }); }
    lines.push(`    restart: unless-stopped`);
  }
  for (const i of infra) lines.push(`  ${i}:`, ...defs[i]);
  const vols = [infra.has("mongo") && "  mongo-data:", infra.has("postgres") && "  pg-data:"].filter(Boolean);
  if (vols.length) lines.push("volumes:", ...vols);
  return lines.join("\n") + "\n";
}

export function dockerInit(cwd, { force = false } = {}) {
  const services = findServices(cwd).filter((s) => s.kind !== "lib" && s.kind !== "mobile");
  if (!services.length) throw new Error("No deployable Node service found (no package.json with an API, frontend or start script).");
  const created = [], skipped = [], notes = [];
  const put = (rel, content) => {
    const f = path.join(cwd, rel);
    if (fs.existsSync(f) && !force) return skipped.push(rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
    created.push(rel);
  };
  for (const s of services) {
    put(path.join(s.dir, "Dockerfile"), dockerfileFor(s));
    put(path.join(s.dir, ".dockerignore"), DOCKERIGNORE);
  }
  put("docker-compose.yml", composeFor(services));
  for (const sv of services.filter((x) => x.framework === "next")) {
    const cfg = ["next.config.js", "next.config.mjs", "next.config.ts"].map((f) => path.join(cwd, sv.dir, f)).find((f) => fs.existsSync(f));
    if (!cfg || !/output\s*:\s*['"]standalone['"]/.test(fs.readFileSync(cfg, "utf8")))
      notes.push(`${sv.dir === "." ? "" : sv.dir + "/"}next.config needs  output: "standalone"  for the generated Dockerfile to work (add it, then docker build).`);
  }
  return { services, created, skipped, notes };
}

// Static best-practice lint. Needs no Docker daemon. level "error" blocks the quality gate.
export function lintDocker(cwd) {
  const findings = [];
  const add = (level, file, line, msg) => findings.push({ level, file, line, msg });
  const files = [];
  const walk = (rel, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(path.join(cwd, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIPDIR.has(e.name)) continue;
      const r = path.join(rel, e.name);
      if (e.isDirectory()) { if (depth < 3) walk(r, depth + 1); }
      else if (/^Dockerfile(\..+)?$/.test(e.name) || /^(docker-)?compose(\..+)?\.ya?ml$/.test(e.name)) files.push(r);
    }
  };
  walk("", 0);

  for (const rel of files) {
    const lines = fs.readFileSync(path.join(cwd, rel), "utf8").split("\n");
    if (path.basename(rel).startsWith("Dockerfile")) {
      const text = lines.join("\n");
      const aliases = new Set();
      lines.forEach((raw, i) => {
        const m = raw.trim().match(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i);
        if (!m) return;
        const img = m[1];
        if (m[2]) aliases.add(m[2].toLowerCase());
        if (img === "scratch" || img.startsWith("$") || aliases.has(img.toLowerCase()) || img.includes("@")) return;
        const tag = img.includes(":") ? img.split(":").pop() : null;
        if (!tag || tag === "latest") add("warn", rel, i + 1, `unpinned base image "${img}": pin a version tag`);
      });
      if (!/^USER\s+(?!root\b)/im.test(text)) add("warn", rel, 1, "no non-root USER: container runs as root");
      if (!/^HEALTHCHECK/im.test(text)) add("warn", rel, 1, "no HEALTHCHECK");
      lines.forEach((raw, i) => {
        const l = raw.trim(), n = i + 1;
        const kv = l.match(/^(ENV|ARG)\s+([A-Za-z0-9_]+)(?:=|\s+)(\S+)/i);
        if (kv && SECRET_NAME.test(kv[2]) && kv[3] && !/^\$|^["']?\$/.test(kv[3])) add("error", rel, n, `${kv[1]} ${kv[2]} has a hardcoded secret value (baked into image history)`);
        if (/^(COPY|ADD)\s+.*\.env\b/i.test(l)) add("error", rel, n, "copies a .env file into the image");
        if (/npm\s+install\b/.test(l) && !/npm\s+install\s+-g/.test(l)) add("warn", rel, n, "use `npm ci` for reproducible builds");
        if (/(curl|wget)[^|]*\|\s*(sh|bash)/.test(l)) add("warn", rel, n, "pipes a download into a shell");
        if (/^COPY\s+\.\s+\./i.test(l) && !fs.existsSync(path.join(cwd, path.dirname(rel), ".dockerignore"))) add("warn", rel, n, "COPY . . without a .dockerignore (copies node_modules, .env, .git)");
      });
    } else {
      lines.forEach((raw, i) => {
        const l = raw.trim(), n = i + 1;
        if (/^image:\s*\S+:latest\s*$/.test(l)) add("warn", rel, n, "image uses :latest");
        if (/^privileged:\s*true/.test(l)) add("warn", rel, n, "privileged container");
        if (/^network_mode:\s*["']?host/.test(l)) add("warn", rel, n, "host networking");
        const env = l.match(/^-?\s*([A-Za-z0-9_]+)\s*[:=]\s*["']?([^"'\s$][^"'\s]*)["']?\s*$/);
        if (env && SECRET_NAME.test(env[1]) && !/^(true|false)$/i.test(env[2])) add("warn", rel, n, `${env[1]} has a literal value: use \${VAR} or an env_file`);
      });
    }
  }
  return { files, findings };
}
const SKIPDIR = new Set(["node_modules", "dist", "build", "coverage"]);
