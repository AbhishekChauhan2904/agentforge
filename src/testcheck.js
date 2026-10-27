import fs from "node:fs";
import path from "node:path";
import { findServices } from "./services.js";
import { walk, read, EXT, GENERATED, isTestFile, countLoc } from "./codefiles.js";

const posix = (p) => p.split(path.sep).join("/");
const noExt = (p) => p.replace(/\.(m?[jt]sx?|cjs|py|dart)$/, "");
const NODE_LOGIC = /^(controllers?|services?|utils?|lib|helpers?|hooks|actions|middlewares?|validations?|validators?|handlers?|repositor(y|ies)|domain|usecases|stores?|reducers|api|server)\//;
const FLUTTER_LOGIC = /^lib\/(data|domain|services?|repositories|state|bloc|cubit|providers?|core|utils?|models?)\//;

function isLogicFile(rel, svc) {
  const f = posix(rel);
  if (isTestFile(f) || GENERATED.test(f)) return false;
  if (svc.lang === "python") return /\.py$/.test(f) && !/(__init__|conftest|settings|manage\.py|wsgi|asgi|setup\.py|alembic|\/migrations\/)/.test(f);
  if (svc.lang === "flutter") return FLUTTER_LOGIC.test(f) && /\.dart$/.test(f);
  if (!EXT.node.test(f) || /\.config\.|\.stories\.|(^|\/)(types?|constants?|config|migrations?|seeds?|scripts?|public|styles?|mocks?|fixtures?)(\/|\.)/.test(f)) return false;
  const g = f.replace(/^src\//, "");
  return svc.framework === "next" ? NODE_LOGIC.test(g) || /^app\/api\/.*route\.[jt]s$/.test(g) || /^pages\/api\//.test(g) || /^middleware\.[jt]s$/.test(g) : NODE_LOGIC.test(g);
}

export function detectRunner(svc, root) {
  const d = svc.deps || {};
  if (svc.lang === "python") { const t = (read(path.join(root, "requirements.txt")) + read(path.join(root, "pyproject.toml"))).toLowerCase(); return t.includes("pytest") ? "pytest" : null; }
  if (svc.lang === "flutter") return /flutter_test/.test(read(path.join(root, "pubspec.yaml"))) ? "flutter_test" : null;
  if (d.vitest) return "Vitest";
  if (d.jest || d["ts-jest"] || d["@types/jest"]) return "Jest";
  if (d.mocha) return "Mocha"; if (d.ava) return "AVA";
  if (/node\s+--test/.test(svc.scripts?.test || "")) return "node:test";
  return null;
}
const recommend = (svc) => svc.lang === "python" ? "pytest (pip install pytest pytest-cov)" : svc.lang === "flutter" ? "flutter_test (already included with Flutter)" : (svc.typescript || svc.framework === "next" || svc.deps?.vite) ? "Vitest (npm i -D vitest)" : "Jest (npm i -D jest)";

function exportsOf(text, lang) {
  const names = new Set();
  if (lang === "python") { for (const m of text.matchAll(/^(?:async\s+)?def\s+([a-zA-Z]\w*)|^class\s+(\w+)/gm)) names.add(m[1] || m[2]); }
  else if (lang === "flutter") { for (const m of text.matchAll(/^(?:abstract\s+)?class\s+(\w+)/gm)) names.add(m[1]); }
  else {
    for (const m of text.matchAll(/export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)|export\s+(?:const|let|var|class)\s+([\w$]+)|exports\.([\w$]+)\s*=/g)) names.add(m[1] || m[2] || m[3]);
    for (const m of text.matchAll(/module\.exports\s*=\s*\{([^}]*)\}|export\s*\{([^}]*)\}/g)) for (const n of (m[1] ?? m[2] ?? "").split(",")) { const x = n.trim().split(/\s+as\s+|:/)[0].trim(); if (/^[\w$]+$/.test(x)) names.add(x); }
  }
  return [...names].filter((n) => n && !/^(default|module)$/.test(n)).slice(0, 8);
}

function importsOfTest(text, lang, testRel, pkg) {
  const out = [];
  const push = (spec) => out.push(spec);
  if (lang === "python") {
    for (const m of text.matchAll(/^\s*from\s+([\w.]+)\s+import|^\s*import\s+([\w.]+)/gm)) { const mod = (m[1] || m[2]); if (!mod.startsWith(".")) push(mod.replace(/\./g, "/")); }
  } else if (lang === "flutter") {
    for (const m of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) { const s = m[1]; if (s.startsWith(`package:${pkg}/`)) push("lib/" + s.slice(`package:${pkg}/`.length)); else if (!/^(package|dart):/.test(s)) push(posix(path.normalize(path.join(path.dirname(testRel), s)))); }
  } else {
    for (const m of text.matchAll(/(?:from\s+|require\(\s*|import\(\s*|(?:jest|vi)\.(?:mock|requireActual)\(\s*)['"]([^'"]+)['"]/g)) {
      const s = m[1];
      if (s.startsWith(".")) push(posix(path.normalize(path.join(path.dirname(testRel), s)))); else push("@" + s.replace(/^(@\/|~\/|#\/)/, "").replace(/^src\//, ""));
    }
  }
  return out.map((s) => noExt(s).replace(/\/index$/, ""));
}

function covered(srcRel, tests, svc) {
  const f = noExt(posix(srcRel)), fNoSrc = f.replace(/^src\//, ""), base = path.posix.basename(f);
  const amb = /^(route|page|index|layout)$/.test(base);
  for (const t of tests) {
    for (const s of t.imports) {
      if (s.startsWith("@")) { const x = s.slice(1); if (x === fNoSrc || (svc.lang === "python" && (f.endsWith(x) || x.endsWith(fNoSrc)) && x.includes("/"))) return true; }
      else if (s === f || s === f.replace(/\/index$/, "")) return true;
      else if (svc.lang === "python" && s.includes("/") && (f.endsWith("/" + s) || f === s || s.endsWith("/" + f))) return true;
    }
    if (!amb) { const n = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, ""); if (n(t.name) === n(base)) return true; }
  }
  return false;
}

function readCoverage(root) {
  const find = (rel) => { const f = path.join(root, rel); return fs.existsSync(f) ? f : null; };
  const age = (f) => Math.floor((Date.now() - fs.statSync(f).mtimeMs) / 86400000);
  let f = find("coverage/lcov.info");
  if (f) { const t = read(f); const lf = [...t.matchAll(/^LF:(\d+)/gm)].reduce((a, m) => a + +m[1], 0), lh = [...t.matchAll(/^LH:(\d+)/gm)].reduce((a, m) => a + +m[1], 0); if (lf) return { pct: (lh / lf) * 100, source: "coverage/lcov.info", days: age(f) }; }
  f = find("coverage/coverage-summary.json");
  if (f) { try { const j = JSON.parse(read(f)); return { pct: j.total.lines.pct, source: "coverage/coverage-summary.json", days: age(f) }; } catch { /* unreadable */ } }
  for (const rel of ["coverage.xml", "coverage/cobertura-coverage.xml"]) { f = find(rel); if (f) { const m = read(f).match(/line-rate="([\d.]+)"/); if (m) return { pct: +m[1] * 100, source: rel, days: age(f) }; } }
  return null;
}

const ASSERT = /\b(expect|assert|assertEquals|assertThat|verify|should)\b|\.expect\(|pytest\.raises|self\.assert\w*|\bt\.(is|true|false|deepEqual|equal|throws)\b|\bexpectLater\b/;
const TESTCALL = /\b(it|test|testWidgets)\s*\(|^\s*(async\s+)?def\s+test_/m;

export function scanTests(cwd) {
  const findings = [], services = [];
  let minCoverage = null;
  try { const c = JSON.parse(read(path.join(cwd, ".ai/config.json"))); if (typeof c.minCoverage === "number") minCoverage = c.minCoverage; } catch { /* no config */ }
  for (const svc of findServices(cwd).filter((s) => s.kind !== "lib")) {
    const lang = svc.lang || "node", root = path.join(cwd, svc.dir), pre = (f) => path.join(svc.dir === "." ? "" : svc.dir, f);
    const add = (level, file, line, msg) => findings.push({ level, file, line, msg });
    const files = walk(root, { flutter: lang === "flutter" }).filter((f) => EXT[lang].test(f));
    const testRels = files.filter((f) => isTestFile(f)), logic = files.filter((f) => isLogicFile(f, svc) && countLoc(read(path.join(root, f)), lang === "python" ? "python" : "c").code > 0);   // an empty or comment-only file has nothing to test
    const tests = testRels.map((f) => { const text = read(path.join(root, f)); return { rel: f, text, name: path.basename(f).replace(/\.(test|spec)\.[^.]+$|_test\.[^.]+$|^test_|\.[^.]+$/g, ""), imports: importsOfTest(text, lang, f, svc.name) }; });
    const runner = detectRunner(svc, root);
    let testCount = 0, skipped = 0; const skippedIn = [];
    for (const t of tests) {
      const n = (t.text.match(/\b(it|test|testWidgets)\s*\(/g) || []).length + (t.text.match(/^\s*(?:async\s+)?def\s+test_/gm) || []).length;
      testCount += n;
      if (!/(\.(test|spec)\.|_test\.|test_)/.test(t.rel) && !TESTCALL.test(t.text)) continue;   // helper files in a tests/ folder
      if (n && !ASSERT.test(t.text)) add("warn", pre(t.rel), 1, "tests in this file contain no assertions: they pass without checking anything");
      for (const m of t.text.matchAll(/\b(describe|it|test|context)\.only\s*\(|\b(fdescribe|fit)\s*\(|solo\s*:\s*true/g)) add("error", pre(t.rel), t.text.slice(0, m.index).split("\n").length, "focused test (.only / fit / solo) committed: every other test in the run is silently skipped");
      const sk = (t.text.match(/\b(xit|xdescribe|xtest)\s*\(|\.skip\s*\(|@pytest\.mark\.skip|pytest\.skip\(|@unittest\.skip|\bskip\s*:\s*(true|['"])/g) || []).length;
      if (sk) { skipped += sk; skippedIn.push(t.rel); }
      for (const m of t.text.matchAll(/\b(it|test)\s*\(\s*(['"`])[^'"`]*\2\s*,\s*(async\s*)?\(\s*\)\s*=>\s*\{\s*\}\s*\)/g)) add("warn", pre(t.rel), t.text.slice(0, m.index).split("\n").length, "empty test body");
    }
    if (skipped) add("warn", pre("."), 1, `${skipped} skipped test(s) in ${skippedIn.slice(0, 3).join(", ")}${skippedIn.length > 3 ? ", ..." : ""}: fix or delete them`);
    const hit = logic.filter((f) => covered(f, tests, svc));
    const untested = logic.filter((f) => !hit.includes(f)).map((f) => { const text = read(path.join(root, f)); return { file: pre(f), loc: countLoc(text, lang === "python" ? "python" : "c").code, exports: exportsOf(text, lang) }; }).sort((a, b) => b.loc - a.loc);
    const hasScript = lang !== "node" || (svc.scripts?.test && !/no test specified/.test(svc.scripts.test));
    if (logic.length && !tests.length) add(logic.length >= 3 ? "warn" : "info", pre("."), 1, `no unit tests found in ${svc.name} (${logic.length} logic files). Recommended runner: ${recommend(svc)}`);
    else if (logic.length && lang === "node" && !hasScript) add("warn", pre("package.json"), 1, 'no "test" script in package.json: the quality gate cannot run your tests');
    for (const u of untested.filter((x) => x.loc >= 150).slice(0, 5)) add("warn", u.file, 1, `${u.loc} lines of logic with no unit test${u.exports.length ? ` (exports: ${u.exports.slice(0, 4).join(", ")})` : ""}`);
    const cov = readCoverage(root);
    if (cov && cov.days > 14) add("info", pre(cov.source), 1, `coverage report is ${cov.days} days old: re-run the tests with coverage`);
    if (cov && minCoverage != null && cov.pct < minCoverage) add("error", pre(cov.source), 1, `line coverage ${cov.pct.toFixed(1)}% is below the required ${minCoverage}% (minCoverage in .ai/config.json)`);
    if (!cov && minCoverage != null && tests.length) add("warn", pre("."), 1, `minCoverage is ${minCoverage}% but no coverage report was found: run the tests with coverage first (e.g. npm test -- --coverage)`);
    if (tests.length) {
      const cfgText = [read(path.join(root, "package.json")), ...["jest.config.js", "jest.config.ts", "jest.config.cjs", "vitest.config.ts", "vitest.config.js", "vite.config.ts", "pyproject.toml", "setup.cfg", "pytest.ini", ".coveragerc"].map((f) => read(path.join(root, f)))].join("\n");
      if (!/coverageThreshold|thresholds|fail_under|cov-fail-under/.test(cfgText) && lang !== "flutter") add("info", pre("."), 1, "no coverage threshold configured (jest coverageThreshold, vitest coverage.thresholds, or pytest --cov-fail-under)");
    }
    services.push({ name: svc.name, dir: svc.dir, lang, runner, recommended: runner ? null : recommend(svc), testFiles: tests.length, tests: testCount, logicFiles: logic.length, covered: hit.length, untested, coverage: cov, skipped });
  }
  return { services, findings, minCoverage };
}

export function renderTests({ services, findings, minCoverage }) {
  return `# Test Health (auto-generated by \`agentforge tests\`)

Static analysis: a logic file (controllers, services, utils, lib, hooks, actions, middleware, API routes, Python modules, Flutter data/state layers) counts as covered when a test imports it or is named after it. This is **file-level coverage, not line coverage**. Line coverage is read from \`coverage/lcov.info\`, \`coverage-summary.json\` or \`coverage.xml\` if your test run produced one${minCoverage != null ? ` (required: ${minCoverage}%)` : " (set `minCoverage` in `.ai/config.json` to enforce a minimum)"}.

${services.map((s) => `## ${s.name} (${s.dir})

- Runner: ${s.runner || `**none detected**. Recommended: ${s.recommended}`}
- ${s.testFiles} test file(s), ${s.tests} test case(s)${s.skipped ? `, ${s.skipped} skipped` : ""}
- Logic files with a test: **${s.covered} of ${s.logicFiles}**${s.logicFiles ? ` (${Math.round((s.covered / s.logicFiles) * 100)}%)` : ""}
- Line coverage: ${s.coverage ? `${s.coverage.pct.toFixed(1)}% (${s.coverage.source}, ${s.coverage.days} day(s) old)` : "no coverage report found"}

${s.untested.length ? `Untested logic files, largest first (test targets for the Test Engineer):\n\n| File | LOC | Exports to test |\n|------|-----|-----------------|\n${s.untested.slice(0, 15).map((u) => `| \`${u.file}\` | ${u.loc} | ${u.exports.join(", ") || "-"} |`).join("\n")}\n` : "Every logic file has a test."}`).join("\n")}
## Findings

${findings.length ? findings.map((f) => `- **${f.level}** \`${f.file}:${f.line}\` ${f.msg}`).join("\n") : "None."}
`;
}
