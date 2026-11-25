// The requested CI runs with no verdict yet: what holds a topic's rotation and
// its merged slice worktrees. A run is out while its ci/<tier>/<name> ref's commit
// has a run going, or none yet. A finished run isn't out, cancelled included: there
// is nothing left to wait for.
//
//   node outstanding.mjs <topic> [dir]   (dir: the repo to ask)
//                                  one line per run; exit 0 none, 10 some (a crash's
//                                  1 must not read as an answer), 5 GitHub unreadable
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { tierData } from "./tier-data.mjs";

const { parseCiRef } = tierData();

/**
 * @typedef {{ ok: boolean, out: string }} Result
 * @typedef {{ git: (args: string[]) => Result, gh: (args: string[]) => Result }} OutstandingIo
 * @typedef {{ ref: string, name: string, sha: string, run: number | null, url: string | null }} Outstanding
 */

/**
 * Every outstanding run. A repo with no origin has none; null when GitHub can't
 * be read, so a caller never treats "don't know" as "nothing is out".
 * @param {OutstandingIo} io
 * @returns {Outstanding[] | null}
 */
export function outstandingRuns(io) {
  if (!io.git(["remote", "get-url", "origin"]).ok) return [];
  const listed = io.git(["ls-remote", "origin", "refs/heads/ci/*"]);
  if (!listed.ok) return null;
  /** @type {Outstanding[]} */ const out = [];
  for (const line of listed.out.split("\n").filter(Boolean)) {
    const [sha = "", full = ""] = line.split(/\s+/);
    const ref = full.replace(/^refs\/heads\//, "");
    const parsed = parseCiRef(ref);
    if (!parsed) continue;
    const r = io.gh([
      "run",
      "list",
      "--branch",
      ref,
      "--limit",
      "5",
      "--json",
      "databaseId,headSha,status,url,workflowName",
    ]);
    if (!r.ok) return null;
    /** @type {{ databaseId: number, headSha: string, status: string, url?: string, workflowName?: string }[]} */
    let runs;
    try {
      runs = JSON.parse(r.out || "[]");
    } catch {
      return null;
    }
    const ours = runs.filter((x) => x.headSha === sha && x.workflowName === "CI");
    const going = ours.find((x) => x.status !== "completed");
    if (ours.length && !going) continue;
    out.push({ ref, name: parsed.name, sha, run: going?.databaseId ?? null, url: going?.url ?? null });
  }
  return out;
}

/** Whether a ci ref's name belongs to the topic: its PRD branch or one of its slices, narrowed or not. */
export function isTopicRun(/** @type {string} */ name, /** @type {string} */ topic) {
  const base = name.replace(/-narrowed-[0-9a-f]+$/, "");
  if (base === `prd-${topic}`) return true;
  const prefix = `slice-${topic}-`;
  return base.startsWith(prefix) && /^\d+$/.test(base.slice(prefix.length));
}

/** One line for a refusal or a list: the ref and its run. */
export const describeRun = (/** @type {Outstanding} */ r) =>
  `${r.ref} (${r.url ?? (r.run ? `run ${r.run}` : "no run started yet")})`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const command = (/** @type {string} */ bin, /** @type {string[]} */ args) => {
    const r = spawnSync(bin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      cwd: process.argv[3],
    });
    return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
  };
  const topic = process.argv[2];
  if (!topic) {
    console.error("usage: outstanding.mjs <topic>");
    process.exit(64);
  }
  const all = outstandingRuns({ git: (a) => command("git", a), gh: (a) => command("gh", a) });
  if (all === null) process.exit(5);
  const ours = all.filter((r) => isTopicRun(r.name, topic));
  for (const r of ours) console.log(describeRun(r));
  process.exit(ours.length ? 10 : 0);
}
