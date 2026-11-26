// Whose failure it is: pure, so `prd ci blame` and `ci file` (ci.mjs) and the
// tests share it.
//
// A branch's failures are compared with a run on dev's tip. Failing there too is
// dev's; passing there is the branch's; a test file dev doesn't have is the
// branch's. A dev result that can't prove either (infra, cut short, a flake on
// dev, a quarantined test that didn't pass there, a named test in a file dev
// couldn't load) leaves the failure unknown: it is never assigned, and never green.
import { dirname } from "node:path";

import { backlogIds } from "../loops/config.mjs";
import { findingKey, keyMark } from "./filing.mjs";
import { isQuarantined } from "./ci-lists.mjs";
import { ciFailureTopic } from "./release.mjs";
import { ciTiers } from "./tier-data.mjs";

/** A dev-brake notice: its item and key. */
const BRAKE_NOTICE = new RegExp(`^dev brake ${backlogIds().lookupPattern} \\[ci-key ([^\\]]+)\\]`);

/** The whole tier a failed check job needs on dev. */
const CHECK_JOB_TIER = /** @type {const} */ ({ static: "static", build: "full" });
const MAX_TITLE = 120;
const MAX_NOTICE = 200;

/**
 * @typedef {{ job?: string, file?: string, name?: string | null, message?: string }} Failure
 * @typedef {Failure & { key: string, brake: boolean, absent?: boolean }} Placed
 * @typedef {{ dev: Placed[], branch: Placed[], unknown: Placed[] }} Split
 */

/** A hung file's message: the verdict has no test message for it. */
export const HUNG_MESSAGE = "hung: still running when its test step's watchdog stopped the run";

/**
 * What a verdict says still fails: named tests, files with no named test, and
 * failed check jobs. `partial` means the list can't be the whole story. `hung`:
 * the files a stopped test step was stuck on (a verdict before them has none).
 * @param {any} v
 */
export function verdictFailures(v) {
  const after = v.afterRerun ?? v.failed ?? {};
  /** @type {{ job?: string, file: string, name: string, message?: string }[]} */ const tests =
    after.tests ?? [];
  const named = new Set(tests.map((t) => t.file));
  /** @type {string[]} */ const files = (after.files ?? []).filter(
    (/** @type {string} */ f) => !named.has(f),
  );
  /** @type {string[]} */ const jobs = v.brake?.jobs ?? [];
  // A flake explains a job only when the verdict says the job has no unnamed
  // failure: a job can fail for something else after its flake passed the rerun.
  /** @type {string[] | undefined} */ const unnamedJobs = v.failed?.unnamedJobs;
  const flakeExplains = (/** @type {string} */ job) =>
    !!unnamedJobs &&
    !unnamedJobs.includes(job) &&
    (v.flaky ?? []).some((/** @type {{ job?: string }} */ t) => t.job === job);
  const explained = (/** @type {string} */ job) =>
    jobs.includes(job) ||
    tests.some((t) => t.job === job) ||
    files.some((f) => job.startsWith(ciTiers().isBrowserCheckFile(f) ? "browser" : ciTiers().fileTier(f))) ||
    flakeExplains(job);
  const unnamed = (v.failed?.jobs ?? []).some((/** @type {string} */ job) => !explained(job));
  /** @type {string[]} */ const hung = Array.isArray(v.failed?.hung) ? v.failed.hung : [];
  return {
    tests,
    files,
    jobs,
    hung: files.filter((f) => hung.includes(f)),
    partial: !!v.failed?.truncated || !!v.infra?.jobs?.length || unnamed,
  };
}

const higher = (/** @type {string} */ a, /** @type {string} */ b) =>
  ciTiers().TIERS.indexOf(/** @type {any} */ (a)) >= ciTiers().TIERS.indexOf(/** @type {any} */ (b)) ? a : b;

/**
 * The run dev needs: the failed files at their highest tier, or the whole tier
 * when a static or build job or a browser check failed (a narrowed run has no
 * browser job). Null when dev has nothing to run.
 * @param {ReturnType<typeof verdictFailures>} failures
 * @param {(file: string) => boolean} onDev
 */
export function devRunPlan(failures, onDev) {
  const all = [...new Set([...failures.tests.map((t) => t.file), ...failures.files])];
  const files = all.filter(onDev);
  const absent = all.filter((f) => !onDev(f));
  if (!files.length && !failures.jobs.length) return { run: null, absent };
  let tier = /** @type {string} */ (ciTiers().TIERS[0]);
  for (const f of files) tier = higher(tier, ciTiers().fileTier(f));
  for (const job of failures.jobs)
    tier = higher(tier, CHECK_JOB_TIER[/** @type {keyof typeof CHECK_JOB_TIER} */ (job)] ?? "full");
  return {
    run: { tier, files, whole: failures.jobs.length > 0 || files.some(ciTiers().isBrowserCheckFile) },
    absent,
  };
}

/**
 * Whether a dev verdict can say anything about the planned run.
 * @param {any} dev
 * @param {string} devSha
 * @param {{ files: string[], whole: boolean }} run
 */
export function devResultUsable(dev, devSha, run) {
  if (!dev || !["green", "flake", "file", "brake"].includes(dev.kind)) return false;
  if ((dev.target ?? dev.commit) !== devSha || verdictFailures(dev).partial) return false;
  if (run.whole) return !dev.narrowed;
  return !!dev.narrowed && run.files.every((f) => (dev.narrowedFiles ?? []).includes(f));
}

/**
 * Split a branch's failures against dev's result.
 * @param {ReturnType<typeof verdictFailures>} failures
 * @param {any} dev null when dev didn't run or can't be read
 * @param {string[]} absent test files dev doesn't have
 * @returns {Split}
 */
export function splitFailures(failures, dev, absent) {
  /** @type {Split} */ const split = { dev: [], branch: [], unknown: [] };
  const devFails = dev ? verdictFailures(dev) : null;
  const braked = (/** @type {Failure} */ f) =>
    !!dev &&
    (f.file
      ? (dev.brake?.files ?? []).includes(f.file) ||
        (dev.brake?.tests ?? []).some(
          (/** @type {Failure} */ t) => t.file === f.file && (!f.name || t.name === f.name),
        )
      : (dev.brake?.jobs ?? []).includes(f.job));
  const flakyOnDev = (/** @type {Failure} */ f) =>
    (dev?.flaky ?? []).some(
      (/** @type {Failure} */ t) => t.file === f.file && (!t.name || !f.name || t.name === f.name),
    );
  const failsOnDev = (/** @type {Failure} */ f) => {
    if (!devFails || !f.file) return false;
    if (!f.name) return devFails.files.includes(f.file);
    return devFails.tests.some((t) => t.file === f.file && t.name === f.name);
  };
  // A skipped quarantined test hasn't passed; a verdict with no list can't say.
  const quarantineUnproven = (/** @type {Failure} */ f) => {
    if (!f.file || !f.name) return false;
    const { file, name } = f;
    if (!Array.isArray(dev?.quarantineList)) return true;
    if (!isQuarantined(dev.quarantineList, file, name)) return false;
    const results = (dev.quarantined ?? []).filter(
      (/** @type {Failure & { status: string }} */ t) => t.file === file && t.name === name,
    );
    return !results.length || results.some((/** @type {{ status: string }} */ t) => t.status !== "passed");
  };
  // Dev failed this file at the other level: a load failure says nothing about an
  // assertion, and a failed assertion says nothing about a branch's load failure.
  const otherLevelOnDev = (/** @type {Failure} */ f) =>
    !!f.file &&
    (f.name ? !!devFails?.files.includes(f.file) : !!devFails?.tests.some((t) => t.file === f.file));
  const notCompared = (/** @type {Failure} */ f) => otherLevelOnDev(f) || quarantineUnproven(f);
  const place = (/** @type {Failure} */ f) => {
    const key = findingKey(f);
    if (f.file && absent.includes(f.file)) split.branch.push({ ...f, key, brake: false, absent: true });
    else if (!dev) split.unknown.push({ ...f, key, brake: false });
    else if (f.job && !f.file)
      (devFails?.jobs.includes(f.job) ? split.dev : split.branch).push({ ...f, key, brake: braked(f) });
    else if (failsOnDev(f)) split.dev.push({ ...f, key, brake: braked(f) });
    else if (flakyOnDev(f) || notCompared(f)) split.unknown.push({ ...f, key, brake: false });
    else split.branch.push({ ...f, key, brake: false });
  };
  for (const t of failures.tests)
    place({ job: t.job, file: t.file, name: t.name, ...(t.message ? { message: t.message } : {}) });
  for (const file of failures.files)
    place({ file, name: null, ...(failures.hung?.includes(file) ? { message: HUNG_MESSAGE } : {}) });
  for (const job of failures.jobs) place({ job });
  return split;
}

/** 0 all dev's, 2 some the branch's, 5 unknown: a definite branch failure outranks the unknown rest. */
export const blameExit = (/** @type {Split} */ s, partial = false) =>
  s.branch.length ? 2 : s.unknown.length || partial ? 5 : 0;

export const label = (/** @type {Failure} */ f) =>
  f.file ? `${f.file}${f.name ? `: ${f.name}` : ""}` : `the ${f.job} job`;

/** A failure's message on one line (the verdict already capped it), or "" with none. */
export const messageLine = (/** @type {Failure} */ f) =>
  typeof f.message === "string" ? f.message.replace(/\s+/g, " ").trim() : "";

/** A note's ending that quotes the failure's message, or "" with none. */
const messageNote = (/** @type {Failure} */ f) => {
  const line = messageLine(f);
  return line ? ` First failure: ${line}` : "";
};

/** A backlog title is one line and can't hold the heading's separator. */
const title = (/** @type {string} */ text) => {
  const line = text.replace(/\s+/g, " ").replaceAll("·", "-").trim();
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line;
};

/**
 * One finding per dev failure, in the config's CI failure topic (release.mjs's ciFailureTopic).
 * @param {Placed[]} failures
 * @param {{ branch: string, url?: string, topic?: string }} from
 */
export const devFindings = (failures, { branch, url, topic }) => {
  if (!failures.length) return [];
  const prd = topic ?? ciFailureTopic();
  return failures.map((f) => ({
    key: f.key,
    title: title(`CI: ${label(f)} fails on dev`),
    prd,
    note: `Fails on dev too${f.brake ? " (a brake)" : ""}; found by ${branch}${url ? ` in ${url}` : ""}.${messageNote(f)}`,
    quarantine: null,
  }));
};

/**
 * The board's line for a dev brake.
 * @param {string} id
 * @param {Placed} f
 */
export function brakeNotice(id, f) {
  const text = `dev brake ${id} ${keyMark(f.key)}: ${label(f)}`.replace(/\s+/g, " ");
  return text.length > MAX_NOTICE ? `${text.slice(0, MAX_NOTICE - 1)}…` : text;
}

/** The key a dev-brake notice carries, or null for any other notice. */
export const noticeKey = (/** @type {string} */ text) => BRAKE_NOTICE.exec(text)?.[1] ?? null;

/**
 * Sort a verdict's flakes: a file the branch touched is the branch's and nothing
 * is written; a brake-list flake or a whole-file flake is filed with no entry;
 * the rest are filed and quarantined.
 * @param {{ job?: string, file: string, name: string | null, brake?: boolean, message?: string }[]} flaky
 * @param {string[]} touched
 * @param {{ branch: string, url?: string }} from
 */
export function sortFlakes(flaky, touched, { branch, url }) {
  /** @type {typeof flaky} */ const branchFlakes = [];
  const findings = new Map();
  for (const t of flaky) {
    if (touched.includes(t.file)) {
      branchFlakes.push(t);
      continue;
    }
    const key = findingKey(t);
    if (findings.has(key)) continue;
    const listed = !t.brake && !!t.name;
    findings.set(key, {
      key,
      title: title(`CI flake: ${label(t)}`),
      prd: "fixes-tooling",
      note: `Flaked (passed on its rerun)${t.brake ? "; on the brake list, so not quarantined" : ""}${
        ciTiers().isBrowserCheckFile(t.file)
          ? "; a browser check is filed, never quarantined"
          : t.name
            ? ""
            : "; a whole-file flake can't be quarantined by name"
      }; found by ${branch}${url ? ` in ${url}` : ""}.${messageNote(t)}`,
      quarantine: listed ? { file: t.file, name: /** @type {string} */ (t.name) } : null,
    });
  }
  return { branch: branchFlakes, findings: [...findings.values()] };
}

/**
 * The slices whose merges changed a test's directory.
 * @param {{ subject: string, files: string[] }[]} merges
 * @param {string} file
 */
export function slicesNear(merges, file) {
  const dir = `${dirname(file)}/`;
  const slices = new Set();
  for (const m of merges) {
    const n = /\(slice (\d+)/.exec(m.subject)?.[1];
    if (n && m.files.some((f) => f.startsWith(dir))) slices.add(Number(n));
  }
  return [...slices].sort((a, b) => a - b);
}
