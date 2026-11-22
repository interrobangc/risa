#!/usr/bin/env node
// pnpm prd dispatch: the dispatcher. Started once in a terminal tab of its own
// and left there; every tick it gathers the facts, asks the pick
// (dispatch-pick.mjs) for one action and does it, then logs the action and
// why it passed every other topic over.
//
//   pnpm prd dispatch [--every <seconds>]   tick every SECONDS (default 60) until stopped
//   pnpm prd dispatch --once                one tick, then exit
//   pnpm prd dispatch --dry-run             one tick's pick, printed: writes and opens nothing
//   pnpm prd dispatch --pause [<why>]       the running dispatcher (and any later one) does nothing
//   pnpm prd dispatch --resume              undo --pause
//   pnpm prd dispatch --stop                end the running dispatcher (TERM)
//
// The actions:
//   - start: `new.sh prd <topic>`, then a managed, run-through orchestrator
//     (session.sh prd-<t> --auto --managed, prompt.sh orchestrator <t> --auto)
//     in a background iTerm2 tab (the opener's --command … --background);
//   - plan: `new.sh plan <topic>`, then a managed, run-through planner
//     (session.sh plan-<t> --auto --managed, --model fable, prompt.sh plan <t>
//     --auto) the same way; no item ids: the prompt reads the topic's items;
//   - reopen: the opener (`open-session.sh <worktree> --background`), counted;
//   - ask: a reopen question filed with `pnpm prd ask` (session "dispatch"),
//     then a one-shot helper session (haiku, Remote Control, in a background
//     tab) whose prompt is "send this PushNotification, then pnpm prd end"; a
//     helper that can't start is ignored (the ask's own macOS notification and
//     CARETOOK_ASK_NOTIFY still fire). Its answer is acted on in a later tick:
//     "reopen again" resets the count, "hold the topic" flags the row `hold`.
// The session record (managed, auto) is written before a new session's tab
// opens, so a tab that never starts is reopened like a dead session.
//
// Every TIDY_EVERY_MS (six hours), on a tick that does nothing else (and isn't
// paused), it runs `pnpm prd tidy --yes`. A usage limit isn't detected: the
// user pauses and resumes. Without iTerm2 it refuses to run (it couldn't open
// sessions); --dry-run works anywhere.
//
// Files, in the main checkout's .loops: .dispatch.lock (the running
// instance's pid; a lock whose pid is gone is taken over), .dispatch.json (the
// state: paused and why, reopen counts, the open reopen asks, the last tidy),
// .dispatch.log (each acting tick, and each idle one whose lines changed).
//
// Env: CARETOOK_MAX_PRDS (3), CARETOOK_MAX_PLANNERS (1), CARETOOK_FIXES_MIN (3):
// the pick's caps; CARETOOK_LOAD_* (load-gate.mjs); CARETOOK_SESSIONS_DIR,
// CARETOOK_ASKS_DIR; CARETOOK_ITERM_APP (default /Applications/iTerm.app);
// CARETOOK_CLAUDE_BIN (the helper's claude); CARETOOK_CLOCK_FILE (tests: epoch
// seconds standing in for the clock).
import { execFileSync, spawnSync } from "node:child_process";
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAsk, listAsks } from "./asks.mjs";
import { DISPATCH_SESSION, REOPEN_OPTIONS, formatPick, pick } from "./dispatch-pick.mjs";
import { readLoadGate } from "./load-gate.mjs";
import { isLive, processOf, readRecords, writeRecord } from "./sessions.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** How often an idle tick runs `pnpm prd tidy --yes`. */
export const TIDY_EVERY_MS = 6 * 3600_000;
/** A reopened session live this long has recovered: its reopen count is dropped. */
export const REOPEN_RESET_MS = 30 * 60_000;
/** The one-shot helper that pushes the dispatcher's own asks. */
export const HELPER_SESSION = "dispatch-push";

// ---- the pure parts ----------------------------------------------------------------

/** What a reopen ask's answer means: "reset" (reopen again), "hold", or null (unclear). */
export function answerAction(/** @type {string | null | undefined} */ answer) {
  const a = String(answer ?? "")
    .trim()
    .toLowerCase();
  if (a === REOPEN_OPTIONS[0] || /^(1|reopen|again|yes)\b/.test(a)) return "reset";
  if (a === REOPEN_OPTIONS[1] || /^(2|hold)\b/.test(a)) return "hold";
  return null;
}

/** Whether this tick runs tidy: nothing else happened, not paused, six hours since the last. */
export function tidyDue(
  /** @type {{ lastTidy?: number }} */ state,
  /** @type {number} */ now,
  /** @type {{ action: string, paused: boolean }} */ tick,
) {
  if (tick.action !== "none" || tick.paused) return false;
  return typeof state.lastTidy === "number" && now - state.lastTidy >= TIDY_EVERY_MS;
}

/** A word safe in a shell line as is, else single-quoted. */
export const sh = (/** @type {string} */ s) =>
  /^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

/** The command a new managed, run-through session's tab runs. */
export function sessionLine(
  /** @type {{ kind: "prd" | "plan", topic: string, dir: string, wrapper: string }} */ s,
) {
  const name = `${s.kind}-${s.topic}`;
  const head = `cd ${sh(s.dir)} && ${sh(s.wrapper)} ${name} --auto --managed -- `;
  return s.kind === "plan"
    ? `${head}--model fable --remote-control ${name} "$(scripts/loops/prompt.sh plan ${sh(s.topic)} --auto)"`
    : `${head}--remote-control ${name} "$(scripts/loops/prompt.sh orchestrator ${sh(s.topic)} --auto)"`;
}

/** The helper's whole prompt: push LINE, then end. */
export const helperPrompt = (/** @type {string} */ line) =>
  `You are a one-shot helper for the Caretook dispatcher. Do exactly two things and nothing else: ` +
  `call the PushNotification tool once with this text: ${JSON.stringify(line)}. ` +
  `Then run \`pnpm prd end\` in Bash (it ends this session and closes its tab).`;

/** The helper's tab command. */
export const helperLine = (/** @type {{ main: string, claude: string, line: string }} */ h) =>
  `cd ${sh(h.main)} && ${sh(h.claude)} --model haiku --remote-control ${HELPER_SESSION} ${sh(helperPrompt(h.line))}`;

// ---- files -----------------------------------------------------------------------

/** The main checkout: the first worktree of the repo this file is in. */
export function mainCheckout(/** @type {string} */ from = HERE) {
  return execFileSync("git", ["-C", from, "worktree", "list", "--porcelain"], { encoding: "utf8" })
    .split("\n")[0]
    .replace(/^worktree /, "");
}

export function pathsOf(/** @type {string} */ main, env = process.env) {
  const loops = join(main, ".loops");
  return {
    main,
    loops,
    lock: join(loops, ".dispatch.lock"),
    state: join(loops, ".dispatch.json"),
    log: join(loops, ".dispatch.log"),
    sessions: env.CARETOOK_SESSIONS_DIR || join(loops, ".sessions"),
    asks: env.CARETOOK_ASKS_DIR || join(loops, ".asks"),
  };
}

/** @typedef {{ paused?: { at: string, why: string } | null, reopens?: Record<string, number>,
 *   asked?: Record<string, { id: string, topic: string }>, lastTidy?: number }} DispatchState */

/** @returns {DispatchState} */
export function readState(/** @type {string} */ file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** Re-reads the state, applies FN, writes it atomically: a --pause written mid-tick survives. */
export function updateState(/** @type {string} */ file, /** @type {(s: DispatchState) => void} */ fn) {
  const s = readState(file);
  fn(s);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(tmp, file);
  return s;
}

const alive = (/** @type {number} */ pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
};

/** The running dispatcher's pid, or null (no lock, or its pid is gone). */
export function lockHolder(/** @type {string} */ lock) {
  try {
    const pid = Number(readFileSync(lock, "utf8").trim());
    return alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Takes the lock for this process: { ok: true, took?: pid } or { ok: false, pid } (another runs). */
export function takeLock(/** @type {string} */ lock) {
  mkdirSync(dirname(lock), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
      return { ok: true };
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST") throw e;
      const holder = lockHolder(lock);
      if (holder && holder !== process.pid) return { ok: false, pid: holder };
      // A dead holder's lock: taken over.
      try {
        unlinkSync(lock);
      } catch {
        /* another taker removed it */
      }
    }
  }
  return { ok: false, pid: lockHolder(lock) ?? 0 };
}

const releaseLock = (/** @type {string} */ lock) => {
  try {
    if (Number(readFileSync(lock, "utf8").trim()) === process.pid) unlinkSync(lock);
  } catch {
    /* gone */
  }
};

// ---- facts -----------------------------------------------------------------------

const nowOf = (env = process.env) => {
  if (env.CARETOOK_CLOCK_FILE) {
    const s = Number(readFileSync(env.CARETOOK_CLOCK_FILE, "utf8").trim());
    if (Number.isFinite(s)) return s * 1000;
  }
  return Date.now();
};

const run = (/** @type {string} */ cmd, /** @type {string[]} */ args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
  return { ok: r.status === 0, code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};

const backlog = (/** @type {string} */ main, /** @type {string[]} */ args) =>
  run("node", [join(main, "scripts/backlog/backlog.mjs"), ...args], { cwd: main });

/** The .loops worktrees: { name, branch, dir }. */
export function worktreesOf(/** @type {string} */ main) {
  const loops = join(main, ".loops");
  const out = [];
  let dir = "";
  for (const l of execFileSync("git", ["-C", main, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
  }).split("\n")) {
    if (l.startsWith("worktree ")) dir = l.slice(9);
    else if (l.startsWith("branch ") && dirname(dir) === loops)
      out.push({ name: basename(dir), branch: l.slice(7).replace(/^refs\/heads\//, ""), dir });
  }
  return out;
}

const positive = (/** @type {string | undefined} */ s, /** @type {number} */ d) =>
  s && Number(s) > 0 ? Number(s) : d;

/** Everything the pick needs, and the records for the bookkeeping. */
export function gather(/** @type {ReturnType<typeof pathsOf>} */ p, env = process.env) {
  const listed = backlog(p.main, ["prd", "list", "--json"]);
  if (!listed.ok) throw new Error(`pnpm backlog prd list failed: ${listed.err || listed.out}`);
  const rows = JSON.parse(listed.out);
  const records = readRecords(p.sessions).map(({ name, record }) => {
    // When it went rotating: the record's own time if it has one, else the file's mtime (the
    // last write is rotate-into.sh's marking), so an old marking reads as old, never as just now.
    let rotatingAt = record.rotating
      ? (/** @type {{ rotatingAt?: string }} */ (record).rotatingAt ?? null)
      : null;
    if (record.rotating && rotatingAt === null)
      try {
        rotatingAt = statSync(join(p.sessions, `${name}.json`)).mtimeMs;
      } catch {
        /* gone */
      }
    return { name, record, live: isLive(record, processOf(record.pid ?? 0)), rotatingAt };
  });
  const state = readState(p.state);
  const gate = readLoadGate(env);
  return {
    state,
    records,
    gate,
    facts: {
      rows,
      worktrees: worktreesOf(p.main),
      sessions: records.map((r) => ({
        name: r.name,
        live: r.live,
        managed: r.record.managed === true,
        rotating: r.record.rotating === true,
        rotatingAt: r.rotatingAt,
      })),
      asks: listAsks(p.asks),
      reopens: state.reopens ?? {},
      busy: gate.busy,
      paused: Boolean(state.paused),
      caps: {
        prds: positive(env.CARETOOK_MAX_PRDS, 3),
        planners: positive(env.CARETOOK_MAX_PLANNERS, 1),
        fixesMin: positive(env.CARETOOK_FIXES_MIN, 3),
      },
      now: nowOf(env),
    },
  };
}

// ---- one tick --------------------------------------------------------------------

/**
 * One tick: the answers to its asks, the pick, the action, tidy. Returns the
 * lines it printed and the pick. With dryRun it only picks and prints.
 */
export function tick(
  /** @type {ReturnType<typeof pathsOf>} */ p,
  { dryRun = false, env = process.env, say = (/** @type {string} */ l) => console.log(l) } = {},
) {
  const lines = [];
  const out = (/** @type {string} */ l) => lines.push(l);
  let g;
  try {
    g = gather(p, env);
  } catch (e) {
    out(`nothing: couldn't gather the facts (${e instanceof Error ? e.message : String(e)})`);
    for (const l of lines) say(l);
    return { lines, action: "none", acted: false };
  }
  const { facts, records } = g;
  const now = facts.now;

  if (!dryRun) {
    // The answers to the dispatcher's own asks, from earlier ticks.
    const asked = g.state.asked ?? {};
    for (const [session, { id, topic }] of Object.entries(asked)) {
      const a = getAsk(p.asks, id);
      if (a && !a.answeredAt && !a.doneAt) continue;
      const what = a?.answeredAt ? answerAction(a.answer) : null;
      if (what === "hold") {
        const row = facts.rows.find((r) => r.topic === topic);
        const flags = [...new Set([...(row?.flags ?? []), "hold"])];
        const r = backlog(p.main, ["prd", "set", topic, `flags=${flags.join(",")}`]);
        out(
          r.ok
            ? `ask ${id} answered "${a.answer}": ${topic} flagged hold`
            : `ask ${id} answered "${a.answer}", but flagging ${topic} hold failed: ${r.err || r.out}`,
        );
        if (row && r.ok) row.flags = flags;
      } else if (what === "reset") out(`ask ${id} answered "${a.answer}": ${session} may be reopened again`);
      else
        out(
          a
            ? `ask ${id} ${a.answeredAt ? `answered "${a.answer}" (unclear)` : "dismissed"}: asking again`
            : `ask ${id} is gone: asking again`,
        );
      updateState(p.state, (s) => {
        delete s.asked?.[session];
        if (what) delete s.reopens?.[session];
      });
      if (what) delete facts.reopens[session];
    }
    // A reopened session live long enough has recovered; a count without a worktree is stale.
    const wtSessions = new Set(facts.worktrees.map((w) => w.branch.replace(/^(prd|plan)\/(.*)$/, "$1-$2")));
    const stale = Object.keys(facts.reopens).filter((name) => {
      const r = records.find((x) => x.name === name);
      if (!wtSessions.has(name)) return true;
      return r?.live && now - Date.parse(r.record.started ?? "") >= REOPEN_RESET_MS;
    });
    if (stale.length) {
      updateState(p.state, (s) => {
        for (const n of stale) delete s.reopens?.[n];
      });
      for (const n of stale) delete facts.reopens[n];
    }
    if (g.state.lastTidy === undefined) updateState(p.state, (s) => void (s.lastTidy ??= now));
  }

  const choice = pick(facts);
  const head = formatPick(choice);
  if (g.gate.busy) head.splice(1, 0, `  (the 5-minute load ${g.gate.load} is over ${g.gate.threshold})`);
  lines.push(...head);

  if (dryRun) {
    out("(dry run: nothing written, nothing opened)");
    for (const l of lines) say(l);
    return { lines, action: choice.action, acted: false };
  }

  const bin = HERE;
  const openTab = (/** @type {string} */ line, /** @type {string} */ title) =>
    run("bash", [join(bin, "open-session.sh"), "--command", line, "--title", title, "--background"], {
      cwd: p.main,
    });
  const result = (/** @type {{ ok: boolean, code: number | null, out: string, err: string }} */ r) =>
    r.ok ? r.out.split("\n").pop() || "ok" : `failed (exit ${r.code}): ${(r.err || r.out).split("\n").pop()}`;

  switch (choice.action) {
    case "start":
    case "plan": {
      const topic = /** @type {string} */ (choice.topic);
      const kind = choice.action === "start" ? "prd" : "plan";
      const name = kind === "prd" ? topic : `plan-${topic}`;
      const session = `${kind}-${topic}`;
      const dir = join(p.loops, name);
      if (!existsSync(dir)) {
        const made = run("bash", [join(bin, "new.sh"), kind, topic], { cwd: p.main });
        out(`  new.sh ${kind} ${topic}: ${result(made)}`);
        if (!made.ok) break;
      }
      writeRecord(p.sessions, session, { kind, topic, managed: true, auto: true });
      const opened = openTab(sessionLine({ kind, topic, dir, wrapper: join(bin, "session.sh") }), session);
      out(`  ${session}: ${result(opened)}`);
      break;
    }
    case "reopen": {
      const session = /** @type {string} */ (choice.session);
      updateState(p.state, (s) => {
        s.reopens = { ...s.reopens, [session]: (s.reopens?.[session] ?? 0) + 1 };
      });
      const r = run(
        "bash",
        [join(bin, "open-session.sh"), /** @type {string} */ (choice.worktree), "--background"],
        {
          cwd: p.main,
        },
      );
      out(`  ${session}: ${result(r)}`);
      break;
    }
    case "ask": {
      const session = /** @type {string} */ (choice.session);
      const topic = /** @type {string} */ (choice.topic);
      const args = ["ask", "--topic", topic, "--question", choice.text ?? "", "--session", DISPATCH_SESSION];
      for (const o of choice.options ?? []) args.push("--option", o);
      const r = run("node", [join(bin, "ask.mjs"), ...args], {
        cwd: p.main,
        env: { ...env, CARETOOK_ASKS_DIR: p.asks },
      });
      const id = r.ok ? r.out.split("\n")[0].trim() : "";
      if (!/^a\d+$/.test(id)) {
        out(`  filing the ask failed: ${result(r)}`);
        break;
      }
      updateState(p.state, (s) => {
        s.asked = { ...s.asked, [session]: { id, topic } };
      });
      const push =
        r.out
          .split("\n")
          .find((l) => l.startsWith("Now send a PushNotification: "))
          ?.slice("Now send a PushNotification: ".length) ?? `${topic}: ${choice.text}`;
      out(`  filed ask ${id}`);
      const helper = openTab(
        helperLine({ main: p.main, claude: env.CARETOOK_CLAUDE_BIN || "claude", line: push }),
        HELPER_SESSION,
      );
      out(
        helper.ok
          ? `  ${HELPER_SESSION}: ${result(helper)}`
          : `  ${HELPER_SESSION} didn't start (ignored): ${result(helper)}`,
      );
      break;
    }
    default:
      if (tidyDue(readState(p.state), now, { action: choice.action, paused: facts.paused })) {
        const r = run("node", [join(bin, "tidy-cli.mjs"), "--yes"], { cwd: p.main });
        updateState(p.state, (s) => void (s.lastTidy = now));
        out(`tidy --yes: ${result(r)}`);
        for (const l of lines) say(l);
        return { lines, action: "tidy", acted: true };
      }
  }
  for (const l of lines) say(l);
  return { lines, action: choice.action, acted: choice.action !== "none" };
}

// ---- the command line ------------------------------------------------------------

const onPath = (/** @type {string} */ cmd) =>
  (process.env.PATH ?? "").split(delimiter).some((d) => {
    try {
      accessSync(join(d, cmd), constants.X_OK);
      return Boolean(d);
    } catch {
      return false;
    }
  });

const stamp = (/** @type {number} */ ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

function parse(/** @type {string[]} */ argv) {
  const o = {
    every: 60,
    once: false,
    dryRun: false,
    pause: /** @type {string | null} */ (null),
    resume: false,
    stop: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--every") {
      o.every = Number(argv[++i]);
      if (!(o.every > 0)) throw new Error("--every takes a number of seconds");
    } else if (a === "--once") o.once = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--pause") o.pause = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "";
    else if (a === "--resume") o.resume = true;
    else if (a === "--stop") o.stop = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else
      throw new Error(
        `dispatch: unknown argument ${a} (--every <s>, --once, --dry-run, --pause [<why>], --resume, --stop)`,
      );
  }
  return o;
}

async function main() {
  let o;
  try {
    o = parse(process.argv.slice(2));
  } catch (e) {
    console.error(`pnpm prd: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  if (o.help) {
    const text = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
    console.log(
      text
        .slice(1, 12)
        .map((l) => l.replace(/^\/\/ ?/, ""))
        .join("\n"),
    );
    return;
  }
  const p = pathsOf(mainCheckout());
  const log = (/** @type {string[]} */ lines, /** @type {number} */ now) => {
    mkdirSync(p.loops, { recursive: true });
    appendFileSync(
      p.log,
      lines.map((l, i) => (i ? (l.startsWith("  ") ? l : `  ${l}`) : `${stamp(now)} ${l}`)).join("\n") + "\n",
    );
  };

  if (o.pause !== null || o.resume) {
    if (o.pause !== null && o.resume) throw new Error("--pause or --resume, not both");
    const now = nowOf();
    updateState(p.state, (s) => {
      s.paused = o.pause !== null ? { at: stamp(now), why: o.pause || "paused by hand" } : null;
    });
    const line = o.pause !== null ? `paused${o.pause ? `: ${o.pause}` : ""}` : "resumed";
    log([line], now);
    const holder = lockHolder(p.lock);
    console.log(
      `Dispatcher ${line}${holder ? ` (pid ${holder} reads it on its next tick)` : " (none is running)"}.`,
    );
    return;
  }
  if (o.stop) {
    const holder = lockHolder(p.lock);
    if (!holder) {
      console.log("No dispatcher is running.");
      return;
    }
    process.kill(holder, "SIGTERM");
    // It releases the lock on its way out (a zombie still answers kill 0).
    const held = () => lockHolder(p.lock) === holder;
    for (let i = 0; i < 100 && held(); i++) await new Promise((r) => setTimeout(r, 100));
    console.log(
      held()
        ? `Sent TERM to the dispatcher (pid ${holder}); it hasn't exited yet.`
        : `Stopped the dispatcher (pid ${holder}).`,
    );
    return;
  }
  if (o.dryRun) {
    tick(p, { dryRun: true });
    return;
  }

  const iterm = process.env.CARETOOK_ITERM_APP || "/Applications/iTerm.app";
  if (!existsSync(iterm) || !onPath("osascript")) {
    console.error(
      `pnpm prd: dispatch needs iTerm2 (${iterm}) to open sessions; --dry-run shows what it would do`,
    );
    process.exit(1);
  }
  const lock = takeLock(p.lock);
  if (!lock.ok) {
    console.error(`pnpm prd: a dispatcher is already running (pid ${lock.pid}); --stop ends it`);
    process.exit(1);
  }
  let stopping = false;
  const stop = (/** @type {string} */ sig) => {
    if (stopping) return;
    stopping = true;
    log([`stopped (${sig})`], nowOf());
    releaseLock(p.lock);
    process.exit(0);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("exit", () => releaseLock(p.lock));

  if (!o.once) {
    log([`started (pid ${process.pid}, every ${o.every}s)`], nowOf());
    console.log(
      `Dispatcher running (pid ${process.pid}, every ${o.every}s). --pause, --resume, --stop from any shell.`,
    );
  }
  let last = "";
  for (;;) {
    const now = nowOf();
    const quiet = [];
    const t = tick(p, { say: (l) => quiet.push(l) });
    const text = t.lines.join("\n");
    if (o.once || t.acted || text !== last) {
      log(t.lines, now);
      console.log(`${stamp(now)} ${quiet.join("\n")}`);
    }
    last = text;
    if (o.once) break;
    await new Promise((r) => setTimeout(r, o.every * 1000));
  }
  releaseLock(p.lock);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(`pnpm prd: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
