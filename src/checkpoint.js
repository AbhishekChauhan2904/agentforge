import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const IDENT = { GIT_AUTHOR_NAME: "agentforge", GIT_AUTHOR_EMAIL: "agentforge@local", GIT_COMMITTER_NAME: "agentforge", GIT_COMMITTER_EMAIL: "agentforge@local" };
const git = (args, cwd, env = {}) => spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } });
// Agent config/reports are never touched by rollback.
const PROTECTED = [".ai", ".cursor", ".opencode", ".gemini", "GEMINI.md"];
const isProtected = (p) => PROTECTED.some((x) => p === x || p.startsWith(x + "/"));
const MAX_AGE_DAYS = 7;

export function isRepo(cwd) { return git(["rev-parse", "--is-inside-work-tree"], cwd).status === 0; }

// Build a tree object of the CURRENT working directory (tracked + untracked, respecting .gitignore)
// using a throwaway index, so the user's real index is never modified.
function worktreeTree(cwd) {
  const idx = path.join(os.tmpdir(), `agentforge-idx-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: idx };
  try {
    git(["read-tree", "HEAD"], cwd, env);
    git(["add", "-A"], cwd, env);
    const r = git(["write-tree"], cwd, env);
    if (r.status !== 0) throw new Error("Could not snapshot the working directory: " + r.stderr.trim());
    return r.stdout.trim();
  } finally { fs.rmSync(idx, { force: true }); }
}

export function createCheckpoint(cwd, label = "") {
  if (!isRepo(cwd)) throw new Error("Not a git repository. Run `git init` and make one commit first.");
  if (git(["rev-parse", "HEAD"], cwd).status !== 0) throw new Error("Repository has no commits yet. Make an initial commit first.");
  const tree = worktreeTree(cwd);
  const c = git(["commit-tree", tree, "-p", "HEAD", "-m", `agentforge checkpoint ${label}`.trim()], cwd, IDENT);
  if (c.status !== 0) throw new Error(c.stderr.trim());
  const commit = c.stdout.trim();
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const tag = `ai-checkpoint-${stamp}${label ? "-" + label.replace(/[^a-z0-9]+/gi, "-") : ""}`;
  const t = git(["tag", tag, commit], cwd);
  if (t.status !== 0) throw new Error(t.stderr.trim());
  return { tag, commit: commit.slice(0, 8) };
}

export function listCheckpoints(cwd) {
  return git(["tag", "--list", "ai-checkpoint-*"], cwd).stdout.split("\n").filter(Boolean);
}

// Work out exactly what a rollback would change, without changing anything.
export function planRollback(cwd, tag, { force = false } = {}) {
  const tags = listCheckpoints(cwd);
  const target = tag || tags[tags.length - 1];
  if (!target || !tags.includes(target)) throw new Error("No matching checkpoint. Run `agentforge checkpoints` to list them.");
  const ageDays = (Date.now() / 1000 - Number(git(["log", "-1", "--format=%ct", target], cwd).stdout.trim())) / 86400;
  if (ageDays > MAX_AGE_DAYS && !force) throw new Error(`Checkpoint is ${Math.floor(ageDays)} days old. Use --force if you really want to restore it.`);
  const diff = git(["diff-tree", "-r", "--name-status", "--no-renames", `${target}^{tree}`, worktreeTree(cwd)], cwd);
  const toDelete = [], toRestore = [];
  for (const line of diff.stdout.split("\n").filter(Boolean)) {
    const [status, ...rest] = line.split("\t");
    const file = rest.join("\t");
    if (isProtected(file)) continue;
    (status === "A" ? toDelete : toRestore).push(file); // A = created since checkpoint
  }
  return { target, toDelete, toRestore };
}

export function rollback(cwd, tag, opts = {}) {
  const plan = planRollback(cwd, tag, opts);
  for (let i = 0; i < plan.toRestore.length; i += 100) {
    const r = git(["restore", `--source=${plan.target}`, "--worktree", "--", ...plan.toRestore.slice(i, i + 100)], cwd);
    if (r.status !== 0) throw new Error(r.stderr.trim());
  }
  for (const f of plan.toDelete) fs.rmSync(path.join(cwd, f), { force: true });
  git(["reset", "-q"], cwd); // drop stale staging entries; working files are untouched
  return plan;
}
