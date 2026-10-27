import fs from "node:fs";
import path from "node:path";

// Architecture Decision Records: one short numbered file per significant design decision.
export function createAdr(cwd, title) {
  if (!title || !title.trim()) throw new Error('Usage: agentforge adr "Use PostgreSQL instead of MongoDB"');
  const dir = path.join(cwd, "docs/adr");
  fs.mkdirSync(dir, { recursive: true });
  const n = Math.max(0, ...fs.readdirSync(dir).map((f) => +(f.match(/^(\d{4})-/) || [])[1] || 0)) + 1;
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "decision";
  const id = String(n).padStart(4, "0"), file = path.join(dir, `${id}-${slug}.md`), date = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(file, `# ${n}. ${title.trim()}

- Status: Proposed
- Date: ${date}
- Deciders: <names>

## Context
What problem or force makes a decision necessary? Include constraints (team, deadline, scale, cost, security) and what you know today.

## Decision
We will ...

## Alternatives considered
- Option A: pros / cons
- Option B: pros / cons

## Consequences
What becomes easier, what becomes harder, what must we do next, and how would we reverse this?
`);
  const dec = path.join(cwd, ".ai/decisions.md");
  if (fs.existsSync(dec)) fs.appendFileSync(dec, `| ${date} | ${title.trim()} | ADR ${id}: docs/adr/${path.basename(file)} |\n`);
  return { id, file: path.relative(cwd, file) };
}
