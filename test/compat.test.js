import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { W, mernApp } from "./fixtures.js";
import { findServices } from "../src/services.js";
import { generate } from "../src/generator.js";
import { loadConfig, migrateConfig } from "../src/config.js";
import { CHECKS } from "../src/audit.js";
import { scanApi } from "../src/api.js";
import { scanDb } from "../src/dbcheck.js";
import { erDiagram } from "../src/design.js";
import { buildGraph } from "../src/graph.js";
import { dockerInit, lintDocker } from "../src/docker.js";
import { runGate } from "../src/gate.js";
import { doctor } from "../src/doctor.js";
import { startTask } from "../src/state.js";

const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
const errors = (r) => r.findings.filter((f) => f.level === "error");

test("MERN stack: every feature works end to end on a classic React + Express + MongoDB + JWT project", () => {
  const d = mernApp();
  const sv = Object.fromEntries(findServices(d).map((s) => [s.dir, s]));
  assert.equal(sv.client.kind, "frontend"); assert.equal(sv.client.framework, "react");
  assert.equal(sv.server.kind, "api"); assert.equal(sv.server.framework, "express"); assert.deepEqual(sv.server.needs, ["mongo"]);

  const res = generate({ tool: "cursor", workflow: "full", specialists: ["frontend", "backend", "database", "tester"] }, d);
  assert.equal(res.language, "javascript");
  const cfg = loadConfig(d);
  for (const k of ["apiCheck", "dbCheck", "structureCheck", "testCheck", "metricsCheck"]) assert.equal(cfg[k], true, k);
  assert.equal(cfg.cloudCheck, undefined);                                    // no cloud usage, so no cloud check

  const api = scanApi(d);
  assert.equal(api.endpoints.find((e) => e.method === "GET" && e.path === "/api/tickets").auth, true);        // router.use(authenticate)
  assert.equal(api.endpoints.find((e) => e.method === "POST" && e.path === "/api/auth/login").auth, false);   // public by design
  assert.equal(errors(api).length, 0);

  const db = scanDb(d);
  assert.deepEqual(db.models.map((m) => m.name).sort(), ["Ticket", "User"]);
  assert.equal(errors(db).length, 0);
  assert.match(erDiagram(db.models), /TICKET }o--\|\| USER : "owner"/);

  const g = buildGraph(d);
  assert.match(g.system.mermaid, /n_client (-->|-\.->)\|HTTP\| n_server/);
  assert.match(g.system.mermaid, /n_server -->\|uses\| infra_mongo/);
  assert.deepEqual(g.cycles, []);

  const dk = dockerInit(d);
  assert.match(fs.readFileSync(path.join(d, "client/Dockerfile"), "utf8"), /nginx-unprivileged/);
  assert.match(fs.readFileSync(path.join(d, "server/Dockerfile"), "utf8"), /USER node/);
  assert.match(fs.readFileSync(path.join(d, "docker-compose.yml"), "utf8"), /mongo:7[\s\S]*mongo-data/);
  assert.deepEqual(lintDocker(d).findings, []); assert.ok(dk.created.length >= 5);

  for (const [key, c] of Object.entries(CHECKS)) assert.doesNotThrow(() => c.run(d), key);                  // no checker may crash on a MERN project
  const gate = runGate(d);
  assert.equal(gate.passed, true, JSON.stringify(gate.results.filter((r) => r.status !== "PASS")));
  assert.equal(doctor(d).filter((c) => c.level === "fail").length, 0);
});

test("a config written by the very first agentforge version still works, and update upgrades it", () => {
  const d = mernApp();
  generate({ tool: "cursor", workflow: "standard", specialists: ["backend"] }, d);
  const v1 = { tool: "cursor", workflow: "standard", agents: ["orchestrator", "planner", "reviewer", "backend"], gate: [{ name: "Tests", cmd: 'node -e "process.exit(0)"' }], audit: true, secretScan: true };
  fs.writeFileSync(path.join(d, ".ai/config.json"), JSON.stringify(v1, null, 2));
  assert.doesNotThrow(() => loadConfig(d));
  let g = runGate(d);
  assert.deepEqual(g.results.map((r) => r.name), ["Tests", "Secret Scan"]);                               // exactly what v1 did: nothing new switches on by itself
  assert.equal(g.passed, true);
  assert.equal(doctor(d).filter((c) => c.level === "fail").length, 0);
  assert.ok(startTask(d, "add a feature").pipeline.length > 0);                                           // the task workflow runs on an old config

  const r = spawnSync("node", [new URL("../bin/cli.js", import.meta.url).pathname, "update"], { cwd: d, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Upgraded \.ai\/config\.json, added: .*apiCheck/);
  const c = loadConfig(d);
  assert.deepEqual(c.gate, v1.gate); assert.equal(c.language, "javascript");
  g = runGate(d);
  for (const n of ["API Security", "DB Safety", "Code Structure", "Test Health", "Code Metrics"]) assert.ok(g.results.some((x) => x.name === n), n);
  assert.equal(g.passed, true);
  assert.equal(spawnSync("node", [new URL("../bin/cli.js", import.meta.url).pathname, "update"], { cwd: d, encoding: "utf8" }).stdout.includes("Upgraded"), false);   // second run changes nothing
});

test("update refreshes prompts from an older version that you never edited, and keeps the ones you changed", () => {
  const d = mernApp();
  generate({ tool: "cursor", workflow: "standard", specialists: ["backend"] }, d);
  const manifestFile = path.join(d, ".ai/manifest.json"), manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const oldPlanner = "---\ndescription: old\nalwaysApply: false\n---\n\n# Planner (written by agentforge 1.0)\n";
  const planner = ".cursor/rules/planner.mdc", reviewer = ".cursor/rules/reviewer.mdc";
  fs.writeFileSync(path.join(d, planner), oldPlanner); manifest[planner] = sha(oldPlanner);                 // as if an older agentforge wrote it and you never touched it
  fs.appendFileSync(path.join(d, reviewer), "\nMY OWN TEAM RULE: always check accessibility.\n");            // you edited this one
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const r = generate({ tool: "cursor", workflow: "standard", specialists: ["backend"] }, d);
  assert.doesNotMatch(fs.readFileSync(path.join(d, planner), "utf8"), /written by agentforge 1\.0/);
  assert.match(fs.readFileSync(path.join(d, planner), "utf8"), /## Role/);                                  // refreshed to the current prompt
  assert.match(fs.readFileSync(path.join(d, reviewer), "utf8"), /MY OWN TEAM RULE/);                       // your edit survived
  assert.deepEqual(r.skipped, [reviewer]);
});

test("a Python or Flutter project from an older setup is not broken by the new checks", () => {
  const d = mernApp();
  W(d, "ml/requirements.txt", "fastapi\npytest\n"); W(d, "ml/main.py", "from fastapi import FastAPI\napp = FastAPI()\n");
  W(d, "mobile/pubspec.yaml", "name: shop\ndependencies:\n  flutter:\n    sdk: flutter\n"); W(d, "mobile/lib/main.dart", "void main() {}\n");
  for (const [key, c] of Object.entries(CHECKS)) assert.doesNotThrow(() => c.run(d), key);
  assert.equal(findServices(d).length, 4);
});

test("mutation check: the gate catches each deliberate mistake in an otherwise clean MERN project", () => {
  const fresh = () => { const d = mernApp(); generate({ tool: "cursor", workflow: "full", specialists: ["backend"] }, d); return d; };
  const failed = (d) => runGate(d).results.filter((r) => r.status === "FAIL").map((r) => r.name);
  assert.deepEqual(failed(fresh()), []);
  const cases = [
    ["DB Safety", (d) => W(d, "server/src/controllers/authController.js", "const User = require('../models/User');\nexports.login = async (req, res) => res.json(await User.findOne(req.body));\n")],
    ["API Security", (d) => { W(d, "server/src/routes/admin.js", "const router = require('express').Router();\nrouter.delete('/purge', (req, res) => res.json({}));\nmodule.exports = router;\n"); fs.appendFileSync(path.join(d, "server/src/app.js"), "app.use('/api/tools', require('./routes/admin'));\n"); }],
    ["Code Structure", (d) => W(d, "server/src/models/Ticket.js", "const mongoose = require('mongoose');\nmodule.exports = require('../controllers/ticketController');\n")],
    ["Test Health", (d) => W(d, "server/tests/ticketController.test.js", "const c = require('../src/controllers/ticketController');\ntest.only('x', () => { expect(1).toBe(1); });\n")],
    ["API Security", (d) => W(d, "server/src/middleware/auth.js", "const jwt = require('jsonwebtoken');\nexports.authenticate = (req, res, next) => { req.user = jwt.verify(req.headers.authorization, 'mysecret123'); next(); };\n")],
    ["Secret Scan", (d) => W(d, "server/src/config.js", "module.exports = { jwt_secret: 'hunter2hunter2hunter2' };\n")]
  ];
  for (const [expected, mutate] of cases) { const d = fresh(); mutate(d); assert.ok(failed(d).includes(expected), `${expected} should have failed, got: ${failed(d).join(", ") || "nothing"}`); }
});
