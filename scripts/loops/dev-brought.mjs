// What dev brought since a branch last synced, and whether it touches the branch.
// `land` reads the verdict to decide whether a drifted branch may land unsynced.
//   node dev-brought.mjs --repo DIR --dev REF --tip REF   → the verdict as JSON
// It exits 0 with a verdict, refusals included, and 2 on a bad command line.
// Anything git can't answer is a refusal (`answered: false`), never a pass. Diffs
// use --no-renames, so a file dev renamed shows on dev's side under both paths.
// Markdown both sides changed isn't shared: no check reads it, and a conflict in it
// stops the landing's merge anyway. What counts as risky is the check plan's
// (check-plan.mjs: the project's rules).
import { execFileSync } from "node:child_process";
import { checkPlan } from "./check-plan.mjs";

/** pnpm backlog commits these onto dev; two branches sharing them means nothing. */
const BACKLOG = new Set(["plans/backlog.md", "plans/inbox.md", "plans/backlog-archive.md"]);

/** @param {string[]} items */
const andMore = (items) => (items.length > 1 ? ` and ${items.length - 1} more` : "");

/**
 * @typedef {{ answered: false, refusal: string }} Unanswered
 * @typedef {{
 *   answered: true, base: string, dev: string, tip: string,
 *   branchFiles: string[], devFiles: string[], commits: string[], drift: boolean,
 *   shared: string[], risky: { file: string, kind: string }[], refusal: string | null,
 * }} Answered
 */

/**
 * @param {string} repo a checkout that has both refs
 * @param {string} devRef dev's ref there
 * @param {string} tipRef the branch's tip
 * @param {{ plan?: import("./check-plan.mjs").CheckPlan }} [opts] the check plan whose
 *   rules say what is risky (default: this repo's)
 * @returns {Answered | Unanswered}
 */
export function devBrought(repo, devRef, tipRef, { plan = checkPlan() } = {}) {
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1 << 28,
    });
  const names = (/** @type {string} */ from, /** @type {string} */ to) =>
    git("diff", "--name-only", "--no-renames", "-z", from, to).split("\0").filter(Boolean);
  const commit = (/** @type {string} */ ref) => {
    try {
      return git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`).trim();
    } catch {
      return null;
    }
  };

  const dev = commit(devRef);
  if (!dev) return { answered: false, refusal: `${devRef} isn't in this checkout` };
  const tip = commit(tipRef);
  if (!tip) return { answered: false, refusal: `${tipRef} isn't in this checkout` };

  try {
    let bases;
    try {
      bases = git("merge-base", "--all", dev, tip).split("\n").filter(Boolean);
    } catch {
      return { answered: false, refusal: `${tipRef} shares no history with ${devRef}` };
    }
    // Criss-crossed merges: no single "last sync" to measure from.
    if (bases.length !== 1)
      return { answered: false, refusal: `${tipRef} has ${bases.length} merge bases with ${devRef}` };
    const [base] = /** @type {[string]} */ (bases);

    const branchFiles = names(base, tip);
    const devFiles = names(base, dev);
    const commits = git("rev-list", "--first-parent", `${base}..${dev}`).split("\n").filter(Boolean);
    const own = new Set(branchFiles);
    const shared = devFiles.filter((f) => own.has(f) && !BACKLOG.has(f) && !f.endsWith(".md"));
    const risky = devFiles.flatMap((file) => {
      const kind = plan.riskyKind(file);
      return kind ? [{ file, kind }] : [];
    });
    const drift = devFiles.some((f) => !BACKLOG.has(f) && !plan.isCiList(f));

    let refusal = null;
    if (shared.length) refusal = `${devRef} changed ${shared[0]}${andMore(shared)}, which the branch touches`;
    else if (risky.length) {
      const [first] = /** @type {[{ file: string, kind: string }]} */ (risky);
      refusal = `${devRef} brought ${first.kind} (${first.file})${andMore(risky)}`;
    }
    return { answered: true, base, dev, tip, branchFiles, devFiles, commits, drift, shared, risky, refusal };
  } catch {
    return { answered: false, refusal: `git couldn't compare ${tipRef} with ${devRef}` };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const flag = (/** @type {string} */ name) =>
    process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
  const [repo, dev, tip] = [flag("--repo"), flag("--dev"), flag("--tip")];
  if (!repo || !dev || !tip) {
    console.error("usage: dev-brought.mjs --repo DIR --dev REF --tip REF");
    process.exit(2);
  }
  console.log(JSON.stringify(devBrought(repo, dev, tip)));
}
