// docs-budget.mjs: byte budgets for the generic role docs (loops/docs/). Each role's
// doc is the generic half of a split role; a project's additions take the rest of
// the role's budget (15 KB for most). Prints each doc over its budget and exits 1.
//   node loops/docs-budget.mjs
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KB = 1024;
const DOCS = join(dirname(fileURLToPath(import.meta.url)), "docs");

export const BUDGETS = {
  "backlog.md": 3 * KB,
  "hotfix.md": 3 * KB,
  "inbox.md": 2 * KB,
  "loop.md": 2218,
  "machinery.md": 600,
  "orchestration.md": 174,
  "orchestrator.md": 3954,
  "planner.md": 5 * KB,
  "project-config.md": 1 * KB,
  "recovery.md": 5 * KB,
};

const over = [];
for (const name of readdirSync(DOCS)
  .filter((f) => f.endsWith(".md"))
  .sort()) {
  const bytes = statSync(join(DOCS, name)).size;
  const budget = BUDGETS[name];
  if (budget === undefined) over.push(`loops/docs/${name}: no budget (add one to loops/docs-budget.mjs)`);
  else if (bytes > budget) over.push(`loops/docs/${name}: ${bytes} B, over its ${budget} B`);
}
if (over.length) {
  for (const line of over) console.log(line);
  process.exit(1);
}
console.log("docs budget: every generic role doc is within its budget");
