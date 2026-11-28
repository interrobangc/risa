// docs-budget.mjs: byte budgets for the generic role docs (loops/docs/). Each role's
// doc is the generic half of a split role; a project's additions take the rest of
// the role's budget (15 KB for most). Run as a script it prints each doc over its
// budget and exits 1; imported (`risa/loops/docs-budget.mjs`) it only exports BUDGETS
// and overBudget, so a project can check its role halves add up.
//   node loops/docs-budget.mjs
import { readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KB = 1024;
const DOCS = join(dirname(fileURLToPath(import.meta.url)), "docs");

export const BUDGETS = {
  "backlog.md": 3 * KB,
  "hotfix.md": 3 * KB,
  "inbox.md": 2 * KB + 8,
  "loop.md": 2230,
  "machinery.md": 2397,
  "orchestration.md": 174,
  "orchestrator.md": 4810,
  "planner.md": 5 * KB + 16,
  "project-config.md": 1 * KB,
  "recovery.md": 5 * KB + 4,
  "ship.md": 1 * KB,
};

/**
 * The over-budget lines for the role docs in a folder: each doc over its budget, and
 * each doc with no budget at all. Reads only; prints nothing.
 * @param {string} dir the folder of role docs
 * @param {string} [shown] the folder's name in the lines
 * @returns {string[]}
 */
export function overBudget(dir, shown = dir) {
  const over = [];
  for (const name of readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()) {
    const bytes = statSync(join(dir, name)).size;
    const budget = BUDGETS[/** @type {keyof typeof BUDGETS} */ (name)];
    if (budget === undefined) over.push(`${shown}/${name}: no budget (add one to loops/docs-budget.mjs)`);
    else if (bytes > budget) over.push(`${shown}/${name}: ${bytes} B, over its ${budget} B`);
  }
  return over;
}

const isMain = () => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  const over = overBudget(DOCS, "loops/docs");
  if (over.length) {
    for (const line of over) console.log(line);
    process.exit(1);
  }
  console.log("docs budget: every generic role doc is within its budget");
}
