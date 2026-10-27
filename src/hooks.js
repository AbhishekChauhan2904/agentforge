import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const MARK = "# agentforge-managed-hook";
const CLI = fileURLToPath(new URL("../bin/cli.js", import.meta.url));

function hookFile(cwd) {
  const r = spawnSync("git", ["rev-parse", "--git-path", "hooks"], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error("Not a git repository.");
  return path.join(path.resolve(cwd, r.stdout.trim()), "pre-commit");
}

export function installHook(cwd, { force = false } = {}) {
  const file = hookFile(cwd);
  if (fs.existsSync(file) && !fs.readFileSync(file, "utf8").includes(MARK) && !force)
    throw new Error("A pre-commit hook already exists. Use --force to replace it.");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${MARK}\n[ -n "$AGENTFORGE_SKIP" ] && exit 0\nnode "${CLI}" gate || { echo "agentforge: quality gate blocked this commit (set AGENTFORGE_SKIP=1 to bypass)"; exit 1; }\n`, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

export function removeHook(cwd) {
  const file = hookFile(cwd);
  if (!fs.existsSync(file) || !fs.readFileSync(file, "utf8").includes(MARK)) return false;
  fs.rmSync(file);
  return true;
}

export function hookInstalled(cwd) {
  try { const f = hookFile(cwd); return fs.existsSync(f) && fs.readFileSync(f, "utf8").includes(MARK); } catch { return false; }
}
