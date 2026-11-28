// metrics [--since <date>] [--json]: how runs are going, from three logs
// in the main checkout's .loops/:
//   the run log      .run-log.jsonl (run-log.mjs): slices, landings, browser
//                    results, Codex verdicts
//   the check log    .check-times.log (check-times.mjs): every check
//   the flake log    .browser-flakes.log (browser.sh): each browser check that
//                    passed only on its retry, "<time>\t<worktree>\t<check>\t<why>\t<log>";
//                    older lines name a check <name>.mjs, newer <name>.spec.mjs
//
// The summary: slice and landing durations (count, median, slowest), check
// times by mode (and their failures by kind, overall, by mode and by PRD: test
// failures, budget stops, silence stops, time breaches), the flake rate by check and overall, and how many reviewed
// heads Codex had findings on (out-of-credits answers apart). Malformed lines
// are counted and skipped. usualTime answers "how long does this kind of work
// usually take", for the check budget and the watch.
//
// Pure functions over the logs' text; readData and the CLI at the bottom read files.
import { existsSync, readFileSync } from "node:fs";

import { FAILURE_COLUMNS, failureCounts, parseLog as parseCheckLine, prdOf } from "./check-times.mjs";
import { branchKinds } from "./config.mjs";

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const ms = (t) => Date.parse(t);

/** A branch's kind: slice, prd, plan, hotfix, or other (dev, main, a bare name). */
export function branchKind(branch) {
  return branchKinds().kindOf(branch) ?? "other";
}

/** A browser check's name, whatever the log called it: roundtrip, roundtrip.mjs, roundtrip.spec.mjs. */
export function checkName(name) {
  return String(name ?? "")
    .replace(/^.*\//, "")
    .replace(/\.mjs$/, "")
    .replace(/\.spec$/, "");
}

/** @param {string} text @returns {{ events: object[], skipped: number }} */
export function parseRunLog(text) {
  const events = [];
  let skipped = 0;
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    if (!e || typeof e !== "object" || typeof e.kind !== "string" || Number.isNaN(ms(e.time))) {
      skipped++;
      continue;
    }
    events.push(e);
  }
  events.sort((a, b) => ms(a.time) - ms(b.time));
  return { events, skipped };
}

/** @param {string} text @returns {{ flakes: { time: string, worktree: string, check: string, why: string }[], skipped: number }} */
export function parseFlakeLog(text) {
  const flakes = [];
  let skipped = 0;
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    const f = line.split("\t");
    if (f.length < 3 || Number.isNaN(ms(f[0])) || !checkName(f[2])) {
      skipped++;
      continue;
    }
    flakes.push({ time: f[0], worktree: f[1], check: checkName(f[2]), why: f[3] ?? "" });
  }
  return { flakes, skipped };
}

/** The check log, each run marked with whether its line has the flaky-files field (fifteen fields). */
function parseChecks(text) {
  const runs = [];
  let skipped = 0;
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    const { runs: [run] = [], skipped: bad } = parseCheckLine(line);
    if (bad || !run) {
      skipped++;
      continue;
    }
    runs.push({ ...run, recordsFlakes: line.split("\t").length >= 15 });
  }
  return { runs, skipped };
}

/**
 * The three logs, parsed.
 * @param {{ runLog?: string, checkLog?: string, flakeLog?: string }} texts
 */
export function loadData({ runLog = "", checkLog = "", flakeLog = "" } = {}) {
  const run = parseRunLog(runLog);
  const checks = parseChecks(checkLog);
  const flakes = parseFlakeLog(flakeLog);
  return {
    events: run.events,
    checks: checks.runs,
    flakes: flakes.flakes,
    skipped: { runLog: run.skipped, checkLog: checks.skipped, flakeLog: flakes.skipped },
  };
}

/**
 * Slices from their start and end events, by worktree name: an end closes the
 * earliest start since the name's last end (a resumed slice's worktree counts
 * from its first start). Starts left open are running.
 */
export function slices(events) {
  const open = new Map();
  const done = [];
  for (const e of events) {
    if (e.kind === "slice-start" && e.name) {
      if (!open.has(e.name)) open.set(e.name, e);
    } else if (e.kind === "slice-end" && e.name && open.has(e.name)) {
      const s = open.get(e.name);
      open.delete(e.name);
      done.push({
        name: e.name,
        topic: e.topic || s.topic || "",
        branch: e.branch || s.branch || "",
        start: s.time,
        end: e.time,
        seconds: Math.max(0, (ms(e.time) - ms(s.time)) / 1000),
        merged: e.merged === true,
      });
    }
  }
  return { done, running: [...open.values()].map((s) => ({ name: s.name, topic: s.topic, start: s.time })) };
}

/** Landings from their end events: landed or not, with their seconds. */
export function landings(events) {
  return events
    .filter((e) => e.kind === "land-end" && Number.isFinite(Number(e.seconds)))
    .map((e) => ({
      branch: e.branch ?? "",
      topic: e.topic ?? "",
      path: e.path ?? "",
      end: e.time,
      seconds: Number(e.seconds),
      landed: e.landed === true,
      exit: Number.isFinite(Number(e.exit)) ? Number(e.exit) : null,
    }));
}

/** Codex's answers, one per PR, head and kind of answer (the first recorded). */
export function codexAnswers(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    if (e.kind !== "codex" || !e.head) continue;
    const answer =
      e.answer === "out-of-credits" || e.state === "out-of-credits" ? "out-of-credits" : "review";
    const key = `${e.pr}\t${e.head}\t${answer}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...e, answer, carried: Boolean(e.carried) });
  }
  return out;
}

const durations = (items, label) => {
  const secs = items.map((i) => i.seconds);
  const slowest = items.reduce((a, i) => (!a || i.seconds > a.seconds ? i : a), null);
  return {
    count: items.length,
    medianMinutes: secs.length ? median(secs) / 60 : null,
    slowestMinutes: slowest ? slowest.seconds / 60 : null,
    slowest: slowest ? label(slowest) : null,
  };
};

const rate = (flaky, runs) => (runs ? flaky / runs : null);

/**
 * The summary.
 * @param {ReturnType<typeof loadData>} data
 * @param {{ since?: string }} [options] a date (anything Date parses); earlier items are left out
 */
export function summarize(data, { since } = {}) {
  let cutoff = -Infinity;
  if (since) {
    cutoff = ms(since);
    if (Number.isNaN(cutoff)) throw new Error(`--since: can't read the date "${since}"`);
  }
  const after = (t) => ms(t) >= cutoff;
  const events = data.events;

  const sl = slices(events);
  const doneSlices = sl.done.filter((s) => after(s.end));
  const lands = landings(events).filter((l) => after(l.end));
  const landed = lands.filter((l) => l.landed);

  const checks = data.checks.filter((r) => after(r.start));
  const checkRow = (runs) => {
    const passed = runs.filter((r) => r.exit === 0);
    return {
      runs: runs.length,
      passed: passed.length,
      ...failureCounts(runs),
      medianMinutes: passed.length ? median(passed.map((r) => r.seconds)) / 60 : null,
      slowestMinutes: passed.length ? Math.max(...passed.map((r) => r.seconds)) / 60 : null,
    };
  };
  const checksBy = (key) =>
    Object.fromEntries(
      [...new Set(checks.map(key))].sort().map((k) => [k, checkRow(checks.filter((r) => key(r) === k))]),
    );
  const byMode = checksBy((r) => r.mode);
  const byPrd = checksBy(prdOf);

  // Flakes: a check run is flaky when it passed only by rerunning failed files
  // (its line's flaky field); lines from before that field can't say, so they
  // count for neither. A browser run is flaky when it passed on its retry.
  const flakes = {};
  const flakeRow = (key) =>
    (flakes[key] ??= key.startsWith("browser ")
      ? { runs: 0, flaky: 0, rate: null, recorded: 0 }
      : { runs: 0, flaky: 0, rate: null });
  for (const r of checks) {
    if (!r.recordsFlakes) continue;
    const row = flakeRow(`check ${r.mode}`);
    row.runs++;
    if (r.exit === 0 && r.flakyFiles.length) row.flaky++;
  }
  for (const e of events) {
    if (e.kind !== "browser" || !after(e.time) || !e.check) continue;
    if (["not-run", "missing"].includes(String(e.result).toLowerCase())) continue;
    const row = flakeRow(`browser ${checkName(e.check)}`);
    row.runs++;
    if (String(e.result).toLowerCase() === "flaky") row.flaky++;
  }
  // The flake log's lines (old ones too) are the browser flakes' history: shown
  // as recorded, not in the rate, whose runs start with the run log.
  for (const f of data.flakes) if (after(f.time)) flakeRow(`browser ${f.check}`).recorded++;
  let allRuns = 0;
  let allFlaky = 0;
  for (const row of Object.values(flakes)) {
    row.rate = rate(row.flaky, row.runs);
    allRuns += row.runs;
    allFlaky += row.flaky;
  }
  const sortedFlakes = Object.fromEntries(Object.entries(flakes).sort(([a], [b]) => a.localeCompare(b)));

  const answers = codexAnswers(events).filter((a) => after(a.time));
  const reviews = answers.filter((a) => a.answer === "review");
  const reviewed = reviews.filter((a) => !a.carried);
  const withFindings = reviewed.filter((a) => a.state === "findings" || Number(a.findings) > 0);

  return {
    since: since ?? null,
    slices: {
      ...durations(doneSlices, (s) => s.name),
      merged: doneSlices.filter((s) => s.merged).length,
      running: sl.running.length,
    },
    landings: {
      ...durations(landed, (l) => l.branch),
      notLanded: lands.length - landed.length,
    },
    checks: { runs: checks.length, overall: checkRow(checks), byMode, byPrd },
    flakes: {
      byCheck: sortedFlakes,
      overall: { runs: allRuns, flaky: allFlaky, rate: rate(allFlaky, allRuns) },
    },
    codex: {
      reviewedHeads: reviewed.length,
      withFindings: withFindings.length,
      findRate: rate(withFindings.length, reviewed.length),
      carried: reviews.length - reviewed.length,
      outOfCredits: answers.filter((a) => a.answer === "out-of-credits").length,
    },
    skipped: data.skipped,
  };
}

/**
 * The usual time for a kind of work, over its last `last` passing samples:
 *   check    check runs that passed, by mode (quick, slice, full) and
 *            branch kind (slice, prd, plan, hotfix, other)
 *   slice    finished slices (worktree created to removed)
 *   landing  landings that merged, by mode (pr, local) and branch kind
 * Unset filters match anything. medianSeconds and slowestSeconds are null with no samples.
 * @param {ReturnType<typeof loadData>} data
 * @param {{ kind: "check" | "slice" | "landing", mode?: string, branchKind?: string, last?: number }} query
 */
export function usualTime(data, { kind, mode, branchKind: bk, last = 20 }) {
  let samples;
  if (kind === "check")
    samples = data.checks
      .filter((r) => r.exit === 0 && (!mode || r.mode === mode) && (!bk || branchKind(r.branch) === bk))
      .sort((a, b) => ms(a.start) - ms(b.start))
      .map((r) => r.seconds);
  else if (kind === "slice")
    samples = slices(data.events)
      .done.filter((s) => !bk || (s.branch ? branchKind(s.branch) : "slice") === bk)
      .map((s) => s.seconds);
  else if (kind === "landing")
    samples = landings(data.events)
      .filter((l) => l.landed && (!mode || l.path === mode) && (!bk || branchKind(l.branch) === bk))
      .map((l) => l.seconds);
  else throw new Error(`usualTime: unknown kind ${kind} (check, slice, landing)`);
  samples = samples.slice(-last);
  return {
    samples: samples.length,
    medianSeconds: median(samples),
    slowestSeconds: samples.length ? Math.max(...samples) : null,
  };
}

const min = (m) => (m === null ? "-" : m.toFixed(1));
const pct = (r) => (r === null ? "-" : `${(r * 100).toFixed(1)}%`);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function formatSummary(s) {
  const lines = [`Run metrics${s.since ? ` since ${s.since}` : ""}`];
  const sl = s.slices;
  lines.push(
    sl.count
      ? `Slices: ${sl.count} done (${sl.merged} merged), median ${min(sl.medianMinutes)} m, slowest ${min(sl.slowestMinutes)} m (${sl.slowest}); ${sl.running} running`
      : `Slices: none finished yet; ${sl.running} running`,
  );
  const ld = s.landings;
  lines.push(
    ld.count
      ? `Landings: ${ld.count} landed, median ${min(ld.medianMinutes)} m, slowest ${min(ld.slowestMinutes)} m (${ld.slowest}); ${ld.notLanded} refused or failed`
      : `Landings: none landed yet; ${ld.notLanded} refused or failed`,
  );
  lines.push("Checks:");
  if (!s.checks.runs) lines.push("  none recorded");
  else {
    const cells = (g) => FAILURE_COLUMNS.map(([k, h]) => String(g[k]).padStart(h.length + 1)).join("");
    const checkLine = (name, g) =>
      `  ${name.padEnd(24)} ${String(g.runs).padStart(5)}${cells(g)} ${min(g.medianMinutes).padStart(8)} ${min(g.slowestMinutes).padStart(9)}`;
    lines.push(
      `  ${"".padEnd(24)} ${"runs".padStart(5)}${FAILURE_COLUMNS.map(([, h]) => ` ${h}`).join("")} ${"median m".padStart(8)} ${"slowest m".padStart(9)}  (passing runs)`,
      checkLine("all", s.checks.overall),
      " by mode:",
      ...Object.entries(s.checks.byMode).map(([mode, g]) => checkLine(mode, g)),
      " by PRD:",
      ...Object.entries(s.checks.byPrd).map(([prd, g]) => checkLine(prd, g)),
    );
  }
  lines.push("Flakes:");
  const rows = Object.entries(s.flakes.byCheck);
  if (!rows.length) lines.push("  none recorded");
  else {
    lines.push(
      `  ${"".padEnd(26)} ${"runs".padStart(5)} ${"flaky".padStart(5)} ${"rate".padStart(7)} ${"in the flake log".padStart(16)}`,
    );
    const row = (name, g) =>
      `  ${name.padEnd(26)} ${String(g.runs).padStart(5)} ${String(g.flaky).padStart(5)} ${pct(g.rate).padStart(7)} ${(g.recorded === undefined ? "" : String(g.recorded)).padStart(16)}`;
    for (const [name, g] of rows) lines.push(row(name, g));
    lines.push(row("overall", s.flakes.overall));
  }
  const c = s.codex;
  lines.push(
    `Codex: ${plural(c.reviewedHeads, "head")} reviewed, ${c.withFindings} with findings (${pct(c.findRate)})` +
      `${c.carried ? `; ${c.carried} clean carried over a dev merge` : ""}` +
      `; out of credits on ${plural(c.outOfCredits, "head")} (not counted)`,
  );
  const sk = s.skipped;
  if (sk.runLog + sk.checkLog + sk.flakeLog)
    lines.push(
      `Malformed lines skipped: run log ${sk.runLog}, check log ${sk.checkLog}, flake log ${sk.flakeLog}`,
    );
  return lines.join("\n");
}

/** The logs' text from their files (a missing one is empty). */
export function readData({ runLog, checkLog, flakeLog }) {
  const read = (f) => (f && existsSync(f) ? readFileSync(f, "utf8") : "");
  return loadData({ runLog: read(runLog), checkLog: read(checkLog), flakeLog: read(flakeLog) });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let since;
  let json = false;
  const files = {
    runLog: process.env.RISA_RUN_LOG,
    checkLog: process.env.RISA_CHECK_LOG,
    flakeLog: process.env.RISA_BROWSER_FLAKES,
  };
  const flags = { "--run-log": "runLog", "--check-log": "checkLog", "--flake-log": "flakeLog" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--since" && args[i + 1]) since = args[++i];
    else if (args[i] === "--json") json = true;
    else if (flags[args[i]] && args[i + 1]) files[flags[args[i]]] = args[++i];
    else {
      console.error(`metrics: unknown argument ${args[i]} (--since <date>, --json)`);
      process.exit(1);
    }
  }
  try {
    const s = summarize(readData(files), { since });
    console.log(json ? JSON.stringify(s, null, 2) : formatSummary(s));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
