#!/usr/bin/env node
// A ship (RISA-1053): one version through the project's phases, in order, each one
// of the project's hooks. The tool owns the order, the record, resuming and the
// report; the project owns the steps (its hooks know tags, package files and
// deploys; this module knows nothing of them).
//
//   PHASES                       check, ship, smoke, notify, each with its hook
//                                (shipCheck, ship, shipSmoke, shipNotify). Each hook
//                                is called with the version as its argument and
//                                RISA_SHIP_VERSION set, through hooks.mjs's runHook.
//   nextPhases(record, { from }) pure: { kept, run } (the results kept and the
//                                phases still to run), or { refused } for a finished
//                                record without --from, an unknown phase, or a
//                                --from past a phase that hasn't passed. --from drops
//                                that phase's result and every later one.
//   shipsDir()                   RISA_SHIPS_DIR, else the main checkout's .loops/.ships
//   readRecord / writeRecord     .ships/<version>.json: { version, startedAt,
//                                phases: [{ name, ok, at, facts, tail, skipped? }], doneAt }
//   takeLock / releaseLock       the folder's one .lock (pid and version), linked
//                                into place whole whatever the version: no two ships
//                                of a project at once. A dead pid's lock is taken over
//                                under .lock.takeover, so two takers never both win;
//                                an empty or unparsable lock is held, never dead.
//                                A rewound record (--from, or a finished one) is
//                                written before the first hook runs.
//   reportText(record, project)  pure: the report's text, finished or stopped
//   runShip(version, { dryRun, from })   the command; returns its exit code
//
// CLI: node ship.mjs <version> [--dry-run] [--from <phase>]   (prd ship; prd.sh sets
// RISA_ASKS_DIR and RISA_SHIPS_DIR). Generic pre-checks before any hook: the version
// has the config's version shape, the config sets hooks.ship, no other ship of the
// project runs, the version's record isn't finished. Each phase prints a line as it
// starts, then the hook's output; a missing optional hook prints `skipped`. Exit 0
// shipped, 1 a phase failed, 2 refused (usage, a pre-check, finished, running). One
// report (topic ship) in the asks when the ship finishes or a phase fails; --dry-run
// runs only the check phase, writes no record and files no report.
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createAsk } from "./asks.mjs";
import { isVersion, loadConfigOrExit, toolCmd } from "./config.mjs";
import { runHook } from "./hooks.mjs";
import { isMain } from "./is-main.mjs";

/** The phases, in order, and each one's hook. */
export const PHASES = Object.freeze([
  { name: "check", hook: "shipCheck" },
  { name: "ship", hook: "ship" },
  { name: "smoke", hook: "shipSmoke" },
  { name: "notify", hook: "shipNotify" },
]);
const NAMES = PHASES.map((p) => p.name);
/** How many of a failed hook's last output lines the record and report keep. */
export const TAIL_LINES = 20;

/**
 * @typedef {{ name: string, ok: boolean, at: string, facts: string[], tail: string[], skipped?: boolean }} PhaseResult
 * @typedef {{ version: string, startedAt: string, phases: PhaseResult[], doneAt: string | null }} ShipRecord
 */

/**
 * The phases still to run.
 * @param {ShipRecord | null | undefined} record
 * @param {{ from?: string }} [opts]
 * @returns {{ kept: PhaseResult[], run: string[] } | { refused: string }}
 */
export function nextPhases(record, { from } = {}) {
  const done = record?.phases ?? [];
  const passed = (/** @type {string} */ name) => done.some((p) => p.name === name && p.ok);
  if (from !== undefined) {
    const i = NAMES.indexOf(from);
    if (i < 0) return { refused: `no phase ${from} (the phases: ${NAMES.join(", ")})` };
    const missing = NAMES.slice(0, i).find((n) => !passed(n));
    if (missing) return { refused: `--from ${from}: ${missing} hasn't passed yet` };
    return { kept: done.filter((p) => NAMES.indexOf(p.name) < i), run: NAMES.slice(i) };
  }
  if (record?.doneAt)
    return {
      refused: `${record.version} is shipped (${record.doneAt}); --from <phase> runs a phase again`,
    };
  /** @type {PhaseResult[]} */
  const kept = [];
  for (const name of NAMES) {
    const p = done.find((r) => r.name === name);
    if (!p?.ok) break;
    kept.push(p);
  }
  return { kept, run: NAMES.slice(kept.length) };
}

/** The ships folder: RISA_SHIPS_DIR, else the main checkout's .loops/.ships. */
export function shipsDir(env = process.env) {
  if (env.RISA_SHIPS_DIR) return env.RISA_SHIPS_DIR;
  let main = env.RISA_MAIN;
  if (!main) {
    const r = spawnSync("git", ["worktree", "list", "--porcelain"], { encoding: "utf8" });
    main = (r.status === 0 && /^worktree (.+)$/m.exec(r.stdout)?.[1]) || process.cwd();
  }
  return join(main, ".loops", ".ships");
}

const recordPath = (/** @type {string} */ dir, /** @type {string} */ version) => join(dir, `${version}.json`);

/** @returns {ShipRecord | null} */
export function readRecord(/** @type {string} */ dir, /** @type {string} */ version) {
  try {
    return JSON.parse(readFileSync(recordPath(dir, version), "utf8"));
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return null;
    throw e;
  }
}

/** Writes the record whole (a temp file renamed over it). */
export function writeRecord(/** @type {string} */ dir, /** @type {ShipRecord} */ record) {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
  renameSync(tmp, recordPath(dir, record.version));
}

const pidAlive = (/** @type {number} */ pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
};

/**
 * Creates FILE with TEXT only when it doesn't exist; false when it does. The file
 * appears whole (a temp file linked into place), so a reader never sees it empty.
 */
const createExclusive = (/** @type {string} */ file, /** @type {string} */ text) => {
  const tmp = join(dirname(file), `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmp, text);
  try {
    linkSync(tmp, file);
    return true;
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "EEXIST") return false;
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
};

/** The lock's holder: { pid, version }, or null when there's no lock. */
const lockHolder = (/** @type {string} */ file) => {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return null;
    throw e;
  }
  const [pid, version = "?"] = text.trim().split(/\s+/);
  // An empty or unreadable lock names no holder that can be judged dead: valid is false.
  const n = Number(pid);
  return { pid: n, version, text, valid: Number.isInteger(n) && n > 0 };
};

/**
 * Takes the project's one ship lock for VERSION.
 * @returns {{ ok: true } | { ok: false, why: string }}
 */
export function takeLock(/** @type {string} */ dir, /** @type {string} */ version, pid = process.pid) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, ".lock");
  const text = `${pid} ${version}\n`;
  for (let tries = 0; tries < 2; tries++) {
    if (createExclusive(file, text)) return { ok: true };
    const holder = lockHolder(file);
    if (!holder) continue;
    if (!holder.valid) return { ok: false, why: "the ship lock names no pid (another ship may hold it)" };
    if (pidAlive(holder.pid))
      return { ok: false, why: `a ship of ${holder.version} is running (pid ${holder.pid})` };
    // A dead holder: take it over, one taker at a time, re-reading inside.
    const takeover = join(dir, ".lock.takeover");
    if (!createExclusive(takeover, text))
      return { ok: false, why: "another ship is taking over a dead ship's lock" };
    try {
      const again = lockHolder(file);
      if (again && again.text === holder.text) rmSync(file, { force: true });
    } finally {
      rmSync(takeover, { force: true });
    }
  }
  return { ok: false, why: "the ship lock is held" };
}

/** Removes the lock when it is still this process's. */
export function releaseLock(/** @type {string} */ dir, pid = process.pid) {
  const file = join(dir, ".lock");
  if (lockHolder(file)?.pid === pid) rmSync(file, { force: true });
}

/** A hook's facts: its key=value lines, in order (a key may repeat). */
const factLines = (/** @type {string} */ out) => out.split("\n").filter((l) => /^[A-Za-z][\w.-]*=/.test(l));

/**
 * The report's text.
 * @param {ShipRecord} record
 * @param {{ name: string, cmd: string }} project the project's name and the tool's command
 */
export function reportText(record, { name, cmd }) {
  const hookOf = (/** @type {string} */ n) => PHASES.find((p) => p.name === n)?.hook;
  const line = (/** @type {PhaseResult} */ p) => {
    if (p.skipped) return `- ${p.name}: skipped (no hooks.${hookOf(p.name)})`;
    const facts = p.facts.length ? `: ${p.facts.join(", ")}` : "";
    return `- ${p.name}: ${p.ok ? "ok" : "failed"}${facts}`;
  };
  if (record.doneAt) {
    const skipped = record.phases.filter((p) => p.skipped).map((p) => p.name);
    return [
      `${name} ${record.version} shipped.`,
      ...record.phases.map(line),
      ...(skipped.length ? [`Skipped: ${skipped.join(", ")}.`] : []),
    ].join("\n");
  }
  const failed = record.phases.find((p) => !p.ok);
  const passed = record.phases.filter((p) => p.ok);
  return [
    `${name} ${record.version}: the ship stopped at ${failed?.name ?? "?"}.`,
    ...passed.map(line),
    ...(failed ? [line(failed)] : []),
    ...(failed?.tail.length ? [`${failed.name}'s last lines:`, ...failed.tail.map((l) => `  ${l}`)] : []),
    `Resume: ${cmd} ship ${record.version}`,
  ].join("\n");
}

const nowIso = () => new Date().toISOString();
const say = (/** @type {string} */ s) => process.stdout.write(`${s}\n`);
const warn = (/** @type {string} */ s) => process.stderr.write(`${s}\n`);

/**
 * Runs one phase's hook and prints it; its result.
 * @returns {PhaseResult}
 */
function runPhase(
  /** @type {{ name: string, hook: string }} */ phase,
  /** @type {string} */ version,
  /** @type {Record<string, any>} */ config,
) {
  say(`ship ${version}: ${phase.name} (hooks.${phase.hook})`);
  if (!config.hooks?.[phase.hook]) {
    say(`${phase.name}: skipped`);
    return { name: phase.name, ok: true, skipped: true, at: nowIso(), facts: [], tail: [] };
  }
  const r = runHook(phase.hook, [version], { env: { ...process.env, RISA_SHIP_VERSION: version } });
  if (r.out) say(r.out);
  if (r.err) warn(r.err);
  const all = [r.out, r.err].filter(Boolean).join("\n");
  return {
    name: phase.name,
    ok: r.ok,
    at: nowIso(),
    facts: factLines(r.out),
    tail: r.ok ? [] : all.split("\n").filter(Boolean).slice(-TAIL_LINES),
  };
}

/**
 * The command: returns its exit code (0 shipped, 1 a phase failed, 2 refused).
 * @param {string} version
 * @param {{ dryRun?: boolean, from?: string }} [opts]
 */
export function runShip(version, { dryRun = false, from } = {}) {
  const refuse = (/** @type {string} */ why) => (warn(`ship: ${why}`), 2);
  if (!isVersion(version)) return refuse(`${version} isn't a version (1.2.3)`);
  const { config } = loadConfigOrExit("ship");
  if (!config.hooks?.ship) return refuse("the config sets no hooks.ship: this project has no ship steps");
  const asks = process.env.RISA_ASKS_DIR;
  if (!dryRun && !asks) return refuse(`RISA_ASKS_DIR isn't set (run this through ${toolCmd.prd})`);
  const dir = shipsDir();
  const lock = takeLock(dir, version);
  if (!lock.ok) return refuse(`${lock.why}; one ship of ${config.name} at a time`);
  try {
    const record = readRecord(dir, version);
    if (dryRun) {
      if (record?.doneAt && from === undefined) return refuse(nextPhases(record).refused ?? "");
      const r = runPhase(PHASES[0], version, config);
      say(
        r.ok
          ? `ship ${version}: the checks pass (a dry run: nothing shipped)`
          : `ship ${version}: check failed`,
      );
      return r.ok ? 0 : 1;
    }
    const next = nextPhases(record, { from });
    if ("refused" in next) return refuse(next.refused);
    /** @type {ShipRecord} */
    const rec = { version, startedAt: record?.startedAt ?? nowIso(), phases: [...next.kept], doneAt: null };
    // A --from or a finished record rewinds it: write that first, so a ship killed
    // in the first hook leaves a record a plain re-run resumes at that phase.
    if (record && JSON.stringify(record) !== JSON.stringify(rec)) writeRecord(dir, rec);
    const project = { name: config.name, cmd: toolCmd.prd };
    for (const name of next.run) {
      const phase = /** @type {{ name: string, hook: string }} */ (PHASES.find((p) => p.name === name));
      const result = runPhase(phase, version, config);
      rec.phases.push(result);
      if (!result.ok) {
        writeRecord(dir, rec);
        const ask = createAsk(asks, {
          kind: "report",
          topic: "ship",
          session: "ship",
          text: reportText(rec, project),
        });
        say(`ship ${version}: ${name} failed; resume with ${toolCmd.prd} ship ${version} (report ${ask.id})`);
        return 1;
      }
      if (name === NAMES.at(-1)) rec.doneAt = nowIso();
      writeRecord(dir, rec);
    }
    const ask = createAsk(asks, {
      kind: "report",
      topic: "ship",
      session: "ship",
      text: reportText(rec, project),
    });
    say(`ship ${version}: shipped (report ${ask.id})`);
    return 0;
  } finally {
    releaseLock(dir);
  }
}

const USAGE = "usage: ship <version> [--dry-run] [--from <phase>]";

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  /** @type {string | undefined} */
  let version;
  /** @type {string | undefined} */
  let from;
  let dryRun = false;
  let bad = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--from") {
      from = args[++i];
      if (!from) bad = "--from needs a phase";
    } else if (a.startsWith("-")) bad = `unknown flag ${a}`;
    else if (version === undefined) version = a;
    else bad = `one version only, not ${a} too`;
  }
  if (!bad && version === undefined) bad = "which version?";
  if (bad) {
    warn(`ship: ${bad}\n${USAGE}`);
    process.exit(2);
  }
  process.exit(runShip(/** @type {string} */ (version), { dryRun, from }));
}
