#!/usr/bin/env node
// The finish of a landed topic whose orchestrator stopped short (RISA-811): its
// sessions ended, its worktree and slot removed, its row done, with one report.
// Pure decision, thin CLI (the resume.mjs and tidy.mjs pattern).
//
//   - finishDecision(facts): what to do with one topic:
//       running  not landed, or a standing topic (it never finishes)
//       clean    landed, and nothing is left: no worktree, no slot, its row done
//       wait     a recorded session is busy (a running call in any of its
//                heartbeat records, or an event in the last idle minutes), or a
//                landing journal names its branch, or the registry can't be read
//       report   kept, nothing ended: a code tail, a dirty worktree, slice
//                worktrees left, a live claude in the worktree no record names,
//                a live recorded session with no heartbeat record, or no worktree
//                left with a slot or a row not done (the line that clears it);
//                null instead when its key (reportKey: topic, reasons, tip) is
//                in facts.reported, so a kept tip is reported once
//       act      { end: [the recorded live sessions], rm: true }: only once every
//                report reason is ruled out
//   - landedWithCode(repo, topics, trunk): the topics whose last landing is in
//     the trunk and with code past it (landed.mjs's tailOf `code`): { [topic]:
//     { sha } }. The caller leaves standing topics out, as for landedTopics.
//   - gatherFinish(topic, opts): the facts, from git, the registry, the session
//     records, the process table (sessions.mjs liveIn), the heartbeat folder and
//     the landing journals.
//
// CLI: node finish.mjs <topic> [--dry-run] [--json]   (prd finish)
//   acts on the decision: end-session.sh for each recorded session, then rm.sh
//   <topic> from the main checkout (never --force), then one report (session
//   `finish`) naming what it ended and rm's lines, or what it kept and why.
//   --dry-run prints the decision and changes nothing; --json prints JSON.
// Env: TRUNK, RISA_MAIN, RISA_SESSIONS_DIR (the heartbeat folder beside it),
// RISA_LANDING_DIR, RISA_ASKS_DIR, RISA_FINISH_IDLE_MIN (10).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { branchKinds, toolCmd } from "./config.mjs";
import { heartbeatDirOf, readHeartbeats } from "./heartbeat.mjs";
import { listRecords } from "./land-journal.mjs";
import { doneFlags, landedTopics, tailOf } from "./landed.mjs";
import { claudeName, cwdOf, isLive, liveIn, processOf, processTable, readRecords } from "./sessions.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** A recorded session is idle once its last heartbeat event is this many minutes old. */
export const IDLE_MIN = 10;

/**
 * @typedef {{ running?: Record<string, { tool?: string, at?: string }>, firstAt?: string | null,
 *   lastStart?: string | null, lastEnd?: string | null, stoppedAt?: string | null, agent?: string | null }} Heartbeat
 * @typedef {object} FinishFacts
 * @property {string} topic
 * @property {boolean} landed            in landedTopics or landedWithCode
 * @property {string | null} [sha]       the landing merge
 * @property {string | null} [tail]      landed.mjs's tail kind
 * @property {number} [tailCommits]
 * @property {string | null} [branch]
 * @property {string | null} [tip]       the branch's tip
 * @property {{ name: string, dir: string, dirty: boolean } | null} [worktree]
 * @property {string | null} [slot]      the slot its worktree's name holds
 * @property {string[]} [sliceWorktrees]
 * @property {{ topic: string, flags: string[] } | null} [row]   null: no row
 * @property {string} [registryError]   why the registry couldn't be read
 * @property {{ name: string, pid: number, heartbeats: Heartbeat[] }[]} [sessions]   the recorded live ones
 * @property {number[]} [unrecorded]     live claude pids in the worktree no record names
 * @property {{ branch: string, step?: string } | null} [journal]
 * @property {number} [now]
 * @property {number} [idleMin]
 * @property {string[]} [reported]      the report keys already filed
 *
 * @typedef {{ reason: string, why: string, line?: string }} Reason
 * @typedef {{ kind: "running" | "clean", topic: string, why: string }
 *   | { kind: "wait", topic: string, why: string, waits: string[] }
 *   | { kind: "report", topic: string, why: string, reasons: Reason[], key: string }
 *   | { kind: "act", topic: string, why: string, end: string[], rm: true }} FinishDecision
 */

/** The key a report is filed under: once per topic, reasons and tip. */
export const reportKey = (
  /** @type {string} */ topic,
  /** @type {string[]} */ reasons,
  /** @type {string | null | undefined} */ tip,
) => `${topic}\t${reasons.join("+")}\t${tip || "-"}`;

const plural = (/** @type {number} */ n, /** @type {string} */ word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The newest event in a session's heartbeat records, in ms (0: none). @param {Heartbeat[]} hb */
const lastEvent = (hb) =>
  Math.max(
    0,
    ...hb.flatMap((r) =>
      [r.firstAt, r.lastStart, r.lastEnd, r.stoppedAt].map((t) => Date.parse(t ?? "") || 0),
    ),
  );

/**
 * @param {FinishFacts} facts
 * @returns {FinishDecision | null} null: a report already filed for this key
 */
export function finishDecision(facts) {
  const { topic } = facts;
  const branch = facts.branch ?? branchKinds().branch("prd", topic);
  if (facts.row?.flags?.includes("standing"))
    return { kind: "running", topic, why: `${topic} is standing: it never finishes` };
  if (facts.registryError)
    return {
      kind: "wait",
      topic,
      why: "the PRD registry can't be read",
      waits: [`the PRD registry can't be read (${facts.registryError})`],
    };
  if (!facts.landed)
    return { kind: "running", topic, why: `${branch} hasn't landed with nothing left to run` };

  const now = facts.now ?? Date.now();
  const idleMs = (facts.idleMin ?? IDLE_MIN) * 60_000;
  const sessions = facts.sessions ?? [];
  /** @type {string[]} */ const waits = [];
  if (facts.journal)
    waits.push(
      `a landing of ${facts.journal.branch} is in flight (its journal is at ${facts.journal.step ?? "?"}; if it was cut off: ${toolCmd.prd} land --resume ${facts.journal.branch})`,
    );
  for (const s of sessions) {
    const hb = s.heartbeats ?? [];
    if (!hb.length) continue; // a report reason, below
    const call = hb.flatMap((r) => Object.values(r.running ?? {}))[0];
    const ago = now - lastEvent(hb);
    if (call) waits.push(`${s.name} is running a call (${call.tool ?? "a tool"})`);
    else if (ago < idleMs)
      waits.push(`${s.name}'s last event was ${Math.max(0, Math.floor(ago / 60_000))} min ago`);
  }
  if (waits.length) return { kind: "wait", topic, why: waits.join("; "), waits };

  /** @type {Reason[]} */ const reasons = [];
  if (facts.tail === "code")
    reasons.push({
      reason: "code",
      why: `${branch} has ${plural(facts.tailCommits ?? 0, "commit")} past its last landing that aren't Markdown only`,
      line: `land it (${toolCmd.prd} land ${branch}) or drop it by hand`,
    });
  const wt = facts.worktree ?? null;
  if (wt) {
    if (wt.dirty)
      reasons.push({
        reason: "dirty",
        why: `its worktree ${wt.name} has uncommitted changes`,
        line: `commit or drop them in ${wt.dir}`,
      });
    const slices = facts.sliceWorktrees ?? [];
    if (slices.length)
      reasons.push({
        reason: "slices",
        why: `slice worktrees ${slices.join(", ")} are left`,
        line: slices.map((n) => `${toolCmd.prd} rm ${n}`).join("; "),
      });
    const unrecorded = facts.unrecorded ?? [];
    if (unrecorded.length)
      reasons.push({
        reason: "unrecorded",
        why: `a claude no session record names works in ${wt.name} (pid ${unrecorded.join(", ")})`,
        line: "ask it, then close it",
      });
    for (const s of sessions.filter((s) => !(s.heartbeats ?? []).length))
      reasons.push({
        reason: "no-heartbeat",
        why: `${s.name} (pid ${s.pid}) is live with no heartbeat record, so whether it is idle is unknown`,
        line: `ask it, then ${toolCmd.prd} end ${s.name}`,
      });
  } else {
    if (facts.slot)
      reasons.push({
        reason: "slot",
        why: `its slot ${facts.slot} is left with no worktree`,
        line: `${toolCmd.prd} tidy --yes`,
      });
    const flags = facts.row ? doneFlags([facts.row], topic) : null;
    if (flags && "flags" in flags)
      reasons.push({
        reason: "row",
        why: `its registry row isn't done`,
        line: `${toolCmd.backlog} prd set ${topic} flags=${flags.flags.join(",")}`,
      });
    if (!reasons.length) return { kind: "clean", topic, why: "landed, and nothing is left" };
  }
  if (reasons.length) {
    const key = reportKey(
      topic,
      reasons.map((r) => r.reason),
      facts.tip,
    );
    if ((facts.reported ?? []).includes(key)) return null;
    return { kind: "report", topic, why: reasons.map((r) => r.why).join("; "), reasons, key };
  }
  const end = sessions.map((s) => s.name);
  return {
    kind: "act",
    topic,
    why: `landed${facts.tail && facts.tail !== "merged" ? ` (a ${facts.tail} tail)` : ""}, and ${end.length ? `${end.join(", ")} ${end.length === 1 ? "is" : "are"} idle` : "no session is live"}`,
    end,
    rm: true,
  };
}

const tryGit = (/** @type {string} */ repo, /** @type {string[]} */ args) => {
  try {
    return execFileSync("git", ["--no-optional-locks", "-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
};

/**
 * The topics whose last landing is in the trunk with code past it. Never throws.
 * @param {string} repo @param {string[]} topics @param {string} [trunk]
 * @returns {Record<string, { sha: string }>}
 */
export function landedWithCode(repo, topics, trunk) {
  /** @type {Record<string, { sha: string }>} */
  const out = {};
  try {
    const kinds = branchKinds();
    const tr = trunk ?? kinds.trunk;
    for (const topic of topics) {
      const branch = kinds.branch("prd", topic);
      if (!tryGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) continue;
      const tail = tailOf(repo, branch, tr, topic);
      if (tail.landing && tail.kind === "code") out[topic] = { sha: tail.landing };
    }
  } catch {
    /* unreadable: none */
  }
  return out;
}

const real = (/** @type {string} */ p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** `git worktree list --porcelain` as { path, branch } rows. @param {string} main */
function worktreeList(main) {
  /** @type {{ path: string, branch: string }[]} */
  const out = [];
  for (const block of (tryGit(main, ["worktree", "list", "--porcelain"]) ?? "").split("\n\n")) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? "";
    if (path) out.push({ path, branch });
  }
  return out;
}

/**
 * The facts finishDecision reads, for TOPIC in the main checkout MAIN.
 * @param {string} topic
 * @param {{ main: string, env?: NodeJS.ProcessEnv, now?: number, reported?: string[],
 *   table?: Map<number, { ppid: number, args: string }>, cwdOf?: (pid: number) => string | null,
 *   claude?: string, rows?: { topic: string, flags: string[] }[] | null }} opts
 * @returns {FinishFacts}
 */
export function gatherFinish(topic, opts) {
  const { main, env = process.env, now = Date.now(), reported = [] } = opts;
  const kinds = branchKinds();
  const trunk = env.TRUNK || kinds.trunk;
  const loops = join(main, ".loops");
  const branch = kinds.branch("prd", topic);
  const tip = tryGit(main, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) || null;

  /** @type {Partial<FinishFacts>} */
  let reg = {};
  let rows = opts.rows;
  if (rows === undefined) {
    const r = spawnSync(process.execPath, [join(HERE, "../backlog/backlog.mjs"), "prd", "list", "--json"], {
      cwd: main,
      env,
      encoding: "utf8",
    });
    try {
      rows = r.status === 0 ? JSON.parse(r.stdout) : null;
    } catch {
      rows = null;
    }
    if (!rows)
      reg = { registryError: `${toolCmd.backlog} prd list failed: ${(r.stderr || r.stdout || "").trim()}` };
  }
  const row = rows?.find((r) => r.topic === topic) ?? null;

  const standing = !!row?.flags?.includes("standing");
  const plain = !standing && tip ? landedTopics(main, [topic], trunk)[topic] : undefined;
  const code = !standing && tip && !plain ? landedWithCode(main, [topic], trunk)[topic] : undefined;
  const tail = tip && (plain || code) ? tailOf(main, branch, trunk, topic) : null;

  const listed = worktreeList(main);
  const own = listed.find((w) => w.branch === branch);
  const dir = own ? real(own.path) : null;
  const worktree =
    own && dir ? { name: basename(own.path), dir, dirty: !!tryGit(dir, ["status", "--porcelain"]) } : null;
  const sliceWorktrees = listed
    .filter((w) => kinds.sliceOf(w.branch)?.topic === topic)
    .map((w) => basename(w.path));

  const slotName = worktree?.name ?? topic;
  const slots = join(loops, ".slots");
  let slot = null;
  if (existsSync(slots))
    for (const n of readdirSync(slots)) {
      let holder = "";
      try {
        holder = readFileSync(join(slots, n, "name"), "utf8").trim();
      } catch {
        /* not a slot */
      }
      if (holder === slotName) slot = join(slots, n);
    }

  const sessionsDir = env.RISA_SESSIONS_DIR || join(loops, ".sessions");
  const recorded = readRecords(sessionsDir).filter(
    ({ name, record }) =>
      name === `prd-${topic}` || (!!dir && !!record?.dir && real(String(record.dir)) === dir),
  );
  const live = recorded.filter(({ record }) => isLive(record, processOf(record?.pid ?? 0, now), now));
  const heartbeatDir = heartbeatDirOf(sessionsDir);
  const sessions = live.map(({ name, record }) => ({
    name,
    pid: Number(record?.pid),
    heartbeats: readHeartbeats(heartbeatDir, (s, pid) => s === name && pid === record?.pid),
  }));
  const pids = new Set(sessions.map((s) => s.pid));
  const unrecorded = dir
    ? liveIn(dir, {
        table: opts.table ?? processTable(),
        cwdOf: opts.cwdOf ?? cwdOf,
        claude: opts.claude ?? claudeName(),
      }).filter((p) => !pids.has(p))
    : [];

  const journal = listRecords(env.RISA_LANDING_DIR || join(loops, ".landing")).find(
    (r) => r.branch === branch,
  );
  const idleMin = Number(env.RISA_FINISH_IDLE_MIN);

  return {
    topic,
    landed: !!(plain || code),
    sha: (plain ?? code)?.sha ?? null,
    tail: tail?.kind ?? null,
    tailCommits: tail?.commits ?? 0,
    branch,
    tip,
    worktree,
    slot,
    sliceWorktrees,
    row,
    ...reg,
    sessions,
    unrecorded,
    journal: journal ? { branch, step: journal.step } : null,
    now,
    idleMin: Number.isFinite(idleMin) && env.RISA_FINISH_IDLE_MIN ? idleMin : IDLE_MIN,
    reported,
  };
}

/** The decision as text lines. @param {FinishDecision | null} d @param {string} topic */
export function formatDecision(d, topic) {
  if (!d) return [`finish ${topic}: reported already (this tip, these reasons): nothing to do`];
  const head = `finish ${topic}: ${d.kind}: ${d.why}`;
  if (d.kind === "report")
    return [head, ...d.reasons.map((r) => `  - ${r.why}${r.line ? ` (${r.line})` : ""}`)];
  if (d.kind === "act")
    return [head, `  end: ${d.end.length ? d.end.join(", ") : "none"}`, `  then: ${toolCmd.prd} rm ${topic}`];
  return [head];
}

/**
 * Applies an act or report decision: ends the sessions, runs rm.sh, files the
 * report. Returns what it did. @param {FinishDecision} d
 * @param {{ main: string, env?: NodeJS.ProcessEnv, name?: string }} opts the worktree's name for rm
 */
export function applyFinish(d, { main, env = process.env, name = d.topic }) {
  const bash = (/** @type {string} */ script, /** @type {string[]} */ args) => {
    const r = spawnSync("bash", [join(HERE, script), ...args], { cwd: main, env, encoding: "utf8" });
    return {
      ok: r.status === 0,
      lines: `${r.stdout ?? ""}${r.stderr ?? ""}`.split("\n").filter((l) => l.trim()),
    };
  };
  /** @type {string[]} */ const ended = [];
  /** @type {string[]} */ let text;
  let ok = true;
  if (d.kind === "act") {
    /** @type {string | null} */ let failed = null;
    /** @type {string[]} */ let failLines = [];
    for (const s of d.end) {
      const r = bash("end-session.sh", [s]);
      if (!r.ok) {
        failed = s;
        failLines = r.lines;
        break;
      }
      ended.push(s);
    }
    if (failed) {
      ok = false;
      text = [
        `${toolCmd.prd} finish ${d.topic}: kept it: couldn't end ${failed}${ended.length ? ` (ended ${ended.join(", ")})` : ""}:`,
        ...failLines.map((l) => `  ${l}`),
      ];
    } else {
      const rm = bash("rm.sh", [name]);
      ok = rm.ok;
      text = [
        `${toolCmd.prd} finish ${d.topic}: ${ended.length ? `ended ${ended.join(", ")}; ` : ""}${rm.ok ? `removed ${name}` : `${toolCmd.prd} rm ${name} failed`}:`,
        ...rm.lines.map((l) => `  ${l}`),
      ];
    }
  } else if (d.kind === "report") {
    text = [
      `${toolCmd.prd} finish ${d.topic}: kept it, nothing ended:`,
      ...d.reasons.map((r) => `- ${r.why}${r.line ? ` (${r.line})` : ""}`),
    ];
  } else return { ok, ended, report: null, filed: false };
  const r = spawnSync(
    process.execPath,
    [join(HERE, "ask.mjs"), "ask", "--topic", d.topic, "--session", "finish", "--report", text.join("\n")],
    {
      cwd: main,
      encoding: "utf8",
      env: { ...env, RISA_ASKS_DIR: env.RISA_ASKS_DIR || join(main, ".loops/.asks") },
    },
  );
  if (r.status !== 0) console.error(`finish: couldn't file the report: ${(r.stderr || "").trim()}`);
  return { ok: ok && r.status === 0, ended, report: text.join("\n"), filed: r.status === 0 };
}

function main() {
  const argv = process.argv.slice(2);
  let dry = false;
  let json = false;
  /** @type {string | null} */ let topic = null;
  const usage = `usage: ${toolCmd.prd} finish <topic> [--dry-run] [--json]`;
  for (const a of argv) {
    if (a === "--dry-run" || a === "-n") dry = true;
    else if (a === "--json") json = true;
    else if (a === "-h" || a === "--help") return console.log(usage);
    else if (!a.startsWith("-") && !topic) topic = a;
    else {
      console.error(usage);
      process.exit(2);
    }
  }
  if (!topic) {
    console.error(usage);
    process.exit(2);
  }
  const mainDir =
    process.env.RISA_MAIN ||
    (tryGit(HERE, ["worktree", "list", "--porcelain"]) ?? "").split("\n")[0].replace(/^worktree /, "");
  const facts = gatherFinish(topic, { main: mainDir });
  const d = finishDecision(facts);
  if (dry || !d || !["act", "report"].includes(d.kind)) {
    if (json) console.log(JSON.stringify({ decision: d }, null, 2));
    else console.log(formatDecision(d, topic).join("\n"));
    return;
  }
  const did = applyFinish(d, { main: mainDir, name: facts.worktree?.name ?? topic });
  if (json) console.log(JSON.stringify({ decision: d, ...did }, null, 2));
  else console.log(did.report ?? formatDecision(d, topic).join("\n"));
  if (!did.ok) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
