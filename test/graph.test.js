import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildGraph, findCycles, writeGraph } from "../src/graph.js";
import { generate } from "../src/generator.js";
import { runGate } from "../src/gate.js";
import { validateReports } from "../src/validate.js";
import { lintPrompts } from "../src/doctor.js";

const W = (d, f, c) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); };

function project({ cycle = true } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "afgr-"));
  W(d, "package.json", JSON.stringify({ name: "root", scripts: { test: 'node -e "process.exit(0)"' } }));
  W(d, "server/package.json", JSON.stringify({ name: "server", scripts: { start: "node src/app.js" }, dependencies: { express: "4", mongoose: "7", amqplib: "1" } }));
  W(d, "server/src/app.js", "const r = require('./routes/tickets');\nconst c = require('./config/db');\n");
  W(d, "server/src/routes/tickets.js", "const c = require('../controllers/ticketController');\n");
  W(d, "server/src/controllers/ticketController.js", "import m from '../models/Ticket';\nimport { notify } from '../services/mail';\n");
  W(d, "server/src/models/Ticket.js", cycle ? "const r = require('../routes/tickets'); // bad: model imports a route\n" : "module.exports = {};\n");
  W(d, "server/src/services/mail.js", "module.exports = {};\n");
  W(d, "server/src/config/db.js", "module.exports = {};\n");
  W(d, "client/package.json", JSON.stringify({ name: "client", dependencies: { react: "18" }, devDependencies: { vite: "5" } }));
  W(d, "client/src/App.jsx", "import Tickets from './pages/Tickets';\n");
  W(d, "client/src/pages/Tickets.jsx", "import { api } from '../api/client';\nexport const x = () => fetch('/api/tickets');\n");
  W(d, "client/src/api/client.js", "export const api = {};\n");
  return d;
}

test("findCycles finds mutual dependencies and ignores acyclic graphs", () => {
  assert.deepEqual(findCycles(["a", "b", "c"], [{ from: "a", to: "b" }, { from: "b", to: "a" }, { from: "b", to: "c" }]), [["a", "b"]]);
  assert.deepEqual(findCycles(["a", "b"], [{ from: "a", to: "b" }]), []);
});

test("system graph: services, infra from dependencies, frontend -> api call from code", () => {
  const g = buildGraph(project());
  assert.deepEqual(g.system.infra.sort(), ["mongo", "rabbitmq"]);
  const m = g.system.mermaid;
  assert.match(m, /^flowchart LR/);
  assert.match(m, /n_server -->\|uses\| infra_mongo/);
  assert.match(m, /n_server -->\|uses\| infra_rabbitmq/);
  assert.match(m, /n_client (-->|-\.->)\|HTTP\| n_server/);   // evidence: fetch('/api/...')
  assert.match(m, /user --> n_client/);
});

test("module graph: folder edges with counts, cycle detected and highlighted", () => {
  const g = buildGraph(project());
  assert.deepEqual(g.cycles, [{ service: "server", groups: ["controllers", "models", "routes"] }]);
  assert.match(g.markdown, /m_n_routes -->\|1\| m_n_controllers/);
  assert.match(g.markdown, /classDef cycle/);
  assert.match(g.markdown, /- `server`: controllers <-> models <-> routes/);
  assert.match(g.markdown, /\| JavaScript \| \d+ \|/);
  assert.deepEqual(buildGraph(project({ cycle: false })).cycles, []);
});

test("compose depends_on becomes a dotted edge", () => {
  const d = project({ cycle: false });
  W(d, "docker-compose.yml", "services:\n  client:\n    build: ./client\n    depends_on:\n      - server\n  server:\n    build: ./server\n    depends_on:\n      - mongo\n  mongo:\n    image: mongo:7\n");
  assert.match(buildGraph(d).system.mermaid, /n_client -\.->\|depends_on\| n_server|n_client (-->|-\.->)\|HTTP\| n_server/);
});

test("init writes .ai/graph.md; gate cycle check is opt-in and blocks on cycles", () => {
  const d = project();
  generate({ tool: "cursor", workflow: "standard" }, d);
  assert.ok(fs.existsSync(path.join(d, ".ai/graph.md")));
  assert.equal(runGate(d).results.some((r) => r.name === "Dependency Cycles"), false);
  const cfg = JSON.parse(fs.readFileSync(path.join(d, ".ai/config.json"), "utf8")); cfg.graphCheck = true;
  fs.writeFileSync(path.join(d, ".ai/config.json"), JSON.stringify(cfg));
  const g = runGate(d);
  assert.equal(g.results.find((r) => r.name === "Dependency Cycles").status, "FAIL");
  assert.equal(g.passed, false);
});

test("architect report must contain a Mermaid diagram", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "afar-"));
  const base = "# Architecture\n## Decision\nUse a queue between services for emails.\n## Alternatives\nDirect HTTP call; polling the database.\n## Consequences\nEventual consistency for email sending.\n## Diagram\n";
  W(d, ".ai/reports/architecture_decision.md", base + "see whiteboard\n");
  assert.match(validateReports(d, ["architect"]).problems.join(), /Mermaid/);
  W(d, ".ai/reports/architecture_decision.md", base + "```mermaid\nflowchart LR\n  api --> queue --> worker\n```\n");
  assert.equal(validateReports(d, ["architect"]).ok, true);
});

test("prompts still lint clean and mention the graph", () => {
  assert.deepEqual(lintPrompts(), []);
  for (const a of ["architect", "planner", "microservices"]) assert.match(fs.readFileSync(new URL(`../templates/agents/${a}.md`, import.meta.url), "utf8"), /graph\.md/);
});
