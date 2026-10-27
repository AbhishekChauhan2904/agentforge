import fs from "node:fs";
import path from "node:path";
import { scanApi, renderApiMap } from "./api.js";
import { scanDb, renderDbMap } from "./dbcheck.js";
import { checkStructure, renderStructure } from "./structure.js";
import { scanCloud, renderCloud, detectCloud } from "./cloud.js";
import { scanTests, renderTests } from "./testcheck.js";
import { scanMetrics, renderMetrics } from "./metrics.js";
import { scanDesign, renderDesign } from "./design.js";

export const CHECKS = {
  api: { flag: "apiCheck", gate: "API Security", run: scanApi, render: renderApiMap, out: "api-map.md" },
  db: { flag: "dbCheck", gate: "DB Safety", run: scanDb, render: renderDbMap, out: "db-map.md" },
  cloud: { flag: "cloudCheck", gate: "Cloud Security", run: scanCloud, render: renderCloud, out: "cloud.md" },
  tests: { flag: "testCheck", gate: "Test Health", run: scanTests, render: renderTests, out: "tests.md",
    summary: (r) => r.services.map((x) => `${x.name}: ${x.runner || "no test runner"}, ${x.testFiles} test file(s), logic files with a test ${x.covered}/${x.logicFiles}${x.coverage ? `, line coverage ${x.coverage.pct.toFixed(0)}%` : ""}`) },
  metrics: { flag: "metricsCheck", gate: "Code Metrics", run: scanMetrics, render: renderMetrics, out: "metrics.md",
    summary: (r) => r.services.map((x) => `${x.name}: ${x.src.files} files, ${x.src.code} source LOC, ${x.test.code} test LOC${x.complex[0] ? `, most complex: ${x.complex[0].name} (${x.complex[0].complexity})` : ""}`) },
  design: { flag: "designCheck", gate: "Software Design", run: scanDesign, render: renderDesign, out: "design.md",
    summary: (r) => [...r.services.map((x) => `${x.name}: ${x.modules.length} modules, ${x.cycles.length} cycle(s)`), `data model: ${r.models.length ? r.models.map((m) => m.name).join(", ") : "no models found"}`] },
  structure: { flag: "structureCheck", gate: "Code Structure", run: checkStructure, render: renderStructure, out: "structure.md" }
};

export function runCheck(cwd, key, { write = true } = {}) {
  const c = CHECKS[key];
  const res = c.run(cwd);
  if (write && !(key === "cloud" && !res.cloud.providers.length && !res.findings.length)) { fs.mkdirSync(path.join(cwd, ".ai"), { recursive: true }); fs.writeFileSync(path.join(cwd, ".ai", c.out), c.render(res)); }
  return res;
}

// Which checks make sense for this project (used by `init` to set config defaults).
export function defaultFlags(services, cwd) {
  const web = services.some((s) => s.kind === "api" || s.framework === "next"), mobile = services.some((s) => s.kind === "mobile");
  const cloud = cwd ? detectCloud(cwd).providers.length > 0 : false;
  const code = services.some((s) => s.kind !== "lib");
  return { ...(cloud ? { cloudCheck: true } : {}), ...(code ? { testCheck: true, metricsCheck: true } : {}), ...(web ? { apiCheck: true, dbCheck: true } : {}), ...(web || mobile ? { structureCheck: true } : {}) };
}
