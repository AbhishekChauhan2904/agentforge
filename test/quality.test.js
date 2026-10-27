import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { W, tmp, qualityApp, rep } from "./fixtures.js";
import { countLoc, jsFunctions, pyFunctions } from "../src/codefiles.js";
import { scanMetrics } from "../src/metrics.js";
import { scanTests } from "../src/testcheck.js";
import { scanDesign, erDiagram } from "../src/design.js";
import { scanDb } from "../src/dbcheck.js";
import { createAdr } from "../src/adr.js";
import { generate } from "../src/generator.js";
import { runGate } from "../src/gate.js";
import { CHECKS, defaultFlags } from "../src/audit.js";
import { loadConfig, migrateConfig } from "../src/config.js";
import { validateReports } from "../src/validate.js";
import { buildPipeline } from "../src/state.js";
import { lintPrompts } from "../src/doctor.js";
import { findServices } from "../src/services.js";

const find = (r, re, level) => r.findings.filter((f) => re.test(f.msg) && (!level || f.level === level));
const setCfg = (d, patch) => { const c = loadConfig(d); fs.writeFileSync(path.join(d, ".ai/config.json"), JSON.stringify({ ...c, ...patch })); };

test("LOC counting separates code, comments and blanks (JS and Python)", () => {
  assert.deepEqual(countLoc("// a\n/* b\n c */\nconst x = 1; // trailing\n\nfoo();\n", "c"), { code: 2, comment: 3, blank: 2 });
  assert.deepEqual(countLoc('# c\ndef f():\n    """doc\n    more"""\n    return 1\n', "python"), { code: 2, comment: 3, blank: 1 });
});

test("function metrics: length, cyclomatic complexity and nesting (strings and comments are ignored)", () => {
  const js = `export function simple(a) {\n  return a + 1;\n}\nconst heavy = async (req) => {\n  if (req.a && req.b) {\n    for (const x of req.l) {\n      if (x.ok || x.f) {\n        while (x.n--) { try { run(); } catch (e) { log(e); } }\n      }\n    }\n  }\n  return req.q ? 1 : 2;\n};\nclass A {\n  async load(id) {\n    if (!id) throw new Error("x");\n    return 1;\n  }\n}\nconst tiny = (x) => x * 2;\nconst s = "if (a) { while (b) {} }"; // if (z) {}\n`;
  const f = Object.fromEntries(jsFunctions(js).map((x) => [x.name, x]));
  assert.deepEqual([f.simple.line, f.simple.lines, f.simple.complexity, f.simple.depth], [1, 3, 1, 0]);
  assert.deepEqual([f.heavy.line, f.heavy.lines, f.heavy.complexity, f.heavy.depth], [4, 10, 9, 5]);
  assert.deepEqual([f.load.complexity, f.load.depth], [2, 0]);
  assert.equal(f.tiny.line, 20); assert.equal(Object.keys(f).length, 4);                  // the string and comment added nothing
  const py = jsFunctions && pyFunctions("def a(x):\n    if x and x > 1:\n        for i in x:\n            if i:\n                return 1\n    return 0\n\nclass K:\n    def m(self):\n        return 1\n");
  assert.deepEqual([py[0].name, py[0].lines, py[0].complexity, py[0].depth], ["a", 6, 5, 3]);
  assert.equal(py[1].name, "m");
});

test("metrics: totals, test ratio, soft warnings and hard errors, configurable limits", () => {
  const d = tmp();
  W(d, "package.json", JSON.stringify({ name: "m", scripts: { start: "node a.js" }, dependencies: { express: "4" } }));
  W(d, "src/long.js", `function long() {\n${rep(70, () => "  work();")}\n}\n`);
  W(d, "src/complex.js", `function complex(a) {\n${rep(31, () => "  if (a) { a--; }")}\n}\n`);
  W(d, "src/deep.js", "function deep(a) {\n  if (a) {\n    if (a) {\n      if (a) {\n        if (a) {\n          if (a) { go(); }\n        }\n      }\n    }\n  }\n}\n");
  W(d, "src/big.js", rep(450, (i) => `const v${i} = ${i};`) + "\n");
  W(d, "tests/a.test.js", "test('x', () => { expect(1).toBe(1); });\n");
  const r = scanMetrics(d);
  const [s] = r.services;
  assert.ok(s.src.code > 560 && s.test.code === 1 && s.src.files === 4);
  assert.ok(find(r, /function long is 72 lines long \(limit 60\)/, "warn").length);
  assert.ok(find(r, /function complex has cyclomatic complexity 32 \(limit 15, hard limit 30\)/, "error").length);
  assert.ok(find(r, /function deep nests 5 levels deep/, "warn").length);
  assert.ok(find(r, /450 lines of code \(limit 400\)/, "warn").length);
  assert.ok(find(r, /lines of test code per 100 lines of source/, "info").length);
  assert.equal(s.complex[0].name, "complex");
  fs.mkdirSync(path.join(d, ".ai"), { recursive: true });
  fs.writeFileSync(path.join(d, ".ai/config.json"), JSON.stringify({ limits: { functionLines: 10 } }));
  assert.ok(find(scanMetrics(d), /function long is 72 lines long \(limit 10, hard limit 25\)/, "error").length);
});

test("tests: framework, mapping by relative import, by name and by alias; untested files ranked by size", () => {
  const r = scanTests(qualityApp());
  const s = r.services.find((x) => x.dir === "server");
  assert.equal(s.runner, "Jest"); assert.equal(s.testFiles, 4);
  assert.equal(s.logicFiles, 6);                                   // 2 controllers + 2 services + 2 utils; app.js, models and the test files are not logic
  assert.deepEqual(s.untested.map((u) => path.basename(u.file)), ["userController.js", "dates.js"]);
  assert.equal(s.covered, 4);                                      // ticketController (relative import), mailService (name), priceService (import), format (ESM import)
  assert.ok(s.untested[0].loc > 150 && s.untested[0].exports.includes("fn0"));
  assert.ok(find(r, /\d+ lines of logic with no unit test \(exports: fn0/, "warn").length);
});

test("tests: quality problems in test files", () => {
  const r = scanTests(qualityApp());
  assert.equal(find(r, /focused test/, "error").length, 1);
  assert.match(find(r, /focused test/)[0].file, /price\.test\.js$/);
  assert.ok(find(r, /1 skipped test/, "warn").length);
  assert.equal(find(r, /empty test body/, "warn").length, 1);
  assert.equal(find(r, /contain no assertions/).length, 0);       // price.test.js also has expect() elsewhere in the file
  const d = tmp(); W(d, "package.json", JSON.stringify({ name: "x", scripts: { test: "jest" }, dependencies: { express: "4" }, devDependencies: { jest: "29" } }));
  W(d, "tests/noassert.test.js", "test('runs', () => { doSomething(); });\ntest('also', () => { other(); });\n");
  assert.equal(find(scanTests(d), /contain no assertions/, "warn").length, 1);
});

test("tests: a service with logic but no tests, and one with no test script", () => {
  const d = tmp();
  W(d, "package.json", JSON.stringify({ name: "x", dependencies: { express: "4" } }));
  for (const n of ["a", "b", "c"]) W(d, `src/services/${n}.js`, `exports.${n} = () => 1;\n`);
  const r = scanTests(d);
  assert.ok(find(r, /no unit tests found in x \(3 logic files\)\. Recommended runner: Jest/, "warn").length);
  W(d, "tests/a.test.js", "const a = require('../src/services/a');\ntest('a', () => { expect(a.a()).toBe(1); });\n");
  assert.ok(find(scanTests(d), /no "test" script in package.json/, "warn").length);
});

test("tests: line coverage from lcov / json summary / cobertura, minCoverage enforcement, stale reports", () => {
  const d = qualityApp();
  const lcov = (lf, lh) => `TN:\nSF:a.js\nLF:${lf}\nLH:${lh}\nend_of_record\nSF:b.js\nLF:${lf}\nLH:${lh}\nend_of_record\n`;
  W(d, "server/coverage/lcov.info", lcov(50, 30));
  let r = scanTests(d); assert.equal(Math.round(r.services.find((x) => x.dir === "server").coverage.pct), 60);
  assert.equal(find(r, /below the required/).length, 0);                        // no minimum configured: reported, not enforced
  fs.mkdirSync(path.join(d, ".ai"), { recursive: true });
  fs.writeFileSync(path.join(d, ".ai/config.json"), JSON.stringify({ minCoverage: 80 }));
  assert.ok(find(scanTests(d), /line coverage 60\.0% is below the required 80%/, "error").length);
  fs.rmSync(path.join(d, "server/coverage"), { recursive: true });
  assert.ok(find(scanTests(d), /minCoverage is 80% but no coverage report was found/, "warn").length);
  W(d, "server/coverage/coverage-summary.json", JSON.stringify({ total: { lines: { pct: 91.5 } } }));
  assert.equal(find(scanTests(d), /below the required/).length, 0);
  fs.rmSync(path.join(d, "server/coverage"), { recursive: true });
  W(d, "server/coverage.xml", '<coverage line-rate="0.5" branch-rate="0">');
  assert.ok(find(scanTests(d), /50\.0% is below/, "error").length);
  const old = new Date(Date.now() - 30 * 86400000); W(d, "server/coverage/lcov.info", lcov(10, 10)); fs.utimesSync(path.join(d, "server/coverage/lcov.info"), old, old);
  fs.rmSync(path.join(d, "server/coverage.xml"));
  assert.ok(find(scanTests(d), /coverage report is 30 days old/, "info").length);
});

test("tests: Python, Flutter and Next.js route handlers map to their tests", () => {
  const d = tmp();
  W(d, "api/requirements.txt", "fastapi\npytest\n"); W(d, "api/main.py", "");
  W(d, "api/app/services/users.py", "def get_user(i):\n    return i\n"); W(d, "api/app/services/orders.py", "def list_orders():\n    return []\n");
  W(d, "api/tests/test_users.py", "from app.services.users import get_user\n\ndef test_get_user():\n    assert get_user(1) == 1\n");
  W(d, "mobile/pubspec.yaml", "name: shop\ndependencies:\n  flutter:\n    sdk: flutter\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n");
  W(d, "mobile/lib/data/cart_repository.dart", "class CartRepository {}\n"); W(d, "mobile/lib/data/user_repository.dart", "class UserRepository {}\n");
  W(d, "mobile/test/cart_test.dart", "import 'package:shop/data/cart_repository.dart';\nvoid main() { test('x', () { expect(1, 1); }); }\n");
  W(d, "web/package.json", JSON.stringify({ name: "web", dependencies: { next: "14", react: "18" }, devDependencies: { vitest: "1" } }));
  W(d, "web/src/app/api/tickets/route.ts", "export async function GET() { return Response.json([]); }\n"); W(d, "web/src/app/api/users/route.ts", "export async function GET() { return Response.json([]); }\n");
  W(d, "web/tests/tickets.test.ts", "import { GET } from '@/app/api/tickets/route';\ntest('t', async () => { expect(GET).toBeDefined(); });\n");
  const by = Object.fromEntries(scanTests(d).services.map((s) => [s.dir, s]));
  assert.equal(by.api.runner, "pytest"); assert.deepEqual(by.api.untested.map((u) => path.basename(u.file)), ["orders.py"]); assert.equal(by.api.covered, 1);
  assert.equal(by.mobile.runner, "flutter_test"); assert.deepEqual(by.mobile.untested.map((u) => path.basename(u.file)), ["user_repository.dart"]);
  assert.equal(by.web.runner, "Vitest"); assert.deepEqual(by.web.untested.map((u) => u.file), ["web/src/app/api/users/route.ts"]);   // two route.ts files: only the imported one is covered
});

test("regression: a module with `module.exports = {}` must not crash the test scanner", () => {
  const d = tmp(); W(d, "package.json", JSON.stringify({ name: "x", scripts: { start: "node a" }, dependencies: { express: "4" } }));
  W(d, "src/services/empty.js", "module.exports = {};\n");
  assert.doesNotThrow(() => scanTests(d));
  assert.deepEqual(scanTests(d).services[0].untested[0].exports, []);
});

test("design: stability, coupling, god files, cycles", () => {
  const d = tmp();
  W(d, "package.json", JSON.stringify({ name: "app", scripts: { start: "node a" }, dependencies: { express: "4" } }));
  W(d, "src/routes/a.js", "require('../controllers/c');\nrequire('../models/m');\n");
  W(d, "src/controllers/c.js", "require('../models/m');\n");
  W(d, "src/models/m.js", "require('../utils/u');\nrequire('../services/s');\n");
  W(d, "src/utils/u.js", Array.from({ length: 4 }, (_, i) => `require('../lib${i}/x');`).join("\n") + "\nmodule.exports={};\n");
  for (let i = 0; i < 4; i++) W(d, `src/lib${i}/x.js`, "module.exports = {};\n");
  W(d, "src/services/s.js", "require('../controllers/c');\n");
  W(d, "src/god.js", Array.from({ length: 10 }, (_, i) => `require('./lib${i % 4}/x');\nrequire('./routes/a');\nconst a${i} = 1;`).join("\n").split("\n").concat(Array.from({ length: 420 }, (_, i) => `const g${i} = ${i};`)).join("\n") + "\n");
  const r = scanDesign(d);
  const s = r.services[0], mod = Object.fromEntries(s.modules.map((m) => [m.name, m]));
  assert.ok(mod.models.ca >= 2 && mod.models.instability < mod.routes.instability);   // models are depended on; routes are not
  assert.equal(mod.utils.ce, 4);
  assert.ok(find(r, /circular dependency between controllers, models, services/, "error").length);
  assert.ok(find(r, /stability .* depends on less stable/, "warn").length);
  assert.ok(s.topOut.length > 0 && s.topOut[0].out >= 2);
});

test("design: god file and high fan-out", () => {
  const d = tmp();
  W(d, "package.json", JSON.stringify({ name: "app", scripts: { start: "node a" }, dependencies: { express: "4" } }));
  for (let i = 0; i < 17; i++) W(d, `src/mods/m${i}.js`, "module.exports = {};\n");
  W(d, "src/hub.js", Array.from({ length: 17 }, (_, i) => `const m${i} = require('./mods/m${i}');`).join("\n") + "\n");
  W(d, "src/other/x.js", "require('../hub');\n");
  W(d, "src/god.js", Array.from({ length: 9 }, (_, i) => `const m${i} = require('./mods/m${i}');`).join("\n") + "\n" + Array.from({ length: 420 }, (_, i) => `const g${i} = ${i};`).join("\n") + "\n");
  const r = scanDesign(d);
  assert.ok(find(r, /imports 17 other files \(limit 15\)/, "warn").some((f) => /hub\.js$/.test(f.file)));
  assert.ok(find(r, /god file: \d+ lines and 9 imports/, "warn").some((f) => /god\.js$/.test(f.file)));
});

test("design: ER diagram from Mongoose refs, Prisma relations, Django and SQLAlchemy foreign keys", () => {
  const er = scanDesign(qualityApp()).er;
  assert.match(er, /^erDiagram/);
  assert.match(er, /TICKET }o--\|\| USER : "owner"/); assert.match(er, /TICKET }o--o\{ USER : "watchers"/);
  const d = tmp();
  W(d, "api/package.json", JSON.stringify({ name: "api", dependencies: { express: "4", "@prisma/client": "5" } }));
  W(d, "api/prisma/schema.prisma", "model Post {\n  id Int @id\n  authorId Int\n  author User @relation(fields: [authorId], references: [id])\n  tags Tag[]\n}\nmodel User {\n  id Int @id\n  posts Post[]\n}\nmodel Tag {\n  id Int @id\n  posts Post[]\n}\n");
  W(d, "py/requirements.txt", "django\n"); W(d, "py/manage.py", "");
  W(d, "py/shop/models.py", "from django.db import models\nclass Order(models.Model):\n    buyer = models.ForeignKey('Customer', on_delete=models.CASCADE)\n    items = models.ManyToManyField(Item)\nclass Customer(models.Model):\n    name = models.CharField(max_length=10)\nclass Item(models.Model):\n    name = models.CharField(max_length=10)\n");
  W(d, "sa/requirements.txt", "fastapi\nsqlalchemy\n");
  W(d, "sa/models.py", "class User(Base):\n    __tablename__ = 'users'\n    id = Column(Integer, primary_key=True)\nclass Invoice(Base):\n    __tablename__ = 'invoices'\n    user_id = Column(Integer, ForeignKey('users.id'))\n");
  const e = erDiagram(scanDb(d).models);
  assert.match(e, /POST }o--\|\| USER : "author"/);
  assert.equal((e.match(/POST }o--o\{ TAG/g) || []).length, 1);                  // many-to-many listed once, not once per side
  assert.doesNotMatch(e, /USER }o--o\{ POST/);                                    // the back-relation is not drawn
  assert.match(e, /ORDER }o--\|\| CUSTOMER : "buyer"/); assert.match(e, /ORDER }o--o\{ ITEM : "items"/);
  assert.match(e, /INVOICE }o--\|\| USER : "user_id"/);
  assert.equal(erDiagram([]), null);
});

test("adr: numbered decision records, slug, and the decisions log", () => {
  const d = tmp(); W(d, ".ai/decisions.md", "| Date | Decision | Reason |\n|---|---|---|\n");
  const a = createAdr(d, "Use PostgreSQL instead of MongoDB!");
  assert.equal(a.id, "0001"); assert.equal(a.file, "docs/adr/0001-use-postgresql-instead-of-mongodb.md");
  assert.match(fs.readFileSync(path.join(d, a.file), "utf8"), /# 1\. Use PostgreSQL instead of MongoDB!\n\n- Status: Proposed[\s\S]*## Consequences/);
  assert.equal(createAdr(d, "Adopt Next.js").id, "0002");
  assert.match(fs.readFileSync(path.join(d, ".ai/decisions.md"), "utf8"), /Use PostgreSQL instead of MongoDB! \| ADR 0001/);
  assert.throws(() => createAdr(d, "  "), /Usage/);
});

test("init turns on the new checks; the gate blocks on a committed .only and on a hard complexity limit", () => {
  const d = qualityApp();
  generate({ tool: "cursor", workflow: "full", specialists: ["tester"] }, d);
  const c = loadConfig(d); assert.equal(c.testCheck, true); assert.equal(c.metricsCheck, true);
  const g = runGate(d);
  assert.equal(g.results.find((x) => x.name === "Test Health").status, "FAIL");           // it.only in price.test.js
  assert.equal(g.results.find((x) => x.name === "Code Metrics").status, "PASS");
  W(d, "server/src/services/branchy.js", `exports.f = (a) => {\n${rep(31, () => "  if (a) { a--; }")}\n  return a;\n};\n`);
  assert.equal(runGate(d).results.find((x) => x.name === "Code Metrics").status, "FAIL");
  setCfg(d, { testCheck: false, metricsCheck: false });
  assert.equal(runGate(d).results.some((x) => /Test Health|Code Metrics/.test(x.name)), false);
  assert.deepEqual(defaultFlags([{ kind: "lib" }], undefined), {});
});

test("a crashing check is reported as SKIP and never blocks the gate", () => {
  const d = qualityApp(); generate({ tool: "cursor", workflow: "standard" }, d);
  fs.rmSync(path.join(d, "server/tests/price.test.js"));
  const orig = CHECKS.tests.run;
  CHECKS.tests.run = () => { throw new Error("boom"); };
  try {
    const g = runGate(d);
    const t = g.results.find((x) => x.name === "Test Health");
    assert.equal(t.status, "SKIP"); assert.match(t.detail, /internal error in this check \(boom\)/);
    assert.equal(g.results.filter((x) => x.status === "FAIL").length, 0);
    assert.equal(g.passed, true);
  } finally { CHECKS.tests.run = orig; }
});

test("test engineer agent: installs, lints, runs before QA, and a failing verdict is caught", () => {
  assert.deepEqual(lintPrompts(), []);
  assert.deepEqual(buildPipeline({ workflow: "full", agents: ["orchestrator", "planner", "qa", "reviewer", "backend", "tester"] }), ["planner", "backend", "tester", "qa", "reviewer", "gate"]);
  const d = tmp();
  const base = "# Test Report\n## Commands Run\nnpm test: 40 passed, 2 failed in the run.\n## Tests Added\nTicket controller tests were added.\n## Coverage\nLine coverage is 71 percent now.\n";
  W(d, ".ai/reports/test_report.md", base + "## Verdict: FAIL\n");
  assert.match(validateReports(d, ["tester"]).problems.join(), /verdict is negative/);
  W(d, ".ai/reports/test_report.md", base + "## Verdict: PASS\n");
  assert.equal(validateReports(d, ["tester"]).ok, true);
  const d2 = qualityApp(); generate({ tool: "opencode", workflow: "standard", specialists: ["tester"] }, d2);
  assert.match(fs.readFileSync(path.join(d2, ".opencode/agents/tester.md"), "utf8"), /agentforge tests/);
  const tpl = (n) => fs.readFileSync(new URL(`../templates/agents/${n}.md`, import.meta.url), "utf8");
  assert.match(tpl("architect"), /Software design principles[\s\S]*agentforge design[\s\S]*agentforge adr/);
  assert.match(tpl("reviewer"), /agentforge design[\s\S]*agentforge metrics/);
  assert.match(tpl("qa"), /agentforge tests/);
});

test("update upgrades an older config without touching anything the user set", () => {
  const d = qualityApp();
  generate({ tool: "cursor", workflow: "standard" }, d);
  const old = { tool: "cursor", workflow: "standard", agents: loadConfig(d).agents, gate: [{ name: "Tests", cmd: 'node -e "process.exit(0)"' }], audit: true, secretScan: true, apiCheck: false };
  fs.writeFileSync(path.join(d, ".ai/config.json"), JSON.stringify(old));
  const added = migrateConfig(d, "javascript");
  assert.deepEqual(added.sort(), ["dbCheck", "language", "metricsCheck", "structureCheck", "testCheck"]);
  const c = loadConfig(d);
  assert.equal(c.apiCheck, false);                                // the user's own choice is kept
  assert.deepEqual(c.gate, old.gate);
  assert.deepEqual(migrateConfig(d, "javascript"), []);           // idempotent
  assert.equal(findServices(d).length > 0, true);
});
