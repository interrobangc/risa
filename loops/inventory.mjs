// The recovery inventory: the one place that decides what each .loops worktree
// is and what `recover` does about it. Pure: a facts object in
// (inventory-facts.mjs collects one), a classification and an ordered action
// list out. `down`, `recover`, `reclaim` and the recovery agent read this; they
// don't re-derive it.
//
// Classes:
//   prd        a PRD integration worktree (prd/<topic>)
//   plan       a planning worktree (plan/<topic>)
//   active     an unmerged slice worktree with a stack
//   merged     a slice worktree whose tip is merged into its PRD branch
//   stackless  an unmerged slice worktree without a stack, or any other branch
//
// Actions, in this fixed order (`recover` runs them top to bottom):
//   docker start          Docker doesn't answer
//   keep-dispatch-intent  the dispatch action is planned and its intent isn't
//                         kept yet: written before the stale lock is cleared, so
//                         a reopen that fails is retried by the next recover
//   clear-lock <path>     a lock whose holder is gone (never a live one), or a
//                         migrate marker whose worktree is gone
//   test-db up            the shared test Postgres isn't running
//   stack up <name>       one at a time: without a down record, prd and active
//                         worktrees whose stack isn't up; with one, its stacks;
//                         and any stack whose migrate was cut off (its marker in
//                         .loops/.migrate/), up or not: the migrate reruns
//   serve <name>          without a record, prd worktrees whose server is down;
//                         with one, its servers
//   dispatch              the dispatcher isn't running but was: the down record
//                         says so, its lock's pid is gone (a crash), or a kept
//                         intent says so (an earlier reopen failed); recover
//                         reopens it in a background tab only when every step
//                         above succeeded, and waits for it to hold its lock
//   drop-dispatch-intent  a kept intent while the dispatcher runs: done with
//   resume-landing <branch>  a landing cut off midway (its journal in
//                         .loops/.landing/, land-journal.mjs): recover only lists
//                         it; the recovery agent and a resumed orchestrator run
//                         `land --resume <branch>` before anything else
//   offer-gc <name>       merged slices (a dirty one is offered, and gc keeps it)
//   open-session <name>   every prd and plan worktree (the recovery agent skips
//                         the ones with a live session, and managed ones while
//                         the dispatcher runs: it reopens those itself)
//   delete-down-record    last, when a down record was used
//
// Every step is skipped when it's already true (a stack up, a server running),
// so a second `recover` only has sessions and gc offers left.
//
// The down record (.loops/.down.json, written by the down command):
//   { "at": "<ISO time>", "stacks": ["<name>", …], "servers": ["<name>", …], "testDb": true,
//     "dispatcher": true }
// Names that no longer have a worktree are skipped, with a warning.
import { branchKinds, toolCmd } from "./config.mjs";

export const CLASSES = ["prd", "plan", "active", "merged", "stackless"];
export const STEPS = [
  "docker start",
  "keep-dispatch-intent",
  "clear-lock",
  "test-db up",
  "stack up",
  "serve",
  "dispatch",
  "drop-dispatch-intent",
  "resume-landing",
  "offer-gc",
  "open-session",
  "delete-down-record",
];
export const DEFAULT_MIN_FREE_GB = 10;

/**
 * @typedef {object} WorktreeFacts
 * @property {string} name          its directory name in .loops
 * @property {string} branch        the checked-out branch ("" when detached)
 * @property {string} [parent]      the branch it merges into
 * @property {boolean} [merged]     a slice whose tip is merged into its parent
 * @property {boolean} [dirty]      uncommitted changes
 * @property {string|null} [stack]  its Compose project (the stack hook's name for it), or null
 * @property {boolean} [stackFailed]  the stackReady hook failed: the project is
 *   stackStatus's, its containers unknown
 * @property {number} [containersUp]   running containers in that project
 * @property {number} [containersAll]  all containers in it, running or not
 * @property {number|null} [stoppedSecs]  how long ago the stack stopped
 * @property {number|null} [webPort]
 * @property {boolean} [serverRunning]
 * @property {string} [migrating]  a migrate recover started there never finished: since when
 *
 * @typedef {object} LockFacts
 * @property {"slot"|"dispatch"|"backlog"|"lease"|"migrate"} kind
 *   slot: .loops/.slots/<N>; dispatch: .loops/.dispatch.lock (the dispatcher's pid);
 *   backlog: the backlog lock; lease: a machine-wide lease (reported, never cleared:
 *   lease.sh takes over a dead holder by itself); migrate: a migrate marker whose
 *   worktree is gone (always stale)
 * @property {string} path
 * @property {boolean} alive        its holder is still there
 * @property {number|null} [pid]
 * @property {string} [holder]      who holds it (a worktree name, a topic, a label)
 * @property {string} [why]         how alive was decided
 *
 * @typedef {object} Facts
 * @property {WorktreeFacts[]} worktrees
 * @property {LockFacts[]} [locks]
 * @property {{ running: boolean, pid?: number|null }} [dispatcher]
 * @property {{ at?: string, why?: string } | null} [dispatchIntent]  recover's kept intent to reopen it
 * @property {{ running: boolean, pid?: number|null }} [recover]  a recover holding its lock
 * @property {string[]} [managed]   session names whose record the dispatcher manages
 * @property {{ running: boolean }} [docker]
 * @property {{ running: boolean }} [testDb]
 * @property {{ at?: string, stacks?: string[], servers?: string[], testDb?: boolean, dispatcher?: boolean } | null} [downRecord]
 * @property {string} [downRecordPath]
 * @property {string} [downRecordError]   it exists but can't be read
 * @property {{ freeGb: number|null, minGb?: number }} [disk]
 * @property {LandingFacts[]} [landings]   cut-off landings: the journal's records
 *
 * @typedef {object} LandingFacts
 * @property {string} branch
 * @property {string} [path]   pr or local
 * @property {string} [step]   the step it was about to run
 * @property {string} [at]     when it recorded that step
 * @property {string} [file]
 *
 * @typedef {{ step: string, target?: string, why: string, dirty?: boolean, session?: string, managed?: boolean }} Action
 */

/** The class of one worktree and why. @param {WorktreeFacts} w */
export function classify(w) {
  const b = w.branch ?? "";
  if (branchKinds().is(b, "prd")) return { class: "prd", why: `PRD integration branch ${b}` };
  if (branchKinds().is(b, "plan")) return { class: "plan", why: `planning branch ${b}` };
  if (branchKinds().sliceOf(b)) {
    if (w.merged)
      return {
        class: "merged",
        why: `${b} is merged into ${w.parent ?? "its PRD branch"}${w.dirty ? " (dirty: gc keeps it)" : ""}`,
      };
    if (w.stack) return { class: "active", why: `unmerged slice with stack ${w.stack}` };
    return { class: "stackless", why: "unmerged slice without a stack: nothing to bring back" };
  }
  return {
    class: "stackless",
    why: b
      ? `${b} isn't a ${branchKinds().prefixes.prd}, ${branchKinds().prefixes.plan} or ${branchKinds().prefixes.slice} branch: nothing to bring back`
      : "detached HEAD: nothing to bring back",
  };
}

const stackIsUp = (/** @type {WorktreeFacts} */ w) =>
  (w.containersUp ?? 0) > 0 && (w.containersUp ?? 0) >= (w.containersAll ?? 0);

/** The Remote Control name of a prd or plan worktree's session: prd-<topic> or plan-<topic>. */
export const sessionName = (/** @type {{ class: string, branch: string }} */ w) =>
  `${w.class}-${w.branch.replace(/^(prd|plan)\//, "")}`;

/** prd worktrees first, then the rest, each by name. */
const recoveryOrder = (/** @type {{ name: string, class: string }[]} */ list) =>
  [...list].sort(
    (a, b) => (a.class === "prd" ? 0 : 1) - (b.class === "prd" ? 0 : 1) || a.name.localeCompare(b.name),
  );

/**
 * The inventory: one entry per worktree, the locks split into stale and live,
 * the disk, warnings, and the ordered actions.
 * @param {Facts} facts
 */
export function inventory(facts) {
  const worktrees = (facts.worktrees ?? [])
    .map((w) => ({ ...w, ...classify(w) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const byName = new Map(worktrees.map((w) => [w.name, w]));
  const locks = facts.locks ?? [];
  const stale = locks.filter((l) => !l.alive && l.kind !== "lease");
  const live = locks.filter((l) => l.alive);
  const takenOver = locks.filter((l) => !l.alive && l.kind === "lease");
  const record = facts.downRecord ?? null;
  const dockerUp = facts.docker?.running ?? false;
  const warnings = [];

  const minGb = facts.disk?.minGb ?? DEFAULT_MIN_FREE_GB;
  const freeGb = facts.disk?.freeGb ?? null;
  const disk = { freeGb, minGb, low: freeGb != null && freeGb < minGb };
  if (disk.low)
    warnings.push(
      `free disk is ${freeGb} GB, under ${minGb} GB: new stacks may be refused (${toolCmd.prd} reclaim)`,
    );
  if (facts.downRecordError) warnings.push(`can't read the down record: ${facts.downRecordError} (ignored)`);
  for (const l of takenOver)
    warnings.push(`${l.path}: ${l.holder ?? "its holder"} is gone; lease.sh takes it over by itself`);
  for (const w of worktrees.filter((w) => w.migrating))
    warnings.push(
      `${w.name}: a migrate was cut off (started ${w.migrating})${w.stack ? "; the stack step reruns it" : ", and it has no stack now"}`,
    );

  /** @type {Action[]} */
  const actions = [];
  const add = (/** @type {Action} */ a) => actions.push(a);

  if (!dockerUp) add({ step: "docker start", why: "Docker doesn't answer" });
  for (const l of stale)
    add({ step: "clear-lock", target: l.path, why: l.why ?? `${l.kind} lock whose holder is gone` });

  const known = (/** @type {string} */ name, /** @type {string} */ what) => {
    if (byName.has(name)) return true;
    warnings.push(`the down record lists ${what} ${name}, which has no worktree now: skipped`);
    return false;
  };
  const wantTestDb = record ? record.testDb !== false : true;
  if (wantTestDb && !(dockerUp && facts.testDb?.running))
    add({
      step: "test-db up",
      why: record ? "the down record had it running" : "the shared test Postgres isn't running",
    });

  /** @type {typeof worktrees} */
  let stacks;
  /** @type {typeof worktrees} */
  let servers;
  if (record) {
    stacks = (record.stacks ?? [])
      .filter((n) => known(n, "stack"))
      .map((n) => /** @type {any} */ (byName.get(n)));
    servers = (record.servers ?? [])
      .filter((n) => known(n, "server"))
      .map((n) => /** @type {any} */ (byName.get(n)));
  } else {
    stacks = recoveryOrder(worktrees.filter((w) => (w.class === "prd" || w.class === "active") && w.stack));
    servers = recoveryOrder(worktrees.filter((w) => w.class === "prd" && w.stack));
  }
  // A cut-off migrate reruns whether or not its stack is listed or up.
  const cutOff = recoveryOrder(worktrees.filter((w) => w.migrating && w.stack && !stacks.includes(w)));
  for (const w of [...stacks, ...cutOff]) {
    if (!w.stack) {
      warnings.push(`the down record lists stack ${w.name}, which has no stack now: skipped`);
      continue;
    }
    if (w.migrating)
      add({
        step: "stack up",
        target: w.name,
        why: `a migrate was cut off (started ${w.migrating}): rerun it`,
      });
    else if (!(dockerUp && stackIsUp(w)))
      add({
        step: "stack up",
        target: w.name,
        why: record ? `the down record had ${w.stack} up` : `${w.class}: ${w.stack} is down`,
      });
  }
  for (const w of servers) {
    if (!w.webPort) {
      warnings.push(`${w.name} has no dev server port: no server to start`);
      continue;
    }
    if (w.serverRunning) continue;
    add({
      step: "serve",
      target: w.name,
      why: record ? `the down record had :${w.webPort} running` : `prd: nothing listens on :${w.webPort}`,
    });
  }
  const dispatcherUp = facts.dispatcher?.running === true;
  const lockGone = stale.some((l) => l.kind === "dispatch");
  const intent = facts.dispatchIntent ?? null;
  if (!dispatcherUp && (record?.dispatcher === true || lockGone || intent)) {
    const why =
      record?.dispatcher === true
        ? "the down record had the dispatcher running"
        : lockGone
          ? `the dispatcher's lock is stale (pid ${facts.dispatcher?.pid ?? "?"} is gone): it was running`
          : `an earlier recover kept its intent to reopen it${intent?.at ? ` (${intent.at})` : ""}`;
    if (!intent) add({ step: "keep-dispatch-intent", why: `before any lock is cleared: ${why}` });
    add({ step: "dispatch", why });
  }
  if (dispatcherUp && intent)
    add({ step: "drop-dispatch-intent", why: "the dispatcher runs: the kept intent is done with" });
  const landings = (facts.landings ?? []).filter((l) => l.branch);
  for (const l of landings)
    add({
      step: "resume-landing",
      target: l.branch,
      why: `its landing was cut off at the ${l.step ?? "unknown"} step${l.at ? ` (${l.at})` : ""}: ${toolCmd.prd} land --resume ${l.branch}, first`,
    });
  const managed = new Set(facts.managed ?? []);
  for (const w of worktrees.filter((w) => w.class === "merged"))
    add({
      step: "offer-gc",
      target: w.name,
      why: w.dirty ? `${w.why}; commit or discard its changes first` : w.why,
      ...(w.dirty ? { dirty: true } : {}),
    });
  for (const w of recoveryOrder(worktrees.filter((w) => w.class === "prd" || w.class === "plan")))
    add({
      step: "open-session",
      target: w.name,
      why: `session ${sessionName(w)}: tell it to carry on, or reopen it when none is live`,
      session: sessionName(w),
      ...(managed.has(sessionName(w)) ? { managed: true } : {}),
    });
  if (record)
    add({ step: "delete-down-record", target: facts.downRecordPath, why: "used once, then deleted" });

  const rank = (/** @type {Action} */ a) => STEPS.indexOf(a.step);
  actions.sort((a, b) => rank(a) - rank(b)); // stable: keeps the order within a step

  return {
    worktrees: worktrees.map((w) => ({
      name: w.name,
      class: w.class,
      why: w.why,
      branch: w.branch,
      dirty: !!w.dirty,
      stack: w.stack ?? null,
      containersUp: w.containersUp ?? 0,
      webPort: w.webPort ?? null,
      serverRunning: !!w.serverRunning,
      migrating: w.migrating ?? null,
    })),
    locks: { stale, live, takenOver },
    docker: { running: dockerUp },
    testDb: { running: dockerUp && !!facts.testDb?.running },
    downRecord: record,
    dispatcher: {
      running: dispatcherUp,
      pid: dispatcherUp ? (facts.dispatcher?.pid ?? null) : null,
      reopen: actions.some((a) => a.step === "dispatch"),
      intent,
    },
    recover: {
      running: facts.recover?.running === true,
      pid: facts.recover?.running ? (facts.recover.pid ?? null) : null,
    },
    disk,
    landings: landings.map((l) => ({
      branch: l.branch,
      path: l.path ?? null,
      step: l.step ?? null,
      at: l.at ?? null,
    })),
    warnings,
    actions,
  };
}

/** One action as a line: "stack up t-2". @param {Action} a */
export const actionLine = (a) => (a.target ? `${a.step} ${a.target}` : a.step);

/**
 * The inventory as text for `recover --dry-run`.
 * @param {ReturnType<typeof inventory>} inv
 */
export function formatInventory(inv) {
  const out = [];
  const rows = inv.worktrees.map((w) => [
    w.name,
    w.class,
    w.branch || "(detached)",
    w.dirty ? "dirty" : "clean",
    w.stack ? `${w.stack} (${w.containersUp} up)` : "none",
    w.webPort ? `:${w.webPort} ${w.serverRunning ? "running" : "stopped"}` : "-",
    w.why,
  ]);
  const head = ["NAME", "CLASS", "BRANCH", "STATE", "STACK", "SERVER", "WHY"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (/** @type {string[]} */ r) =>
    r
      .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i])))
      .join("  ")
      .trimEnd();
  out.push(line(head));
  if (rows.length) for (const r of rows) out.push(line(r));
  else out.push("(no worktrees)");

  out.push("");
  out.push(`Docker: ${inv.docker.running ? "running" : "not running"}`);
  out.push(`shared test Postgres: ${inv.testDb.running ? "running" : "not running"}`);
  out.push(
    `disk: ${inv.disk.freeGb == null ? "unknown" : `${inv.disk.freeGb} GB free`} (line: ${inv.disk.minGb} GB)${inv.disk.low ? " · LOW" : ""}`,
  );
  out.push(`down record: ${inv.downRecord ? `from ${inv.downRecord.at ?? "an unknown time"}` : "none"}`);
  out.push(
    `dispatcher: ${inv.dispatcher.running ? `running (pid ${inv.dispatcher.pid})` : inv.dispatcher.reopen ? "not running (recover reopens it)" : "not running"}${inv.dispatcher.intent ? " · intent kept" : ""}`,
  );
  out.push(`recover: ${inv.recover?.running ? `running (pid ${inv.recover.pid})` : "not running"}`);

  const lockLine = (/** @type {LockFacts} */ l) =>
    `  ${l.kind.padEnd(7)} ${l.path}${l.holder ? ` (${l.holder})` : ""}${l.why ? `: ${l.why}` : ""}`;
  if (inv.locks.stale.length) out.push("", "stale locks (cleared):", ...inv.locks.stale.map(lockLine));
  if (inv.locks.live.length) out.push("", "live locks (left alone):", ...inv.locks.live.map(lockLine));
  if (inv.landings.length)
    out.push(
      "",
      `cut-off landings (${toolCmd.prd} land --resume <branch>, first):`,
      ...inv.landings.map(
        (l) => `  ${l.branch}: at ${l.step ?? "an unknown step"}${l.path ? ` (${l.path})` : ""}`,
      ),
    );
  if (inv.warnings.length) out.push("", "warnings:", ...inv.warnings.map((w) => `  ${w}`));

  out.push("", "actions:");
  if (inv.actions.length)
    inv.actions.forEach((a, i) => out.push(`  ${String(i + 1).padStart(2)}. ${actionLine(a)}: ${a.why}`));
  else out.push("  (none)");
  return out.join("\n");
}
