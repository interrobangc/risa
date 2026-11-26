// The landing gate's decision: what a verdict means for this branch at this tier.
// Pure: `ci gate` (ci.mjs) finds the verdict, runs blame when it's needed, and
// acts on what this returns. The code is the verdict kind's exit code, 0 to land.
import { label } from "./blame.mjs";
import { proposedTiers, tierRank } from "../loops/check-plan.mjs";
import { ciTiers } from "./tier-data.mjs";

const CODE = { land: 0, brake: 1, branch: 2, infra: 4, unknown: 5, time: 6 };

/**
 * A whole-tier verdict that ran this tier or higher, and not a proof run's. `ranTier`,
 * not `tier`: a `full` request from before its jobs existed ran less than it asked for.
 * @param {any} v
 * @param {string} tier
 */
export function verdictMeets(v, tier) {
  if (!v || v.narrowed || v.forcedFlake || typeof v.ranTier !== "string") return false;
  const ran = ciTiers().TIERS.indexOf(v.ranTier);
  const needed = ciTiers().TIERS.indexOf(/** @type {any} */ (tier));
  return ran >= 0 && needed >= 0 && ran >= needed;
}

/**
 * Whether a verdict lets this exact commit through a release gate: a whole-tier run
 * of the tier or higher that is `green`, or a `flake` with nothing on the brake list.
 * A flake that can't show its list doesn't pass.
 * @param {any} v
 * @param {string} tier
 * @param {string} sha
 * @returns {{ pass: boolean, why: string }}
 */
export function releasePasses(v, tier, sha) {
  const no = (/** @type {string} */ why) => ({ pass: false, why });
  if (!v) return no(`no ${tier} verdict`);
  if (v.commit !== sha) return no(`the verdict is for another commit (${String(v.commit).slice(0, 8)})`);
  if (v.narrowed) return no("the verdict is from a narrowed run");
  if (v.forcedFlake) return no("the verdict is from a proof run");
  if (!verdictMeets(v, tier)) return no(`the run reached ${v.ranTier ?? "no tier"}, below ${tier}`);
  if (v.kind !== "green" && v.kind !== "flake") return no(`the verdict is ${v.kind}`);
  const flaky = v.flaky ?? [];
  if (!Array.isArray(flaky)) return no("the verdict's flaky list can't be read");
  const braked = flaky.filter((/** @type {{ brake?: unknown }} */ t) => t.brake !== false);
  if (braked.length)
    return no(
      `flaky on the brake list: ${braked.map((/** @type {{ file: string }} */ t) => t.file).join(", ")}`,
    );
  if (v.kind === "flake" && !flaky.length) return no("a flake verdict that names no flaky test");
  return { pass: true, why: v.kind };
}

/**
 * Whether a verdict from before a dev sync can vouch for the synced tip beside a
 * recheck: one that lands with no blame (green, or a flake outside the branch's files).
 * @param {any} v
 * @param {string[]} touched
 */
export const carries = (v, touched) =>
  v.kind === "green" || (v.kind === "flake" && !touchedFlakes(v, touched).length);

/**
 * @typedef {{ verdict: any, run: any }} Found
 * @typedef {{ verdict: any, run: any, carried: Found | null, need: string }} Walked
 */

/**
 * The verdicts that vouch for the tip at this tier, walking first-parent commits
 * from it. A verdict of the tier on the tip, or behind only commits that keep one
 * (docs, tooling, CI's lists, a sync that brought only those), is the verdict. Behind
 * a dev sync that brought more, the pre-sync verdict is carried when it lands with no
 * blame, and the tip needs a recheck at the tier the syncs brought (syncTier),
 * found on a commit no newer sync follows. A sync that brought the tier or more asks
 * for the tier itself on the tip, as before.
 * `need` is the tier to request when `verdict` is null.
 * @param {{ commits: string[], tier: string, touched: string[],
 *   verdictAt: (sha: string, tier: string) => Found | null,
 *   changeOf: (sha: string) => string | null }} request `verdictAt` is null when
 *   GitHub can't be read; `changeOf` is a commit's own tier (none keeps a verdict), null for
 *   one no carry crosses
 * @returns {Walked | null} null when GitHub can't be read
 */
export function walkVerdicts({ commits, tier, touched, verdictAt, changeOf }) {
  const none = { verdict: null, run: null, carried: null, need: tier };
  /** @type {{ sha: string, rank: number }[]} */ const steps = [];
  /** @type {Found | null} */ let base = null;
  for (const sha of commits) {
    const found = verdictAt(sha, tier);
    if (found === null) return null;
    if (found.verdict) {
      base = found;
      break;
    }
    const change = changeOf(sha);
    if (change === null || tierRank(change) < 0) break;
    steps.push({ sha, rank: tierRank(change) });
  }
  if (!base) return none;
  const demand = Math.max(0, ...steps.map((s) => s.rank));
  if (!demand) return { ...base, carried: null, need: tier };
  // Never above the declared tier: dev's own landing vouched for its files alone.
  if (demand >= tierRank(tier)) return none;
  const need = /** @type {string} */ (proposedTiers()[demand]);
  if (!carries(base.verdict, touched)) return none;
  const newest = steps.findIndex((s) => s.rank > 0);
  for (const { sha } of steps.slice(0, newest + 1)) {
    const found = verdictAt(sha, need);
    if (found === null) return null;
    if (found.verdict) return { ...found, carried: base, need };
  }
  return { verdict: null, run: null, carried: base, need };
}

/** Blame is worth running only on a failure that a flake in the branch's files hasn't already refused. */
export const needsBlame = (/** @type {any} */ v, /** @type {string[]} */ touched) =>
  (v.kind === "file" || v.kind === "brake") && !touchedFlakes(v, touched).length;

/** @returns {{ file: string, name?: string | null }[]} */
const touchedFlakes = (/** @type {any} */ v, /** @type {string[]} */ touched) =>
  (v.flaky ?? []).filter((/** @type {{ file: string }} */ t) => touched.includes(t.file));

/**
 * Whether the BRANCH's verdict calls this failure a brake. Blame's own `brake`
 * flag is dev's verdict's, and dev may run a brake list that lacks the file.
 * @param {any} v
 * @param {import("./blame.mjs").Failure} f
 */
export function branchBrake(v, f) {
  if (!f.file) return (v.brake?.jobs ?? []).includes(f.job);
  return (
    (v.brake?.files ?? []).includes(f.file) ||
    (v.brake?.tests ?? []).some(
      (/** @type {import("./blame.mjs").Failure} */ t) => t.file === f.file && (!f.name || t.name === f.name),
    )
  );
}

/**
 * @typedef {{ code: number, split: import("./blame.mjs").Split, ids: Map<string, string> }} Blamed
 * @param {{ verdict: any, tier: string, branch: string, touched: string[], blamed?: Blamed | null, fixes?: string[] }} request
 * @returns {{ land: boolean, code: number, lines: string[], fileFlakes: boolean }}
 */
export function decideGate({ verdict, tier, branch, touched, blamed = null, fixes = [] }) {
  const retry = `pnpm prd ci run ${tier} --ref ${branch} --wait`;
  const refuse = (/** @type {number} */ code, /** @type {string[]} */ lines) => ({
    land: false,
    code,
    lines,
    fileFlakes: false,
  });
  const land = (/** @type {string[]} */ lines) => ({
    land: true,
    code: CODE.land,
    lines,
    fileFlakes: (verdict.flaky ?? []).length > 0,
  });
  const names = (/** @type {import("./blame.mjs").Failure[]} */ list) => list.map((f) => `  ${label(f)}`);

  if (verdict.kind === "green") return land([`green at ${verdict.ranTier}`]);
  if (verdict.kind === "infra")
    return refuse(CODE.infra, [`infra: the run died before its tests. Retry: ${retry}`]);
  // Never blamed, never a flake: the tests passed and a timed step ran past its armed cutoff.
  if (verdict.kind === "time")
    return refuse(CODE.time, [
      `time: past an armed cutoff in ${(verdict.time?.jobs ?? []).join(", ") || "a timed step"}; its tests passed. Trim the step, then: ${retry}`,
    ]);
  if (!["flake", "file", "brake"].includes(verdict.kind))
    return refuse(CODE.unknown, [`an unknown verdict (${verdict.kind}). Retry: ${retry}`]);

  const ownFlakes = touchedFlakes(verdict, touched);
  if (ownFlakes.length)
    return refuse(CODE.branch, ["flaky in files this branch touched:", ...names(ownFlakes)]);
  if (verdict.kind === "flake") return land(["flake: none in this branch's files; filed after the merge"]);

  if (!blamed) return refuse(CODE.unknown, [`${verdict.kind}: blame could not run. Retry: ${retry}`]);
  const { split, ids } = blamed;
  if (blamed.code === 2) return refuse(CODE.branch, ["this branch's failures:", ...names(split.branch)]);
  if (blamed.code !== 0 || !split.dev.length)
    return refuse(CODE.unknown, [
      `${verdict.kind}: blame can't say whose these are, so they aren't dev's. Retry: ${retry}`,
      ...names(split.unknown),
    ]);
  const unfiled = split.dev.filter((f) => !ids.get(f.key));
  if (unfiled.length)
    return refuse(CODE.unknown, ["dev's failures that have no backlog item:", ...names(unfiled)]);
  const open = split.dev.filter((f) => branchBrake(verdict, f) && !fixes.includes(`${ids.get(f.key)}`));
  if (open.length)
    return refuse(CODE.brake, [
      "a brake on dev; a landing that fixes it passes --fixes <item>:",
      ...open.map((f) => `  ${label(f)} (${ids.get(f.key)})`),
    ]);
  return land([`${verdict.kind}: every failure is dev's`, ...names(split.dev)]);
}
