import fs from "node:fs";
import path from "node:path";

export function readStats(cwd) {
  const file = path.join(cwd, ".ai/runs.jsonl");
  if (!fs.existsSync(file)) return null;
  const runs = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (!runs.length) return null;
  const blocked = runs.filter((r) => !r.passed);
  const byCheck = {};
  for (const r of blocked) for (const f of r.failed) byCheck[f] = (byCheck[f] || 0) + 1;
  return { total: runs.length, passed: runs.length - blocked.length, blocked: blocked.length, passRate: Math.round(((runs.length - blocked.length) / runs.length) * 100), byCheck, first: runs[0].ts, last: runs[runs.length - 1].ts };
}
