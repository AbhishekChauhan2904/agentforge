import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const RULES = [
  { rule: "AWS access key", re: /AKIA[0-9A-Z]{16}/ },
  { rule: "AWS secret access key", re: /aws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9\/+=]{40}/i },
  { rule: "Azure storage account key", re: /AccountKey=[A-Za-z0-9+\/=]{40,}/ },
  { rule: "Azure SAS token", re: /[?&]sv=\d{4}-\d{2}-\d{2}[^'"\s]*&sig=[A-Za-z0-9%+\/=]{20,}/ },
  { rule: "Private key block", re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { rule: "Hardcoded JWT secret", re: /jwt[_-]?secret\s*[:=]\s*['"][^'"]{6,}['"]/i },
  { rule: "Generic API key/token", re: /(api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9_\-\/+=]{16,}['"]/i },
  { rule: "MongoDB URI with password", re: /mongodb(\+srv)?:\/\/[^:\s]+:[^@\s]+@/ }
];
const SKIP_EXT = /\.(png|jpe?g|gif|ico|pdf|zip|lock|woff2?|ttf|mp4|svg)$/i;

function listFiles(cwd) {
  const git = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd, encoding: "utf8" });
  if (git.status === 0) return git.stdout.split("\n").filter(Boolean);
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(cwd, d), { withFileTypes: true })) {
      if (["node_modules", ".git"].includes(e.name)) continue;
      const rel = path.join(d, e.name);
      e.isDirectory() ? walk(rel) : out.push(rel);
    }
  };
  walk("");
  return out;
}

export function scanSecrets(cwd) {
  const hits = [];
  for (const rel of listFiles(cwd)) {
    if (SKIP_EXT.test(rel) || rel.startsWith(".ai/") || rel.includes("package-lock")) continue;
    if (/(^|\/)\.env$/.test(rel)) { hits.push({ file: rel, line: 1, rule: ".env file is not git-ignored" }); continue; }
    let text;
    try { text = fs.readFileSync(path.join(cwd, rel), "utf8"); } catch { continue; }
    text.split("\n").forEach((line, i) => {
      for (const { rule, re } of RULES) if (re.test(line)) { hits.push({ file: rel, line: i + 1, rule }); break; }
    });
  }
  return hits;
}
