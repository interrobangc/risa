// The cleanup sorter behind `pnpm prd tidy`: the one place that decides what a
// leftover is and whether it may go without asking. Pure: a facts object in
// (tidy-cli.mjs collects one), three lists out.
//
//   safe  removed by `pnpm prd tidy --yes`, each with how:
//         - a slice worktree merged into its prd/ branch, clean, with nothing
//           running in it (rm.sh);
//         - a plan/<topic> worktree landed in dev and level with it, clean, with
//           no live session and nothing running in it (rm.sh);
//         - lease and slot tickets whose holder is gone (older than a minute,
//           so one being taken isn't), removed;
//         - test databases no worktree owns (test-db.sh drop-db);
//         - stale remote-tracking refs (git fetch --prune);
//         - dangling Docker volumes of a caretook-loopN project no worktree
//           names (docker volume rm);
//         - .loops/.browser-hangs logs older than a week;
//         - ended session records whose worktree is gone;
//         - ci/ refs on origin older than a day with no run going
//           (git push --delete, only while still at the same commit);
//         - quarantine entries whose backlog item is done;
//         - finished backlog items: dropped ones always, others once their
//           topic has no prd/ worktree (pnpm backlog archive <ids>).
//   ask   reported only (one `pnpm prd ask --report`):
//         - a live session whose worktree is gone or whose branch landed in dev
//           (it looks finished: ask it, then the user closes it);
//         - a local branch with no worktree: merged ones are named for
//           deletion, unmerged ones are never deleted;
//         - PRD registry rows that look done (not on hold, standing or running).
//   kept  a safe candidate held back, with why: a dirty worktree, one with
//         something running, a plan worktree with a live session, a ticket
//         just taken, finished items of a topic with a prd/ worktree.
//
// Never, whatever the facts: a dirty worktree, any build or Vite cache (unlike
// `reclaim --yes`), the main checkout, an unmerged branch, a session itself.

import { createHash } from "node:crypto";
import { branchKinds } from "./config.mjs";

/** Tickets younger than this are left alone: their holder may still be writing its pid. */
export const TICKET_GRACE_SECS = 60;
/** Browser-hang logs older than this go. */
export const HANG_LOG_DAYS = 7;
/** A ci/ ref with no run going may go once it's this old. */
export const CI_REF_SECS = 86400;
/** Item statuses `pnpm backlog archive` moves out. */
export const ARCHIVABLE = ["landed", "staging", "live", "dropped"];
/** The long-lived branches tidy never lists: the trunk and the protected ones (dev, main, staging here). */
export const protectedBranches = () => branchKinds().kept;

/** stack-lib.sh's test_db_name: a worktree's own test database. */
export const testDbName = (/** @type {string} */ name) =>
  `caretook_test_${name.toLowerCase().replace(/[^a-z0-9]/g, "_")}`.slice(0, 63);

/** A worker copy's suffix (test-db.sh's worker_re; packages/data/src/db/testDatabase.ts). */
const WORKER_SUFFIX = /^_w([1-9]|1[0-6])$/;

/**
 * Test database DB's worker copies' name without the _w<n>:
 * caretook_tw_<stem cut to 38>_<md5 of DB cut to 8> (workerDatabaseName in
 * packages/data/src/db/testDatabase.ts; test-db.sh's worker_prefix).
 * @param {string} db
 */
export const testDbWorkerPrefix = (db) =>
  `caretook_tw_${db.replace(/^caretook_test_/, "").slice(0, 38)}_${createHash("md5").update(db).digest("hex").slice(0, 8)}`;

/**
 * The worktree that owns test database DB, or null: its own database, or one of
 * its integration workers' copies (caretook_tw_…_w<n>, which no worktree's own
 * database can be). Copies named the old way, <database cut to 59>_w<n>, still
 * count as their worktree's until it's gone, then as orphans; known names come
 * first, so a topic ending -w<n> owns its database instead of it reading as
 * another's old copy.
 * @param {string} db
 * @param {string[]} worktrees  the worktree names
 */
export function testDbOwner(db, worktrees) {
  for (const w of worktrees) if (testDbName(w) === db) return w;
  for (const w of worktrees) {
    const prefix = testDbWorkerPrefix(testDbName(w));
    if (db.startsWith(prefix) && WORKER_SUFFIX.test(db.slice(prefix.length))) return w;
  }
  for (const w of worktrees) {
    const base = testDbName(w).slice(0, 59);
    if (db.startsWith(base) && WORKER_SUFFIX.test(db.slice(base.length))) return w;
  }
  return null;
}

/**
 * @typedef {object} TidyWorktree
 * @property {string} name              its directory in .loops
 * @property {string} branch
 * @property {boolean} [merged]         a slice whose tip is merged into its prd/ branch
 * @property {boolean} [landed]         its tip is a merged parent of a merge commit in dev
 * @property {string} [held]             a merged slice its wave still needs, and why
 * @property {boolean} [level]          its tip is in dev (nothing dev lacks)
 * @property {boolean} [dirty]
 * @property {string} [busy]            what is running in it (a process, a server, a lease), if anything
 *
 * @typedef {object} TidySession
 * @property {string} name              prd-<topic>, plan-<topic>, hotfix-<name>, backlog, recover
 * @property {boolean} live
 * @property {boolean} [rotating]
 * @property {string|null} [worktree]   the worktree it belongs to, null when unknown
 * @property {boolean} [worktreeless]  a backlog or recovery session: it runs in the main checkout
 * @property {boolean} [worktreeExists]
 * @property {string} [branch]          its worktree's branch, when that exists
 * @property {boolean} [landed]         that branch's tip landed in dev
 * @property {string} [path]            its record file
 *
 * @typedef {object} TidyBranch
 * @property {string} name
 * @property {boolean} worktree         checked out in some worktree
 * @property {string} parent            the branch it merges into
 * @property {boolean} merged           merged into its parent
 *
 * @typedef {object} TidyLock
 * @property {"slot"|"lease"|string} kind
 * @property {string} path
 * @property {boolean} alive
 * @property {string} [holder]
 * @property {number|null} [pid]
 * @property {number|null} [ageSecs]
 *
 * @typedef {object} TidyFacts
 * @property {TidyWorktree[]} [worktrees]
 * @property {TidySession[]} [sessions]
 * @property {TidyBranch[]} [branches]
 * @property {string[]} [staleRemotes]   remote-tracking refs `git fetch --prune` would drop
 * @property {{ file: string, name: string, item: string }[]} [quarantineDone]   quarantine entries whose item is done
 * @property {{ ref: string, sha: string, ageSecs: number | null, running: boolean }[]} [ciRefs]   ci/ refs on origin; a null age is unknown
 * @property {TidyLock[]} [locks]
 * @property {{ db: string, worktree: string|null }[]} [testDbs]
 * @property {{ name: string, project: string }[]} [volumes]   dangling volumes
 * @property {string[]} [usedProjects]   Compose projects still in use
 * @property {{ path: string, ageSecs: number }[]} [hangLogs]
 * @property {{ id: string, title?: string, status: string, prd?: string }[] | null} [items]   backlog items, archived ones left out
 * @property {string[] | null} [prdWorktrees]   topics with a prd/ worktree; null when unreadable (a topic's finished items stay)
 * @property {{ topic: string, flags: string[], state: string, waiting: number, notes?: string }[] | null} [registry]
 *
 * @typedef {{ kind: string, target: string, why: string, how?: string, path?: string, sha?: string, ids?: string[] }} Finding
 */

/**
 * @param {TidyFacts} facts
 * @returns {{ safe: Finding[], ask: Finding[], kept: Finding[] }}
 */
export function tidy(facts) {
  /** @type {Finding[]} */ const safe = [];
  /** @type {Finding[]} */ const ask = [];
  /** @type {Finding[]} */ const kept = [];
  const sessions = facts.sessions ?? [];
  const liveSession = new Map(sessions.filter((s) => s.live || s.rotating).map((s) => [s.worktree, s]));

  for (const w of facts.worktrees ?? []) {
    const slice = branchKinds().sliceOf(w.branch) && w.merged;
    const plan = branchKinds().is(w.branch, "plan") && w.landed && w.level;
    if (!slice && !plan) continue;
    const what = slice
      ? `${w.branch} is merged into ${branchKinds().parentOf(w.branch)}`
      : `${w.branch} landed in dev and is level with it`;
    const s = liveSession.get(w.name);
    if (w.dirty)
      kept.push({ kind: "worktree", target: w.name, why: `${what}, but it has uncommitted changes` });
    else if (w.busy) kept.push({ kind: "worktree", target: w.name, why: `${what}, but ${w.busy}` });
    else if (slice && w.held) kept.push({ kind: "worktree", target: w.name, why: `${what}, but ${w.held}` });
    else if (plan && s)
      kept.push({ kind: "worktree", target: w.name, why: `${what}, but its session ${s.name} is live` });
    else safe.push({ kind: "worktree", target: w.name, why: what, how: `pnpm prd rm ${w.name}` });
  }

  for (const s of sessions) {
    const gone = s.worktree != null && s.worktreeExists === false;
    if (s.live) {
      if (gone)
        ask.push({
          kind: "session",
          target: s.name,
          why: `live, but its worktree ${s.worktree} is gone: looks finished (ask it, then close it)`,
        });
      else if (s.landed)
        ask.push({
          kind: "session",
          target: s.name,
          why: `live, but its branch ${s.branch} is in dev: looks finished (ask it, then close it)`,
        });
    } else if (gone && !s.rotating)
      safe.push({
        kind: "record",
        target: s.name,
        why: `ended, and its worktree ${s.worktree} is gone`,
        how: "delete the record",
        ...(s.path ? { path: s.path } : {}),
      });
    else if (s.worktreeless && !s.rotating)
      safe.push({
        kind: "record",
        target: s.name,
        why: "ended, and it has no worktree",
        how: "delete the record",
        ...(s.path ? { path: s.path } : {}),
      });
  }

  for (const b of facts.branches ?? []) {
    if (b.worktree || protectedBranches().includes(b.name)) continue;
    ask.push(
      b.merged
        ? {
            kind: "branch",
            target: b.name,
            why: `no worktree, merged into ${b.parent}: can be deleted (git branch -d ${b.name})`,
          }
        : {
            kind: "branch",
            target: b.name,
            why: `no worktree, not merged into ${b.parent}: kept, never deleted`,
          },
    );
  }

  for (const r of facts.staleRemotes ?? [])
    safe.push({ kind: "remote", target: r, why: "gone from the remote", how: "git fetch --prune" });

  for (const c of facts.ciRefs ?? []) {
    if (c.running || c.ageSecs === null || c.ageSecs <= CI_REF_SECS) continue;
    safe.push({
      kind: "ci-ref",
      target: c.ref,
      why: `${Math.floor(c.ageSecs / 3600)} hours old, no run going`,
      how: "git push --delete",
      sha: c.sha,
    });
  }

  for (const q of facts.quarantineDone ?? [])
    safe.push({
      kind: "quarantine",
      target: `${q.file}: ${q.name}`,
      why: `its item ${q.item} is done`,
      how: "pnpm backlog ci-file",
    });

  for (const l of facts.locks ?? []) {
    if (!["slot", "lease"].includes(l.kind) || l.alive) continue;
    const who = l.holder ? `${l.kind} ${l.holder}` : l.kind;
    const why = l.kind === "slot" ? "its worktree is gone" : `pid ${l.pid ?? "?"} is gone`;
    if ((l.ageSecs ?? 0) < TICKET_GRACE_SECS)
      kept.push({ kind: l.kind, target: l.path, why: `${who}: ${why}, but it was just taken` });
    else safe.push({ kind: l.kind, target: l.path, why: `${who}: ${why}`, how: "remove it" });
  }

  for (const d of facts.testDbs ?? [])
    if (!d.worktree)
      safe.push({
        kind: "test-db",
        target: d.db,
        why: "no worktree owns it",
        how: `test-db drop-db ${d.db}`,
      });

  const used = new Set(facts.usedProjects ?? []);
  for (const v of facts.volumes ?? []) {
    if (!/^caretook-loop\d+(-test)?$/.test(v.project) || used.has(v.project)) continue;
    safe.push({
      kind: "volume",
      target: v.name,
      why: `dangling; no worktree uses ${v.project}`,
      how: "docker volume rm",
    });
  }

  for (const h of facts.hangLogs ?? [])
    if (h.ageSecs > HANG_LOG_DAYS * 86400)
      safe.push({
        kind: "hang-log",
        target: h.path,
        why: `${Math.floor(h.ageSecs / 86400)} days old`,
        how: "delete it",
      });

  const countOf = (/** @type {string[]} */ ids) => `${ids.length} item${ids.length === 1 ? "" : "s"}`;
  const someOf = (/** @type {string[]} */ ids) =>
    `${ids.slice(0, 5).join(", ")}${ids.length > 5 ? ", …" : ""}`;
  const running = facts.prdWorktrees === null ? null : new Set(facts.prdWorktrees ?? []);
  /** @type {string[]} */ const archive = [];
  /** @type {Map<string, string[]>} */ const held = new Map();
  for (const i of facts.items ?? []) {
    if (!ARCHIVABLE.includes(i.status)) continue;
    const topic = i.prd ?? "";
    if (i.status !== "dropped" && topic && (running === null || running.has(topic)))
      held.set(topic, [...(held.get(topic) ?? []), i.id]);
    else archive.push(i.id);
  }
  if (archive.length)
    safe.push({
      kind: "archive",
      target: countOf(archive),
      why: `finished, still in the backlog (${someOf(archive)})`,
      how: "pnpm backlog archive",
      ids: archive,
    });
  for (const [topic, ids] of held)
    kept.push({
      kind: "archive",
      target: `${topic}: ${countOf(ids)}`,
      why:
        running === null
          ? `finished, but the worktrees can't be read (${someOf(ids)})`
          : `finished, but ${branchKinds().branch("prd", topic)} still has a worktree (${someOf(ids)})`,
    });

  for (const r of facts.registry ?? []) {
    // done is done; standing never finishes; hold waits on the user; running has a worktree.
    if (["done", "standing", "hold"].some((f) => r.flags.includes(f)) || r.state === "running") continue;
    const saysDone = /\*\*done\b/i.test(r.notes ?? "");
    const allIn = r.state === "planned" && r.waiting === 0;
    if (!saysDone && !allIn) continue;
    ask.push({
      kind: "registry",
      target: r.topic,
      why: `${saysDone ? "its notes say done" : "planned, with no waiting items"}, but it isn't flagged done (pnpm backlog prd set ${r.topic} flags=${[...r.flags, "done"].join(",")})`,
    });
  }

  return { safe, ask, kept };
}

/** The lists as text, for the terminal. */
export function formatTidy(/** @type {ReturnType<typeof tidy>} */ { safe, ask, kept }) {
  const row = (/** @type {Finding} */ f) => `  ${f.kind.padEnd(9)} ${f.target} (${f.why})`;
  const out = [];
  out.push(safe.length ? "Safe to remove (pnpm prd tidy --yes):" : "Safe to remove: nothing.");
  out.push(...safe.map(row));
  out.push("");
  out.push(ask.length ? "To ask about (reported, never removed by tidy):" : "To ask about: nothing.");
  out.push(...ask.map(row));
  if (kept.length) out.push("", "Kept:", ...kept.map(row));
  return out.join("\n");
}

/** The ask list as one report's text. */
export function reportText(/** @type {Finding[]} */ ask) {
  return [
    `pnpm prd tidy: ${ask.length} thing${ask.length === 1 ? "" : "s"} to decide (nothing here was removed):`,
    ...ask.map((f) => `- ${f.kind} ${f.target}: ${f.why}`),
  ].join("\n");
}
