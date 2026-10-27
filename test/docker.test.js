import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findServices, isMicroservices } from "../src/services.js";
import { dockerInit, lintDocker } from "../src/docker.js";
import { generate } from "../src/generator.js";
import { runGate } from "../src/gate.js";
import { buildPipeline } from "../src/state.js";
import { lintPrompts } from "../src/doctor.js";

const W = (d, f, c) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); };
function mern() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "afd-"));
  W(d, "server/package.json", JSON.stringify({ name: "server", main: "src/app.js", scripts: { start: "node src/app.js" }, dependencies: { express: "4", mongoose: "7", ioredis: "5" } }));
  W(d, "client/package.json", JSON.stringify({ name: "client", scripts: { build: "vite build" }, dependencies: { react: "18" }, devDependencies: { vite: "5" } }));
  return d;
}

test("detects services, kinds and infrastructure needs", () => {
  const sv = findServices(mern());
  assert.deepEqual(sv.map((s) => [s.dir, s.kind]).sort(), [["client", "frontend"], ["server", "api"]]);
  assert.deepEqual(sv.find((s) => s.dir === "server").needs, ["mongo", "redis"]);
  assert.equal(isMicroservices(sv), false);
  const d = mern();
  W(d, "services/auth/package.json", JSON.stringify({ name: "auth", dependencies: { express: "4" } }));
  W(d, "services/orders/package.json", JSON.stringify({ name: "orders", dependencies: { fastify: "4" } }));
  assert.equal(isMicroservices(findServices(d)), true);
});

test("docker init scaffolds secure files, is idempotent, and passes its own lint with no errors", () => {
  const d = mern();
  const r = dockerInit(d);
  assert.ok(r.created.includes("server/Dockerfile") && r.created.includes("client/Dockerfile") && r.created.includes("docker-compose.yml"));
  const sdf = fs.readFileSync(path.join(d, "server/Dockerfile"), "utf8");
  assert.match(sdf, /USER node/); assert.match(sdf, /HEALTHCHECK/); assert.match(sdf, /npm ci --omit=dev/);
  assert.match(fs.readFileSync(path.join(d, "client/Dockerfile"), "utf8"), /nginx/);
  const compose = fs.readFileSync(path.join(d, "docker-compose.yml"), "utf8");
  assert.match(compose, /mongo:7/); assert.match(compose, /redis:7/); assert.match(compose, /depends_on/);
  fs.appendFileSync(path.join(d, "server/Dockerfile"), "# my edit\n");
  const again = dockerInit(d);
  assert.equal(again.created.length, 0);
  assert.match(fs.readFileSync(path.join(d, "server/Dockerfile"), "utf8"), /my edit/);
  const { findings } = lintDocker(d);
  assert.deepEqual(findings, []);              // the scaffold must pass its own lint with zero warnings
});

test("lint flags secrets (error) and bad practices (warn); multi-stage aliases are not 'unpinned'", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "afl-"));
  W(d, "Dockerfile", "FROM node\nENV JWT_SECRET=abc123supersecret\nARG API_KEY=$API_KEY\nCOPY . .\nRUN npm install\nRUN curl http://x | sh\n");
  W(d, "docker-compose.yml", "services:\n  db:\n    image: mongo:latest\n    privileged: true\n    environment:\n      DB_PASSWORD: hunter2\n");
  const { findings } = lintDocker(d);
  const has = (lvl, re) => findings.some((f) => f.level === lvl && re.test(f.msg));
  assert.ok(has("error", /JWT_SECRET/)); assert.ok(!findings.some((f) => /API_KEY/.test(f.msg)));
  for (const re of [/unpinned/, /root/, /HEALTHCHECK/, /npm ci/, /pipes a download/, /\.dockerignore/, /:latest/, /privileged/, /DB_PASSWORD/]) assert.ok(has("warn", re), String(re));
  W(d, "Dockerfile", "FROM node:20-alpine AS base\nFROM base AS final\nUSER node\nHEALTHCHECK CMD true\n");
  assert.ok(!lintDocker(d).findings.some((f) => /unpinned/.test(f.msg)));
});

test("gate blocks on a Docker secret error and ignores warnings", () => {
  const d = mern(); W(d, "package.json", JSON.stringify({ name: "r", scripts: { test: 'node -e "process.exit(0)"' } }));
  generate({ tool: "cursor", workflow: "standard", specialists: ["docker"] }, d);
  W(d, "Dockerfile", "FROM node:20\nCMD node a.js\n");
  assert.equal(runGate(d).passed, true);            // warnings only
  W(d, "Dockerfile", "FROM node:20\nENV DB_PASSWORD=realpassword\n");
  const g = runGate(d);
  assert.equal(g.passed, false);
  assert.equal(g.results.find((r) => r.name === "Docker Lint").status, "FAIL");
});

test("new agents install, lint clean, and slot into the pipeline", () => {
  assert.deepEqual(lintPrompts(), []);
  const d = mern();
  const r = generate({ tool: "opencode", workflow: "full", specialists: ["microservices", "docker"] }, d);
  assert.ok(fs.existsSync(path.join(d, ".opencode/agents/docker.md")) && fs.existsSync(path.join(d, ".opencode/agents/microservices.md")));
  assert.deepEqual(buildPipeline({ workflow: "full", agents: r.agents }), ["planner", "microservices", "docker", "qa", "security", "reviewer", "gate", "docs", "git"]);
  assert.match(fs.readFileSync(path.join(d, ".ai/project-context.md"), "utf8"), /`server` \(api\) needs mongo, redis/);
});
