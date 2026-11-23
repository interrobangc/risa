// The landing gate's decision: what a verdict means for this branch at this tier.
// Pure: `ci gate` (ci.mjs) finds the verdict, runs blame when it's needed, and
// acts on what this returns. The code is the verdict kind's exit code, 0 to land.
import { label } from "./blame.mjs";
import { TIERS } from "./tiers.mjs";

const CODE = { land: 0, brake: 1, branch: 2, infra: 4, unknown: 5 };

/**
 * A whole-tier verdict that ran this tier or higher, and not a proof run's. `ranTier`,
 * not `tier`: a `full` request from before its jobs existed ran less than it asked for.
 * @param {any} v
 * @param {string} tier
 */
export function verdictMeets(v, tier) {
  if (!v || v.narrowed || v.forcedFlake || typeof v.ranTier !== "string") return false;
  const ran = TIERS.indexOf(v.ranTier);
  const needed = TIERS.indexOf(/** @type {any} */ (tier));
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
