// ci-status.mjs: part of `ci` (ci.mjs has the map). `ci status`: each
// branch's latest whole-tier verdict for `status`, through the status
// cache, short when GitHub is away.
import { EXIT, RUN_FIELDS, WORKFLOW_NAME } from "./ci-io.mjs";
import { readVerdict } from "./ci-runs.mjs";
import { ciTiers } from "./tier-data.mjs";

/**
 * @typedef {import("./ci-io.mjs").Io} Io
 * @typedef {import("./ci-io.mjs").Run} Run
 * @typedef {import("./ci-io.mjs").Cache} Cache
 */

/** `status` redraws every 5 s: GitHub is asked at most this often, and never for longer. */
const STATUS_TTL_MS = 30_000;
const STATUS_TIMEOUT_MS = 10_000;

/** A cached JSON file, or null when it's missing or broken. */
function cachedJson(/** @type {Cache | undefined} */ cache, /** @type {string} */ name) {
  try {
    return JSON.parse(cache?.read(name) ?? "null");
  } catch {
    return null;
  }
}

/**
 * `ci status`: one line per branch with a whole-tier verdict. One `gh run list`,
 * cached; verdicts cached by run and attempt. Prints nothing when GitHub is away.
 * @param {string[]} branches
 * @param {Io} io
 */
export function ciStatus(branches, io) {
  const cache = io.cache?.();
  const start = io.now();
  const held = cachedJson(cache, "runs.json");
  /** @type {Run[] | null} */ let runs = held && start - held.at < STATUS_TTL_MS ? held.runs : null;
  if (!runs) {
    const r = io.gh(["run", "list", "--limit", "100", "--json", RUN_FIELDS], STATUS_TIMEOUT_MS);
    if (!r.ok) return EXIT.green;
    try {
      runs = /** @type {Run[]} */ (JSON.parse(r.out || "[]")).filter((x) => x.workflowName === WORKFLOW_NAME);
    } catch {
      return EXIT.green;
    }
    cache?.write("runs.json", JSON.stringify({ at: start, runs }));
  }
  /** @type {string[]} */ const lines = [];
  for (const branch of new Set(branches)) {
    const name = branch.replaceAll("/", "-");
    const ours = /** @type {Run[]} */ (runs)
      .filter((x) => ciTiers().parseCiRef(x.headBranch ?? "")?.name === name)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const done = ours.find((x) => x.status === "completed" && x.conclusion !== "cancelled");
    const going = ours.some((x) => x.status !== "completed") ? " (a run is going)" : "";
    if (!done) {
      if (going) lines.push(`  ${branch}: running`);
      continue;
    }
    const slot = `v-${done.databaseId}-${done.attempt ?? 1}.json`;
    let v = cachedJson(cache, slot);
    const left = STATUS_TIMEOUT_MS - (io.now() - start);
    if (!v && left > 0) {
      const read = readVerdict(io, done.databaseId, left);
      if (read && !read.narrowed && !read.forcedFlake) {
        v = { kind: read.kind, tier: read.tier, commit: read.commit };
        cache?.write(slot, JSON.stringify(v));
      }
    }
    if (!v) lines.push(`  ${branch}: unknown (no verdict read)${going}`);
    else {
      const tip = io.git(["rev-parse", "--verify", "--quiet", `${branch}^{commit}`]).out;
      const stale = tip && tip !== v.commit ? ", not the tip" : "";
      lines.push(`  ${branch}: ${v.kind} · ${v.tier} · ${String(v.commit).slice(0, 8)}${stale}${going}`);
    }
  }
  if (lines.length) for (const line of ["CI (latest whole-tier verdicts)", ...lines]) io.log(line);
  return EXIT.green;
}
