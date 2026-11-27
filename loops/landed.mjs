// A prd/ branch's last landing in the trunk, and what the branch carries past
// it (B-431: planner-3's orchestrator committed its 'landed' status after the
// final land, so rm kept the branch, never set done, and the dispatcher started
// the topic nine times over).
//
//   - lastLanding(repo, branch, trunk): the trunk's newest first-parent merge
//     whose second parent is on the branch's own first-parent line (its own
//     commits, not the trunk's), or null when the branch never landed. A slice
//     merge or a dev sync on the branch is first-parent there too, so a sync
//     after the landing still finds it.
//   - tailOf(repo, branch, trunk, topic): the kind of the branch past that
//     landing: `merged` (the trunk has all of it), `unlanded` (no landing),
//     `empty` (commits whose diff is nothing), `plan` (only its own plan file:
//     the status after the landing, dropped), `docs` (Markdown only: landed by
//     rm), `code` (anything else: the topic isn't finished).
//   - landedTopics(repo, topics, trunk): for the dispatcher's guard, the topics
//     whose last landing is in the trunk, with nothing but docs past it and no
//     slice left in the branch's plan: { [topic]: { sha } }.
//   - slicesLeft(planText): the slices the plan's _Status_ table still has to
//     run (any State that isn't finished: merged, landed, done, dropped, moved,
//     split out, cut, skipped), or null when _Status_ has no slice table to read.
//   - doneFlags(rows, topic): the flags rm and land write to mark TOPIC done
//     (its flags plus done, less hold), or why they write none: no row, a
//     standing topic, or already done. (rotate.mjs re-exports both.)
//   - itemsLeft(items): the ids of a topic's items that aren't finished (landed,
//     staging, live or dropped), from `backlog list --all --prd <t> --json`.
//
// CLI:
//   node landed.mjs tail <repo> <branch> <trunk> <topic>
//       → one line: <kind> <landing sha or -> <commits past it>
//   node landed.mjs slices-left <plan file>   the slices left, one line, space-
//       separated (empty: none); exit 2 when there is no table to read
//   node landed.mjs done-flags <topic>        stdin: `backlog prd list
//       --json`; prints the flags to set (exit 0), or why not (exit 1)
//   node landed.mjs items-left        stdin: the items' JSON; prints the ids
//                                      left (exit 1), or nothing (exit 0)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { branchKinds } from "./config.mjs";

/** A State that means the slice has nothing left to run. */
const FINISHED = /^(merged|landed|done|dropped|moved|split out|cut|skipped)\b/i;

/** A table row's cells: "| a | b |" → ["a", "b"]. */
const cells = (/** @type {string} */ line) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/** The _Status_ section's slice table as {slice, state} rows, or null when it has none. */
export function sliceStates(/** @type {string} */ planText) {
  const m = /^## Status[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(planText ?? "");
  if (!m) return null;
  const lines = m[1].split("\n").filter((l) => l.trim().startsWith("|"));
  const head = lines.findIndex((l) => /^slice$/i.test(cells(l)[0] ?? ""));
  if (head < 0) return null;
  const col = cells(lines[head]).findIndex((c) => /^state$/i.test(c));
  if (col < 0) return null;
  return lines
    .slice(head + 1)
    .map(cells)
    .filter((c) => /^\d+$/.test(c[0] ?? ""))
    .map((c) => ({ slice: c[0], state: (c[col] ?? "").replace(/[*_`✅]/g, "").trim() }));
}

/** The slices still to run, or null when the plan's _Status_ has no slice table. */
export function slicesLeft(/** @type {string} */ planText) {
  const rows = sliceStates(planText);
  if (!rows) return null;
  return rows.filter((r) => !FINISHED.test(r.state)).map((r) => r.slice);
}

/**
 * @param {{ topic: string, flags: string[] }[]} rows the registry (`prd list --json`)
 * @param {string} topic
 * @returns {{ flags: string[] } | { skip: string }}
 */
export function doneFlags(rows, topic) {
  const row = rows.find((r) => r.topic === topic);
  if (!row) return { skip: `the PRD table has no row ${topic}` };
  if (row.flags.includes("standing")) return { skip: `${topic} is standing: it never finishes` };
  if (row.flags.includes("done")) return { skip: `${topic} is already done` };
  return { flags: [...row.flags.filter((f) => f !== "hold"), "done"] };
}

/** The backlog statuses that need no more work (backlog/format.mjs FINISHED). */
const ITEM_FINISHED = ["landed", "staging", "live", "dropped"];

const git = (/** @type {string} */ repo, /** @type {string[]} */ args) =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
const tryGit = (/** @type {string} */ repo, /** @type {string[]} */ args) => {
  try {
    return git(repo, args);
  } catch {
    return null;
  }
};
const lines = (/** @type {string | null} */ s) => (s ? s.split("\n").filter(Boolean) : []);

/**
 * The trunk's history the landing search reads, once for many branches.
 * @param {string} repo @param {string} trunk
 */
function trunkFacts(repo, trunk) {
  return {
    firstParent: new Set(lines(tryGit(repo, ["rev-list", "--first-parent", trunk, "--"]))),
    merges: lines(tryGit(repo, ["rev-list", "--first-parent", "--merges", "--parents", trunk, "--"])).map(
      (l) => l.split(" "),
    ),
  };
}

/**
 * @param {string} repo @param {string} branch @param {ReturnType<typeof trunkFacts>} t
 * @returns {{ sha: string, tip: string } | null} the landing merge, and the branch's tip it brought
 */
function landingIn(repo, branch, t) {
  const own = new Set(
    lines(tryGit(repo, ["rev-list", "--first-parent", branch, "--"])).filter((c) => !t.firstParent.has(c)),
  );
  if (!own.size) return null;
  const m = t.merges.find((parts) => parts.slice(2).some((p) => own.has(p)));
  return m ? { sha: m[0], tip: m.slice(2).find((p) => own.has(p)) ?? "" } : null;
}

/** @param {string} repo @param {string} branch @param {string} trunk */
export function lastLanding(repo, branch, trunk) {
  return landingIn(repo, branch, trunkFacts(repo, trunk));
}

/**
 * @typedef {"merged" | "unlanded" | "empty" | "plan" | "docs" | "code"} TailKind
 * @param {string} repo @param {string} branch @param {string} trunk @param {string} topic
 * @param {ReturnType<typeof trunkFacts>} [t]
 * @returns {{ kind: TailKind, landing: string | null, commits: number, files: string[] }}
 */
export function tailOf(repo, branch, trunk, topic, t = trunkFacts(repo, trunk)) {
  const landing = landingIn(repo, branch, t)?.sha ?? null;
  const commits = Number(tryGit(repo, ["rev-list", "--count", `${trunk}..${branch}`, "--"]) ?? NaN);
  if (commits === 0) return { kind: "merged", landing, commits, files: [] };
  if (!landing) return { kind: "unlanded", landing, commits, files: [] };
  // Three dots: the branch's own changes since it and the trunk last met (a sync after the landing included).
  const files = lines(tryGit(repo, ["diff", "--name-only", "--no-renames", `${trunk}...${branch}`, "--"]));
  /** @type {TailKind} */
  const kind = !files.length
    ? "empty"
    : files.every((f) => f === `plans/${topic}-plan.md`)
      ? "plan"
      : files.every((f) => f.endsWith(".md"))
        ? "docs"
        : "code";
  return { kind, landing, commits, files };
}

/**
 * The topics the dispatcher must never start or reopen: a prd/ branch whose last
 * landing is in the trunk, nothing but docs past it, and no slice left in its
 * plan (the branch's copy). A topic with no branch, no landing or no _Status_
 * table isn't one. Never throws: an unreadable repo gives {}.
 * @param {string} repo @param {string[]} topics @param {string} [trunk]
 * @returns {Record<string, { sha: string }>}
 */
export function landedTopics(repo, topics, trunk) {
  /** @type {Record<string, { sha: string }>} */
  const out = {};
  if (!topics.length) return out;
  try {
    const kinds = branchKinds();
    const tr = trunk ?? kinds.trunk;
    let t = null;
    for (const topic of topics) {
      const branch = kinds.branch("prd", topic);
      if (!tryGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) continue;
      t ??= trunkFacts(repo, tr);
      const tail = tailOf(repo, branch, tr, topic, t);
      if (!tail.landing || tail.kind === "unlanded" || tail.kind === "code") continue;
      const left = slicesLeft(tryGit(repo, ["show", `${branch}:plans/${topic}-plan.md`]) ?? "");
      if (left && !left.length) out[topic] = { sha: tail.landing };
    }
  } catch {
    /* the repo can't be read: no guard, as before */
  }
  return out;
}

/** The ids of the items not finished. @param {{ id: string, status: string }[]} items */
export function itemsLeft(items) {
  return items.filter((i) => !ITEM_FINISHED.includes(i.status)).map((i) => i.id);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "tail" && args.length === 4) {
    const [repo, branch, trunk, topic] = /** @type {[string, string, string, string]} */ (args);
    const t = tailOf(repo, branch, trunk, topic);
    console.log(`${t.kind} ${t.landing ?? "-"} ${t.commits}`);
  } else if (cmd === "slices-left") {
    let text = "";
    try {
      text = readFileSync(args[0] ?? "", "utf8");
    } catch {
      /* no plan: no table */
    }
    const left = slicesLeft(text);
    if (!left) process.exit(2);
    console.log(left.join(" "));
  } else if (cmd === "done-flags") {
    const d = doneFlags(JSON.parse(readFileSync(0, "utf8")), args[0] ?? "");
    if ("skip" in d) {
      console.log(d.skip);
      process.exit(1);
    }
    console.log(d.flags.join(","));
  } else if (cmd === "items-left") {
    const left = itemsLeft(JSON.parse(readFileSync(0, "utf8")));
    if (left.length) {
      console.log(left.join(", "));
      process.exit(1);
    }
  } else {
    console.error(
      "usage: landed.mjs tail <repo> <branch> <trunk> <topic> | slices-left <plan> | done-flags <topic> | items-left",
    );
    process.exit(2);
  }
}
