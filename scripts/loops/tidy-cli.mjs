#!/usr/bin/env node
// pnpm prd tidy [--yes] [--json]: collects the facts tidy.mjs sorts, prints the
// safe and ask lists, and with --yes removes the safe ones and files the ask
// list as one report in the asks queue.
//
//   --json   the lists as JSON ({ safe, ask, kept }); nothing changes
//   --facts  the raw facts as JSON
//   --yes    remove the safe ones (rm.sh, the testDb hook's drop-db, git fetch
//            --prune, the stackLeftovers hook's remove, deleting tickets, logs and ended records,
//            pnpm backlog archive for finished items; a dead lease only through
//            lease.sh's takeover, which keeps one retaken since), then
//            file the ask list with `pnpm prd ask --report` (none when it's empty)
//
// Reading runs git, the hooks' read-only forms (stackEngine status, stackReady,
// testDb facts and orphans, stackLeftovers), `lsof` (processes' working
// directories and listening ports), `ps` and the backlog's
// `list --json` and `prd list --json`; it writes nothing. The main checkout is
// the repo this file is in. Env: TRUNK (dev), CARETOOK_SESSIONS_DIR,
// CARETOOK_ASKS_DIR, CARETOOK_LEASE_ROOT.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describeRun, isTopicRun, outstandingRuns } from "../ci/outstanding.mjs";
import { collectFacts, parentOf } from "./inventory-facts.mjs";
import { isLive, processOf, readRecords } from "./sessions.mjs";
import { formatTidy, reportText, tidy } from "./tidy.mjs";
import { factList, runHook } from "./hooks.mjs";
import { branchKinds } from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const run = (/** @type {string} */ cmd, /** @type {string[]} */ args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
};
const git = (/** @type {string} */ cwd, /** @type {string[]} */ args) =>
  run("git", ["--no-optional-locks", "-C", cwd, ...args]);
const lines = (/** @type {string} */ s) => s.split("\n").filter(Boolean);
const ageSecs = (/** @type {string} */ p, /** @type {number} */ now) => {
  try {
    return Math.max(0, Math.round((now - statSync(p).mtimeMs) / 1000));
  } catch {
    return null;
  }
};

/**
 * The working directory of every process, by pid, from `lsof -d cwd -Fn`'s
 * result R (spawnSync's), or null when the inspection failed: lsof missing or
 * killed, an exit other than 0 or 1, or exit 1 with nothing printed but an
 * error. A null means "unknown", never "nothing running".
 */
export function processCwds(
  /** @type {{ error?: Error, status: number | null, stdout?: string, stderr?: string }} */ r,
) {
  const stdout = (r.stdout ?? "").trim();
  // lsof exits 1 both when some processes can't be read (what it printed still
  // counts) and when it finds nothing (none, if it said nothing else).
  if (
    r.error ||
    (r.status !== 0 && r.status !== 1) ||
    (r.status === 1 && !stdout && `${r.stderr ?? ""}`.trim())
  )
    return null;
  /** @type {{ pid: number, cwd: string }[]} */
  const out = [];
  let pid = 0;
  for (const l of lines(stdout)) {
    if (l.startsWith("p")) pid = Number(l.slice(1));
    else if (l.startsWith("n") && pid && pid !== process.pid) out.push({ pid, cwd: l.slice(1) });
  }
  return out;
}

/** Why a worktree counts as busy when processCwds' result R is null. */
export const unknownProcesses = (
  /** @type {{ error?: Error, status: number | null, signal?: string | null, stderr?: string }} */ r,
) =>
  `its processes are unknown (${
    r.error
      ? `lsof couldn't run: ${r.error.message}`
      : r.status === null
        ? `lsof was killed (${r.signal ?? "signal"})`
        : `lsof failed, exit ${r.status}${`${r.stderr ?? ""}`.trim() ? `: ${`${r.stderr}`.trim().split("\n")[0]}` : ""}`
  })`;

/**
 * The ci/ refs on origin, each with its age and whether a run is going. Age is
 * since its newest run, else its commit if we have it, else unknown (never
 * removed). An unreachable GitHub lists nothing.
 */
export function collectCiRefs(
  /** @type {string} */ main,
  /** @type {number} */ now,
  gh = (/** @type {string[]} */ args) => run("gh", args, { cwd: main, timeout: 15_000 }),
) {
  const listed = run("git", ["-C", main, "ls-remote", "origin", "refs/heads/ci/*"], { timeout: 15_000 });
  if (!listed.ok) return [];
  return lines(listed.out).flatMap((l) => {
    const [sha, full = ""] = l.split(/\s+/);
    const ref = full.replace(/^refs\/heads\//, "");
    const r = gh(["run", "list", "--branch", ref, "--limit", "5", "--json", "status,createdAt"]);
    if (!r.ok) return [];
    /** @type {{ status: string, createdAt: string }[]} */ let runs;
    try {
      runs = JSON.parse(r.out || "[]");
    } catch {
      return [];
    }
    const newest = Math.max(0, ...runs.map((x) => Date.parse(x.createdAt) || 0));
    const committed = Number(git(main, ["log", "-1", "--format=%ct", sha]).out) * 1000;
    const since = newest || committed;
    return [
      {
        ref,
        sha,
        ageSecs: since ? Math.max(0, Math.round((now - since) / 1000)) : null,
        running: runs.some((x) => x.status !== "completed"),
      },
    ];
  });
}

/**
 * The quarantine entries on dev whose item is finished or archived. Anything
 * unreadable lists nothing, so tidy never removes an entry on a guess.
 */
export function collectQuarantineDone(/** @type {string} */ main) {
  const text = git(main, ["show", "HEAD:scripts/ci/quarantine.txt"]);
  const listed = run(process.execPath, [join(HERE, "../backlog/backlog.mjs"), "list", "--all", "--json"], {
    cwd: main,
    timeout: 15_000,
  });
  if (!text.ok || !listed.ok) return [];
  try {
    // `list --all` includes archived items, each with its worked-out status.
    const finished = new Set(
      JSON.parse(listed.out)
        .filter((/** @type {{ status: string }} */ i) =>
          ["landed", "staging", "live", "dropped"].includes(i.status),
        )
        .map((/** @type {{ id: string }} */ i) => i.id),
    );
    return lines(text.out)
      .filter((line) => !line.startsWith("#"))
      .map((line) => {
        const [file = "", name = "", item = ""] = line.split("\t");
        return { file, name, item };
      })
      .filter((entry) => finished.has(entry.item));
  } catch {
    return [];
  }
}

/** The facts tidy() sorts, for the main checkout MAIN. */
export function collectTidyFacts({
  main = "",
  env = process.env,
  now = Date.now(),
  lsof = spawnSync("lsof", ["-nP", "-d", "cwd", "-Fn"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
  }),
  outstanding = () =>
    outstandingRuns({
      git: (args) => git(main, args),
      gh: (args) => run("gh", args, { cwd: main, timeout: 15_000 }),
    }),
} = {}) {
  const trunk = env.TRUNK || "dev";
  const loops = join(main, ".loops");
  const base = collectFacts({ main, env, now });

  // Tips that landed: a merged (non-first) parent of a merge commit on dev.
  const landedTips = new Set(
    lines(git(main, ["log", "--merges", "--format=%P", "-n", "5000", trunk]).out).flatMap((l) =>
      l.split(" ").slice(1),
    ),
  );
  const tipOf = (/** @type {string} */ ref) => git(main, ["rev-parse", "--verify", "--quiet", ref]).out;
  const inTrunk = (/** @type {string} */ ref) => git(main, ["merge-base", "--is-ancestor", ref, trunk]).ok;

  // An inspection that failed keeps every worktree as busy: unknown, not idle.
  const cwds = processCwds(lsof);
  const unknown = cwds ? undefined : unknownProcesses(lsof);
  const leases = (base.locks ?? []).filter((l) => l.kind === "lease" && l.alive);
  const worktrees = base.worktrees.map((w) => {
    const dir = join(loops, w.name);
    const t = w.branch ? tipOf(w.branch) : "";
    const proc = cwds?.find((c) => c.cwd === dir || c.cwd.startsWith(`${dir}/`));
    const lease = leases.find((l) => l.holder === w.name || l.holder?.startsWith(`${w.name}: `));
    const busy = unknown
      ? unknown
      : proc
        ? `a process is working in it (pid ${proc.pid})`
        : w.serverRunning
          ? "its dev server is running"
          : lease
            ? `it holds a lease (${lease.path})`
            : undefined;
    return {
      name: w.name,
      branch: w.branch,
      merged: !!w.merged,
      landed: !!t && landedTips.has(t),
      level: !!t && inTrunk(t),
      dirty: !!w.dirty,
      ...(busy ? { busy } : {}),
      stack: w.stack,
    };
  });
  const byName = new Map(worktrees.map((w) => [w.name, w]));

  // A merged slice stays until its wave lands and no run of its topic is out.
  const merged = worktrees.filter((w) => w.merged && branchKinds().sliceOf(w.branch));
  const runs = merged.length ? outstanding() : [];
  for (const w of merged) {
    const topic = branchKinds().sliceOf(w.branch)?.topic ?? "";
    const out = runs?.filter((r) => isTopicRun(r.name, topic)) ?? [];
    const held =
      runs === null
        ? "GitHub can't be read, so its wave's run is unknown"
        : out.length
          ? `its topic's run has no verdict: ${out.map(describeRun).join(", ")}`
          : w.level
            ? undefined
            : "its wave hasn't landed";
    if (held) Object.assign(w, { held });
  }

  const sessionsDir = env.CARETOOK_SESSIONS_DIR || join(loops, ".sessions");
  const sessions = readRecords(sessionsDir).map(({ name, record }) => {
    const m = /^(prd|plan|hotfix)-(.+)$/.exec(name);
    const worktree = m ? (m[1] === "prd" ? m[2] : `${m[1]}-${m[2]}`) : null;
    const w = worktree ? byName.get(worktree) : undefined;
    return {
      name,
      live: isLive(record, processOf(record.pid ?? 0, now), now),
      rotating: !!record.rotating,
      worktree,
      worktreeless: record.kind === "backlog" || record.kind === "recovery",
      worktreeExists: worktree ? existsSync(join(loops, worktree)) : undefined,
      ...(w ? { branch: w.branch, landed: w.landed } : {}),
      path: join(sessionsDir, `${name}.json`),
    };
  });

  const listedWorktrees = git(main, ["worktree", "list", "--porcelain"]);
  const checkedOut = new Set(
    lines(listedWorktrees.out)
      .filter((l) => l.startsWith("branch refs/heads/"))
      .map((l) => l.slice("branch refs/heads/".length)),
  );
  // Unreadable is null, never "no PRD is running": their finished items stay.
  const prdWorktrees = listedWorktrees.ok
    ? [...checkedOut].flatMap((b) => branchKinds().nameOf(b, "prd") ?? [])
    : null;
  const branches = lines(git(main, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).out).map(
    (name) => {
      let parent = parentOf(name, trunk);
      if (!tipOf(parent)) parent = trunk;
      return {
        name,
        worktree: checkedOut.has(name),
        parent,
        merged: git(main, ["merge-base", "--is-ancestor", name, parent]).ok,
      };
    },
  );

  const remotes = lines(git(main, ["remote"]).out);
  const staleRemotes = remotes.includes("origin")
    ? lines(git(main, ["remote", "prune", "--dry-run", "origin"]).out)
        .map((l) => /\[would prune\]\s+(\S+)/.exec(l)?.[1])
        .filter((r) => !!r)
    : [];

  const ciRefs = remotes.includes("origin") ? collectCiRefs(main, now) : [];

  const locks = (base.locks ?? [])
    .filter((l) => ["slot", "lease"].includes(l.kind))
    .map((l) => ({
      kind: l.kind,
      path: l.path,
      alive: l.alive,
      holder: l.holder,
      pid: l.pid ?? null,
      ageSecs: ageSecs(l.path, now),
    }));

  // The hooks decide what's left over: test databases no worktree owns (by name
  // alone, B-440), and the stack's data no worktree's stack uses.
  const names = worktrees.map((w) => w.name);
  const testDbOrphans = factList("orphan", runHook("testDb", ["orphans", ...names], { env }).out);
  // Only when every stack is known: a failed stackReady could drop a stack in
  // use from the projects, and a failed listing may be partial.
  const projects = worktrees.flatMap((w) => (w.stack ? [w.stack] : []));
  const unknownStacks = base.worktrees.filter((w) => w.stackFailed).map((w) => w.name);
  const left = unknownStacks.length ? null : runHook("stackLeftovers", projects, { env });
  const volumesSkipped = unknownStacks.length
    ? `the stackReady hook failed for ${unknownStacks.join(", ")}, so which stacks are in use is unknown`
    : left && !left.ok && left.status !== 127
      ? `the stackLeftovers hook failed${left.err ? ` (${left.err.split("\n")[0]})` : ""}`
      : undefined;
  const volumes = (left?.ok ? factList("volume", left.out) : []).map((l) => {
    const [name, , ...why] = l.split(" ");
    return { name, why: why.join(" ") };
  });

  const hangs = join(loops, ".browser-hangs");
  const hangLogs = existsSync(hangs)
    ? readdirSync(hangs)
        .filter((f) => f.endsWith(".log"))
        .map((f) => ({ path: join(hangs, f), ageSecs: ageSecs(join(hangs, f), now) ?? 0 }))
    : [];

  const backlog = join(HERE, "../backlog/backlog.mjs");
  const json = (/** @type {string[]} */ args) => {
    if (!existsSync(backlog)) return null;
    const r = run(process.execPath, [backlog, ...args], { cwd: main, env });
    try {
      return r.ok ? JSON.parse(r.out) : null;
    } catch {
      return null;
    }
  };

  const allItems = json(["list", "--all", "--json"]);

  return {
    worktrees,
    sessions,
    branches,
    staleRemotes,
    ciRefs,
    quarantineDone: collectQuarantineDone(main),
    locks,
    testDbOrphans,
    volumes,
    ...(volumesSkipped ? { volumesSkipped } : {}),
    hangLogs,
    // --all: a plain list leaves out live and dropped items, which are what gets archived.
    items: allItems && allItems.filter((/** @type {{ archived?: boolean }} */ i) => !i.archived),
    prdWorktrees,
    registry: json(["prd", "list", "--json"]),
  };
}

/**
 * Removes the machine-wide lease at PATH (<root>/<kind>/<N>) only through
 * lease.sh's takeover (lease_take_over): under the kind's `.takeover` mutex and
 * after a fresh liveness check, so a lease taken again since tidy's snapshot
 * stays. "removed" when it's gone, "kept" when it's still there (its holder is
 * running, or another taker holds the mutex), "failed" when lease.sh failed.
 */
export function removeLease(/** @type {string} */ path, { env = process.env } = {}) {
  const n = basename(path);
  const kindDir = dirname(path);
  const kind = basename(kindDir);
  if (!/^\d+$/.test(n) || !/^[a-z][a-z0-9-]*$/.test(kind)) {
    console.error(`tidy: ${path} isn't a lease (<root>/<kind>/<N>)`);
    return "failed";
  }
  /** @type {NodeJS.ProcessEnv} */
  const leaseEnv = { ...env, CARETOOK_LEASE_ROOT: dirname(kindDir) };
  delete leaseEnv.CARETOOK_BROWSER_LEASES; // lease_dir would read the browser kind there instead
  const r = spawnSync(
    "bash",
    ["-c", 'source "$1" && lease_take_over "$2" "$3"', "tidy", join(HERE, "lease.sh"), kind, n],
    { env: leaseEnv, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
  );
  if (r.status !== 0) {
    console.error(`tidy: lease.sh's takeover of ${path} failed${r.stderr ? `:\n${r.stderr.trim()}` : ""}`);
    return "failed";
  }
  return existsSync(path) ? "kept" : "removed";
}

/** Removes the safe findings; returns how many failed. */
function act(/** @type {ReturnType<typeof tidy>["safe"]} */ safe, /** @type {string} */ main) {
  let failed = 0;
  let pruned = false;
  let unquarantined = false;
  const step = (/** @type {string} */ label, /** @type {() => boolean} */ fn, done = "removed") => {
    let ok = false;
    try {
      ok = fn();
    } catch (e) {
      console.error(String(e));
    }
    if (ok) console.log(`${done} ${label}`);
    else {
      console.error(`couldn't remove ${label} (see above)`);
      failed++;
    }
  };
  const sh = (/** @type {string[]} */ args) =>
    spawnSync(args[0], args.slice(1), { cwd: main, stdio: ["ignore", "inherit", "inherit"] }).status === 0;
  const hook = (/** @type {string} */ name, /** @type {string[]} */ args) => {
    const r = runHook(name, args);
    if (r.out) console.log(r.out);
    if (r.err) console.error(r.err);
    return r.ok;
  };
  for (const f of safe) {
    const label = `${f.kind} ${f.target}`;
    switch (f.kind) {
      case "worktree":
        step(label, () => sh(["bash", join(HERE, "rm.sh"), f.target]));
        break;
      case "test-db":
        step(label, () => hook("testDb", ["drop-db", f.target]));
        break;
      case "remote":
        if (!pruned) {
          pruned = true;
          step("stale remote-tracking refs (git fetch --prune)", () =>
            sh(["git", "-C", main, "fetch", "--prune", "--quiet", "origin"]),
          );
        }
        break;
      case "ci-ref":
        // Only while it's still at the commit we saw: a newer request's push stays.
        step(label, () =>
          sh([
            "git",
            "-C",
            main,
            "push",
            `--force-with-lease=refs/heads/${f.target}:${f.sha ?? ""}`,
            "origin",
            `:refs/heads/${f.target}`,
          ]),
        );
        break;
      case "quarantine":
        // One write removes every finished entry; the others are then already gone.
        if (!unquarantined) {
          unquarantined = true;
          step(
            "quarantine entries whose item is done",
            () =>
              spawnSync(process.execPath, [join(HERE, "../backlog/backlog.mjs"), "ci-file"], {
                cwd: main,
                input: '{"findings":[]}',
                stdio: ["pipe", "ignore", "inherit"],
              }).status === 0,
          );
        }
        break;
      case "archive":
        // One backlog commit, and only the ids sorted as safe.
        step(
          f.target,
          () =>
            // No ids would mean "everything finished", which isn't what was sorted.
            !!f.ids?.length &&
            spawnSync(process.execPath, [join(HERE, "../backlog/backlog.mjs"), "archive", ...f.ids], {
              cwd: main,
              stdio: ["ignore", "inherit", "inherit"],
            }).status === 0,
          "archived",
        );
        break;
      case "volume":
        step(label, () => hook("stackLeftovers", ["remove", "volume", f.target]));
        break;
      case "lease": {
        // Through lease.sh's takeover, never from the snapshot: a lease retaken
        // since it was read is live again and stays (B-442).
        const r = removeLease(f.target);
        if (r === "kept")
          console.log(`kept ${label}: its holder is running again, or another taker is taking it over`);
        else step(label, () => r === "removed");
        break;
      }
      case "record":
      case "hang-log":
      case "slot":
        step(label, () => {
          rmSync(f.path ?? f.target, { recursive: true, force: true });
          return true;
        });
        break;
      default:
        console.error(`tidy: no way to remove ${label}`);
        failed++;
    }
  }
  return failed;
}

function main() {
  const argv = process.argv.slice(2);
  let mode = "text";
  let yes = false;
  for (const a of argv) {
    if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--json") mode = "json";
    else if (a === "--facts") mode = "facts";
    else if (a === "-h" || a === "--help") {
      console.log("pnpm prd tidy [--yes] [--json]: list leftovers (safe, ask); --yes removes the safe ones");
      return;
    } else {
      console.error(`tidy: unknown argument ${a} (--yes, --json)`);
      process.exit(2);
    }
  }
  if (yes && mode !== "text") {
    console.error("tidy: --yes prints text; drop --json");
    process.exit(2);
  }
  const mainDir = execFileSync("git", ["-C", HERE, "worktree", "list", "--porcelain"], { encoding: "utf8" })
    .split("\n")[0]
    .replace(/^worktree /, "");
  const facts = collectTidyFacts({ main: mainDir });
  if (mode === "facts") return console.log(JSON.stringify(facts, null, 2));
  const lists = tidy(facts);
  if (mode === "json") return console.log(JSON.stringify(lists, null, 2));
  console.log(formatTidy(lists));
  if (!yes) {
    if (lists.safe.length) console.log("\nNothing changed. pnpm prd tidy --yes removes the safe ones.");
    return;
  }
  console.log("");
  const failed = act(lists.safe, mainDir);
  if (lists.ask.length) {
    const r = spawnSync(
      process.execPath,
      [
        join(HERE, "ask.mjs"),
        "ask",
        "--topic",
        "tidy",
        "--session",
        "tidy",
        "--report",
        reportText(lists.ask),
      ],
      {
        cwd: mainDir,
        stdio: ["ignore", "inherit", "inherit"],
        env: {
          ...process.env,
          CARETOOK_ASKS_DIR: process.env.CARETOOK_ASKS_DIR || join(mainDir, ".loops/.asks"),
        },
      },
    );
    if (r.status !== 0) {
      console.error("tidy: couldn't file the report (pnpm prd ask --report)");
      process.exit(1);
    }
  } else console.log("Nothing to ask about: no report filed.");
  if (failed) {
    console.error(`tidy: ${failed} not removed`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
