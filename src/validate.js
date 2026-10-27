import fs from "node:fs";
import path from "node:path";
import { CONTRACTS } from "./registry.js";

// Checks that each active agent produced its contracted report with the required headings.
export function validateReports(cwd, agents, only = null) {
  const problems = [];
  const checked = [];
  for (const [agent, c] of Object.entries(CONTRACTS)) {
    if (only ? agent !== only : !agents.includes(agent)) continue;
    const file = path.join(cwd, ".ai/reports", c.file);
    checked.push(c.file);
    if (!fs.existsSync(file)) { problems.push(`${agent}: missing .ai/reports/${c.file}`); continue; }
    const text = fs.readFileSync(file, "utf8");
    if (text.trim().length < 80) { problems.push(`${agent}: ${c.file} is nearly empty`); continue; }
    for (const h of c.headings)
      if (!new RegExp(`^#{1,4}\\s*${h}`, "im").test(text)) problems.push(`${agent}: ${c.file} lacks a "${h}" section`);
    if (c.mermaid && !/```mermaid[\s\S]*?(flowchart|graph|sequenceDiagram|erDiagram)[\s\S]*?```/.test(text)) problems.push(`${agent}: ${c.file} needs a Mermaid diagram (a \`\`\`mermaid block)`);
    if (["qa", "security", "performance", "reviewer", "tester"].includes(agent) && /verdict[^\n]*\b(fail|blocked|reject|changes requested|not approved)/i.test(text))
      problems.push(`${agent}: verdict is negative (${c.file})`);
  }
  return { ok: problems.length === 0, problems, checked };
}
