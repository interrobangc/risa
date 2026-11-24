// The landing journal: one small record per landing in the main checkout's
// .loops/.landing/ (CARETOOK_LANDING_DIR moves it; tests always do), written by
// land.sh before each step and removed at the end, so a landing cut off midway
// (a crash, a restart, a usage limit) says how far it got. Git wins: the record
// says where to look, git and GitHub say what happened.
//
// Steps, in order (the record names the one about to run):
//   the PR path     push, merge (gh pr merge), mark, to-test, notice, dev-sync, flakes, end
//   the local path  merge (git merge --no-ff), mark, to-test, notice, flakes, end
// mark is the skeptic store's "landed" mark; flakes files the gate's flakes.
//
// decide(record, facts) → finish (run the steps from `from` on), undo (nothing
// merged: drop the record, abort the recorded local merge when `abort`, and the
// branch goes through `land` and its gates again), done (nothing left) or ask.
// It never reruns a merge, and it aborts a merge only when MERGE_HEAD is the
// recorded tip.
//
//   node land-journal.mjs step <file> <step> [key=value…]   record the step (atomic)
//   node land-journal.mjs fields <file>                     the record, key\0value\0…
//   node land-journal.mjs decide <file> [--merge-head SHA] [--dev-has 0|1]
//       [--origin-has 0|1] [--pr open|merged|closed|unknown] [--running 0|1]
//       → four lines: the action, the step to finish from, 1 to abort the merge, why
//   node land-journal.mjs list <dir>                        the records, as JSON
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const PR_STEPS = ["push", "merge", "mark", "to-test", "notice", "dev-sync", "flakes", "end"];
export const LOCAL_STEPS = ["merge", "mark", "to-test", "notice", "flakes", "end"];

/** The steps of a landing's path. @param {string} path */
export const stepsOf = (path) => (path === "pr" ? PR_STEPS : path === "local" ? LOCAL_STEPS : null);

/**
 * @typedef {{ branch?: string, path?: string, tip?: string, step?: string, [key: string]: unknown }} Record
 * @typedef {object} Facts
 * @property {string|null} [mergeHead]   the main checkout's MERGE_HEAD, or null
 * @property {boolean} [devHas]          the local dev holds the recorded tip
 * @property {boolean|null} [originHas]  origin/dev holds it (null: unknown)
 * @property {"open"|"merged"|"closed"|"unknown"|null} [pr]  the PR's state (the PR path)
 * @property {boolean} [running]         the landing (or a resume) that wrote it is still alive
 * @typedef {{ action: "finish"|"undo"|"done"|"ask", why: string, from?: string, abort?: boolean }} Decision
 */

/**
 * What a resume does with a landing's record, given what git and GitHub say.
 * @param {Record|null} record
 * @param {Facts} facts
 * @returns {Decision}
 */
export function decide(record, facts) {
  if (!record) return { action: "done", why: "no landing journal: nothing was cut off" };
  const steps = stepsOf(String(record.path ?? ""));
  if (!steps) return { action: "ask", why: `the journal names an unknown path (${String(record.path)})` };
  const step = String(record.step ?? "");
  const at = steps.indexOf(step);
  if (at < 0) return { action: "ask", why: `the journal names an unknown step (${step || "none"})` };
  if (!record.tip) return { action: "ask", why: "the journal names no tip" };
  if (facts.running)
    return { action: "ask", why: "the landing (or a resume) that wrote the journal is still running" };
  if (step === "end") return { action: "done", why: "every step ran; only the journal was left" };
  const tip = String(record.tip);
  const pr = record.path === "pr";
  const merged = pr ? facts.originHas === true || facts.pr === "merged" : facts.devHas === true;

  if (facts.mergeHead) {
    if (!pr && step === "merge" && facts.mergeHead === tip && !facts.devHas)
      return {
        action: "undo",
        abort: true,
        why: `the local merge of ${tip.slice(0, 7)} was cut off: aborting it`,
      };
    return {
      action: "ask",
      why: `the main checkout is mid-merge of ${facts.mergeHead.slice(0, 7)}, which isn't this landing's merge: never aborted`,
    };
  }

  const mergeAt = steps.indexOf("merge");
  if (at <= mergeAt) {
    if (merged)
      return {
        action: "finish",
        from: steps[mergeAt + 1],
        why: "the merge went in: finishing the steps after it",
      };
    if (!pr) return { action: "undo", why: "dev doesn't have the branch: nothing merged" };
    if (facts.pr === "open")
      return { action: "undo", why: "the PR is still open and unmerged: nothing landed" };
    if (facts.pr === "closed") return { action: "ask", why: "the PR is closed without a merge" };
    return {
      action: "ask",
      why: "GitHub's state of the PR is unknown, and origin/dev doesn't have the branch",
    };
  }

  if (!merged)
    return {
      action: "ask",
      why: pr
        ? `the journal is past the merge (at ${step}), but neither GitHub nor origin/dev shows it`
        : `the journal is past the merge (at ${step}), but dev doesn't have the branch`,
    };
  if (pr && !facts.devHas && at > steps.indexOf("dev-sync"))
    return {
      action: "finish",
      from: "dev-sync",
      why: "merged on GitHub, but dev lacks it: syncing dev again",
    };
  return {
    action: "finish",
    from: step,
    why: pr && !facts.devHas ? "merged on GitHub with no dev sync yet" : `merged: finishing from ${step}`,
  };
}

/** The record in FILE, or null when there is none or it can't be read. @param {string} file */
export function readRecord(file) {
  try {
    const r = JSON.parse(readFileSync(file, "utf8"));
    return r && typeof r === "object" && !Array.isArray(r) ? r : null;
  } catch {
    return null;
  }
}

/**
 * Record STEP in FILE, with extra fields, atomically (a temp file renamed in).
 * @param {string} file
 * @param {string} step
 * @param {{ [key: string]: string }} fields
 * @param {Date} now
 */
export function recordStep(file, step, fields = {}, now = new Date()) {
  const before = readRecord(file) ?? { started: now.toISOString() };
  const next = { ...before, ...fields, step, at: now.toISOString() };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  renameSync(tmp, file);
  return next;
}

/** Every record in DIR (each *.json), with its file. @param {string} dir */
export function listRecords(dir) {
  /** @type {string[]} */
  let names;
  try {
    names = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  return names.flatMap((f) => {
    const r = readRecord(join(dir, f));
    return r ? [{ ...r, file: join(dir, f) }] : [];
  });
}

function main() {
  const [cmd, file, ...rest] = process.argv.slice(2);
  if (cmd === "step") {
    const [step, ...pairs] = rest;
    if (!file || !step) throw new Error("step <file> <step> [key=value…]");
    /** @type {{ [key: string]: string }} */
    const fields = {};
    for (const p of pairs) {
      const i = p.indexOf("=");
      if (i > 0) fields[p.slice(0, i)] = p.slice(i + 1);
    }
    recordStep(file, step, fields);
  } else if (cmd === "fields") {
    const r = readRecord(file);
    if (!r) process.exit(1);
    for (const [k, v] of Object.entries(r)) process.stdout.write(`${k}\0${String(v ?? "")}\0`);
  } else if (cmd === "decide") {
    /** @type {Facts} */
    const facts = {};
    for (let i = 0; i < rest.length; i += 2) {
      const v = rest[i + 1] ?? "";
      if (rest[i] === "--merge-head") facts.mergeHead = v || null;
      else if (rest[i] === "--dev-has") facts.devHas = v === "1";
      else if (rest[i] === "--origin-has") facts.originHas = v === "" ? null : v === "1";
      else if (rest[i] === "--pr") facts.pr = /** @type {Facts["pr"]} */ (v || "unknown");
      else if (rest[i] === "--running") facts.running = v === "1";
    }
    const d = decide(readRecord(file), facts);
    console.log([d.action, d.from ?? "", d.abort ? "1" : "", d.why].join("\n"));
  } else if (cmd === "list") {
    console.log(JSON.stringify(listRecords(file)));
  } else {
    console.error("land-journal: step | fields | decide | list");
    process.exit(2);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
