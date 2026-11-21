// The check log (.loops/.check-times.log, written by check-run.sh) and its
// summary: `pnpm prd check --times [--since <date>]`. Pure functions, plus a
// small CLI at the bottom.
//
// A line has eleven tab-separated fields: start, worktree, branch, mode,
// reason, seconds, load at start, load at end, exit code, test files run, test
// files in all.
import { existsSync, readFileSync } from "node:fs";

/** @typedef {{ start: string, worktree: string, branch: string, mode: string, reason: string, seconds: number,
 *   loadStart: number | null, loadEnd: number | null, exit: number, filesRun: number | null, filesAll: number | null }} Run */

const num = (s) => (s !== undefined && s !== "" && Number.isFinite(Number(s)) ? Number(s) : null);

/** @param {string} text @returns {{ runs: Run[], skipped: number }} */
export function parseLog(text) {
  const runs = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const f = line.split("\t");
    const seconds = num(f[5]);
    const exit = num(f[8]);
    if (
      f.length < 9 ||
      Number.isNaN(Date.parse(f[0])) ||
      !f[3] ||
      seconds === null ||
      seconds < 0 ||
      exit === null
    ) {
      skipped++;
      continue;
    }
    runs.push({
      start: f[0],
      worktree: f[1],
      branch: f[2],
      mode: f[3],
      reason: f[4],
      seconds,
      loadStart: num(f[6]),
      loadEnd: num(f[7]),
      exit,
      filesRun: num(f[9]),
      filesAll: num(f[10]),
    });
  }
  return { runs, skipped };
}

/** The PRD a run belongs to: slice/<topic>/<n> and prd/<topic> give the topic, else the worktree name. */
export function prdOf(run) {
  const m = /^(?:slice|prd|plan|hotfix)\/([^/]+)/.exec(run.branch);
  return m ? m[1] : run.worktree || "(unknown)";
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const group = (runs) => ({
  runs: runs.length,
  medianMinutes: runs.length ? median(runs.map((r) => r.seconds)) / 60 : 0,
  totalMinutes: runs.reduce((a, r) => a + r.seconds, 0) / 60,
  failures: runs.filter((r) => r.exit !== 0).length,
});
const by = (runs, key) => {
  const m = new Map();
  for (const r of runs) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return Object.fromEntries([...m].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, group(v)]));
};

/**
 * @param {string} text the log
 * @param {{ since?: string }} [options] a date (anything Date parses); earlier runs are left out
 */
export function summarize(text, { since } = {}) {
  const { runs: all, skipped } = parseLog(text);
  let cutoff = null;
  if (since) {
    cutoff = Date.parse(since);
    if (Number.isNaN(cutoff)) throw new Error(`--since: can't read the date "${since}"`);
  }
  const runs = cutoff === null ? all : all.filter((r) => Date.parse(r.start) >= cutoff);
  return { ...group(runs), skipped, byMode: by(runs, (r) => r.mode), byPrd: by(runs, prdOf) };
}

const fmtMin = (m) => `${m.toFixed(1)}`;
const row = (name, g) =>
  `  ${name.padEnd(24)} ${String(g.runs).padStart(4)} ${fmtMin(g.medianMinutes).padStart(8)} ${fmtMin(g.totalMinutes).padStart(8)} ${String(g.failures).padStart(9)}`;

export function formatSummary(s, { since } = {}) {
  const head = `  ${"".padEnd(24)} ${"runs".padStart(4)} ${"median m".padStart(8)} ${"total m".padStart(8)} ${"failures".padStart(9)}`;
  const lines = [`Checks${since ? ` since ${since}` : ""}: none recorded`];
  if (s.runs) {
    lines.length = 0;
    lines.push(
      `Checks${since ? ` since ${since}` : ""}:`,
      head,
      row("all", s),
      "By mode:",
      ...Object.entries(s.byMode).map(([k, g]) => row(k, g)),
      "By PRD:",
      ...Object.entries(s.byPrd).map(([k, g]) => row(k, g)),
    );
  }
  if (s.skipped) lines.push(`${s.skipped} malformed line${s.skipped === 1 ? "" : "s"} skipped`);
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let since;
  let file = process.env.CARETOOK_CHECK_LOG;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--since" && args[i + 1]) since = args[++i];
    else if (args[i] === "--log" && args[i + 1]) file = args[++i];
    else {
      console.error(`check --times: unknown argument ${args[i]} (--since <date>)`);
      process.exit(1);
    }
  }
  if (!file) {
    console.error("check-times.mjs needs --log <file> (or CARETOOK_CHECK_LOG)");
    process.exit(1);
  }
  try {
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    console.log(formatSummary(summarize(text, { since }), { since }));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
