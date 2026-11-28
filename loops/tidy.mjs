// The cleanup sorter behind `tidy`: the one place that decides what a
// leftover is and whether it may go without asking. Pure: a facts object in
// (tidy-cli.mjs collects one), three lists out.
//
//   safe  removed by `tidy --yes`, each with how:
//         - a slice worktree merged into its prd/ branch, clean, with nothing
//           running in it (rm.sh);
//         - a plan/<topic> worktree landed in dev and level with it, clean, with
//           no live session and nothing running in it (rm.sh);
//         - lease and slot tickets whose holder is gone (older than a minute,
//           so one being taken isn't), removed;
//         - test databases no worktree owns (the testDb hook's orphans; its drop-db);
//         - stale remote-tracking refs (git fetch --prune);
//         - the stack's leftovers no worktree's stack uses (the stackLeftovers
//           hook's volume= lines; its `leftovers remove`);
//         - .loops/.browser-hangs logs older than a week;
//         - ended session records whose worktree is gone;
//         - ci/ refs on origin older than a day with no run going
//           (git push --delete, only while still at the same commit);
//         - quarantine entries whose backlog item is done;
//         - finished backlog items: dropped ones always, others once their
//           topic has no prd/ worktree (backlog archive <ids>).
//   ask   reported only (one `ask --report`):
//         - a live session whose worktree is gone or whose branch landed in dev
//           (it looks finished: ask it, then the user closes it);
//         - a local branch with no worktree: merged ones are named for
//           deletion, unmerged ones are never deleted;
//         - PRD registry rows that look done (not on hold, standing or running);
//         - a landed topic (landedTopics, or landedWithCode: code past its
//           landing) with a worktree or a row not done while no dispatcher
//           runs: `finish <topic>` is the fix; never a standing topic;
//         - a topic with more than one live claude across its worktrees (the
//           pids and where each works).
//   kept  a safe candidate held back, with why: a dirty worktree, one with
//         something running, a plan worktree with a live session, a ticket
//         just taken, finished items of a topic with a prd/ worktree.
//
// Never, whatever the facts: a dirty worktree, any build or Vite cache (unlike
// `reclaim --yes`), the main checkout, an unmerged branch, a session itself.

import { branchKinds, toolCmd } from "./config.mjs";

/** Tickets younger than this are left alone: their holder may still be writing its pid. */
export const TICKET_GRACE_SECS = 60;
/** Browser-hang logs older than this go. */
export const HANG_LOG_DAYS = 7;
/** A ci/ ref with no run going may go once it's this old. */
export const CI_REF_SECS = 86400;
/** Item statuses `backlog archive` moves out. */
export const ARCHIVABLE = ["landed", "staging", "live", "dropped"];
/** The long-lived branches tidy never lists: the trunk and the protected ones (dev, main, staging here). */
export const protectedBranches = () => branchKinds().kept;

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
 * @property {string[]} [testDbOrphans]   test databases no worktree owns (the testDb hook's orphans)
 * @property {{ name: string, why: string }[]} [volumes]   the stack's leftovers no worktree's stack uses (the stackLeftovers hook)
 * @property {string} [volumesSkipped]   why the leftovers weren't read (a stack hook failed)
 * @property {{ path: string, ageSecs: number }[]} [hangLogs]
 * @property {{ id: string, title?: string, status: string, prd?: string }[] | null} [items]   backlog items, archived ones left out
 * @property {string[] | null} [prdWorktrees]   topics with a prd/ worktree; null when unreadable (a topic's finished items stay)
 * @property {{ topic: string, flags: string[], state: string, waiting: number, notes?: string }[] | null} [registry]
 * @property {{ topic: string, code?: boolean, standing?: boolean, worktree?: string | null, rowDone?: boolean | null }[]} [landed]
 *   landed topics: in landedTopics, or landedWithCode (code: true); rowDone null when it has no row
 * @property {boolean} [dispatcherRunning]   the dispatcher's lock names a live pid
 * @property {{ topic: string, pid: number, worktree: string }[]} [claudes]   live claudes in a topic's worktrees
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
    else safe.push({ kind: "worktree", target: w.name, why: what, how: `${toolCmd.prd} rm ${w.name}` });
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
      how: `${toolCmd.backlog} ci-file`,
    });

  for (const l of facts.locks ?? []) {
    if (!["slot", "lease"].includes(l.kind) || l.alive) continue;
    const who = l.holder ? `${l.kind} ${l.holder}` : l.kind;
    const why = l.kind === "slot" ? "its worktree is gone" : `pid ${l.pid ?? "?"} is gone`;
    if ((l.ageSecs ?? 0) < TICKET_GRACE_SECS)
      kept.push({ kind: l.kind, target: l.path, why: `${who}: ${why}, but it was just taken` });
    else safe.push({ kind: l.kind, target: l.path, why: `${who}: ${why}`, how: "remove it" });
  }

  for (const db of facts.testDbOrphans ?? [])
    safe.push({ kind: "test-db", target: db, why: "no worktree owns it", how: `test-db drop-db ${db}` });

  for (const v of facts.volumes ?? [])
    safe.push({ kind: "volume", target: v.name, why: v.why, how: "stack leftovers remove volume" });
  if (facts.volumesSkipped)
    kept.push({
      kind: "volume",
      target: "the stack's leftovers",
      why: `not checked: ${facts.volumesSkipped}`,
    });

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
      how: `${toolCmd.backlog} archive`,
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
      why: `${saysDone ? "its notes say done" : "planned, with no waiting items"}, but it isn't flagged done (${toolCmd.backlog} prd set ${r.topic} flags=${[...r.flags, "done"].join(",")})`,
    });
  }

  if (!facts.dispatcherRunning)
    for (const l of facts.landed ?? []) {
      if (l.standing) continue;
      const left = [
        ...(l.worktree ? [`its worktree ${l.worktree}`] : []),
        ...(l.rowDone === false ? ["its row not done"] : []),
      ];
      if (!left.length) continue;
      ask.push({
        kind: "landed",
        target: l.topic,
        why: `landed${l.code ? ", with code past its landing," : ""} with ${left.join(" and ")}, and no dispatcher is running (${toolCmd.prd} finish ${l.topic})`,
      });
    }

  /** @type {Map<string, { pid: number, worktree: string }[]>} */ const byTopic = new Map();
  for (const c of facts.claudes ?? []) {
    const seen = byTopic.get(c.topic) ?? [];
    if (!seen.some((s) => s.pid === c.pid)) byTopic.set(c.topic, [...seen, c]);
  }
  for (const [topic, cs] of byTopic)
    if (cs.length > 1)
      ask.push({
        kind: "sessions",
        target: topic,
        why: `${cs.length} live claudes across its worktrees (${cs.map((c) => `pid ${c.pid} in ${c.worktree}`).join(", ")}): one is enough, end the others`,
      });

  return { safe, ask, kept };
}

/** The lists as text, for the terminal. */
export function formatTidy(/** @type {ReturnType<typeof tidy>} */ { safe, ask, kept }) {
  const row = (/** @type {Finding} */ f) => `  ${f.kind.padEnd(9)} ${f.target} (${f.why})`;
  const out = [];
  out.push(safe.length ? `Safe to remove (${toolCmd.prd} tidy --yes):` : "Safe to remove: nothing.");
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
    `${toolCmd.prd} tidy: ${ask.length} thing${ask.length === 1 ? "" : "s"} to decide (nothing here was removed):`,
    ...ask.map((f) => `- ${f.kind} ${f.target}: ${f.why}`),
  ].join("\n");
}
