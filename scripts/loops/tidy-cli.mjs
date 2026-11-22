#!/usr/bin/env node
// pnpm prd tidy [--yes] [--json]: collects the facts tidy.mjs sorts, prints the
// safe and ask lists, and with --yes removes the safe ones and files the ask
// list as one report in the asks queue.
//
//   --json   the lists as JSON ({ safe, ask, kept }); nothing changes
//   --facts  the raw facts as JSON
//   --yes    remove the safe ones (rm.sh, test-db.sh drop-db, git fetch --prune,
//            docker volume rm, deleting tickets, logs and ended records), then
//            file the ask list with `pnpm prd ask --report` (none when it's empty)
//
// Reading runs git, `docker info|volume ls`, `lsof` (processes' working
// directories and listening ports), `ps`, `test-db.sh list` and the backlog's
// `list --json` and `prd list --json`; it writes nothing. The main checkout is
// the repo this file is in. Env: TRUNK (dev), CARETOOK_SESSIONS_DIR,
// CARETOOK_ASKS_DIR, CARETOOK_LEASE_ROOT.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectFacts, parentOf } from "./inventory-facts.mjs";
import { isLive, processOf, readRecords } from "./sessions.mjs";
import { formatTidy, reportText, tidy } from "./tidy.mjs";

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

/** stack-lib.sh's test_db_name. */
export const testDbName = (/** @type {string} */ name) =>
  `caretook_test_${name.toLowerCase().replace(/[^a-z0-9]/g, "_")}`.slice(0, 63);

/** The working directory of every process, by pid (lsof -d cwd). */
function processCwds() {
  /** @type {{ pid: number, cwd: string }[]} */
  const out = [];
  let pid = 0;
  // lsof exits 1 when some processes can't be read; what it printed still counts.
  for (const l of lines(run("lsof", ["-nP", "-d", "cwd", "-Fn"]).out || "")) {
    if (l.startsWith("p")) pid = Number(l.slice(1));
    else if (l.startsWith("n") && pid && pid !== process.pid) out.push({ pid, cwd: l.slice(1) });
  }
  return out;
}

/** The facts tidy() sorts, for the main checkout MAIN. */
export function collectTidyFacts({ main = "", env = process.env, now = Date.now() } = {}) {
  const trunk = env.TRUNK || "dev";
  const loops = join(main, ".loops");
  const base = collectFacts({ main, env, now });
  const dockerUp = !!base.docker?.running;

  // Tips that landed: a merged (non-first) parent of a merge commit on dev.
  const landedTips = new Set(
    lines(git(main, ["log", "--merges", "--format=%P", "-n", "5000", trunk]).out).flatMap((l) =>
      l.split(" ").slice(1),
    ),
  );
  const tipOf = (/** @type {string} */ ref) => git(main, ["rev-parse", "--verify", "--quiet", ref]).out;
  const inTrunk = (/** @type {string} */ ref) => git(main, ["merge-base", "--is-ancestor", ref, trunk]).ok;

  const cwds = processCwds();
  const leases = (base.locks ?? []).filter((l) => l.kind === "lease" && l.alive);
  const worktrees = base.worktrees.map((w) => {
    const dir = join(loops, w.name);
    const t = w.branch ? tipOf(w.branch) : "";
    const proc = cwds.find((c) => c.cwd === dir || c.cwd.startsWith(`${dir}/`));
    const lease = leases.find((l) => l.holder === w.name || l.holder?.startsWith(`${w.name}: `));
    const busy = proc
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

  const sessionsDir = env.CARETOOK_SESSIONS_DIR || join(loops, ".sessions");
  const sessions = readRecords(sessionsDir).map(({ name, record }) => {
    const m = /^(prd|plan)-(.+)$/.exec(name);
    const worktree = m ? (m[1] === "prd" ? m[2] : `plan-${m[2]}`) : null;
    const w = worktree ? byName.get(worktree) : undefined;
    return {
      name,
      live: isLive(record, processOf(record.pid ?? 0, now), now),
      rotating: !!record.rotating,
      worktree,
      worktreeExists: worktree ? existsSync(join(loops, worktree)) : undefined,
      ...(w ? { branch: w.branch, landed: w.landed } : {}),
      path: join(sessionsDir, `${name}.json`),
    };
  });

  const checkedOut = new Set(
    lines(git(main, ["worktree", "list", "--porcelain"]).out)
      .filter((l) => l.startsWith("branch refs/heads/"))
      .map((l) => l.slice("branch refs/heads/".length)),
  );
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

  const owners = new Map(worktrees.map((w) => [testDbName(w.name), w.name]));
  const testDbs = lines(run("bash", [join(HERE, "test-db.sh"), "list"], { cwd: main, env }).out)
    .map((l) => /^(caretook_test_[a-z0-9_]+)( \(worker copy)?/.exec(l))
    .filter((m) => !!m)
    .map((m) => ({ db: m[1], worktree: m[2] ? null : (owners.get(m[1]) ?? null) }));

  const usedProjects = [
    "caretook",
    env.CARETOOK_SHARED_TEST_PROJECT || "caretook-shared-test",
    ...worktrees.flatMap((w) => (w.stack ? [w.stack, `${w.stack}-test`] : [])),
  ];
  const volumes = dockerUp
    ? lines(
        run("docker", [
          "volume",
          "ls",
          "--filter",
          "dangling=true",
          "--format",
          '{{.Name}}\t{{.Label "com.docker.compose.project"}}',
        ]).out,
      ).map((l) => {
        const [name, project = ""] = l.split("\t");
        return { name, project };
      })
    : [];

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

  return {
    worktrees,
    sessions,
    branches,
    staleRemotes,
    locks,
    testDbs,
    volumes,
    usedProjects,
    hangLogs,
    items: json(["list", "--json"]),
    registry: json(["prd", "list", "--json"]),
  };
}

/** Removes the safe findings; returns how many failed. */
function act(/** @type {ReturnType<typeof tidy>["safe"]} */ safe, /** @type {string} */ main) {
  let failed = 0;
  let pruned = false;
  const step = (/** @type {string} */ label, /** @type {() => boolean} */ fn) => {
    let ok = false;
    try {
      ok = fn();
    } catch (e) {
      console.error(String(e));
    }
    if (ok) console.log(`removed ${label}`);
    else {
      console.error(`couldn't remove ${label} (see above)`);
      failed++;
    }
  };
  const sh = (/** @type {string[]} */ args) =>
    spawnSync(args[0], args.slice(1), { cwd: main, stdio: ["ignore", "inherit", "inherit"] }).status === 0;
  for (const f of safe) {
    const label = `${f.kind} ${f.target}`;
    switch (f.kind) {
      case "worktree":
        step(label, () => sh(["bash", join(HERE, "rm.sh"), f.target]));
        break;
      case "test-db":
        step(label, () => sh(["bash", join(HERE, "test-db.sh"), "drop-db", f.target]));
        break;
      case "remote":
        if (!pruned) {
          pruned = true;
          step("stale remote-tracking refs (git fetch --prune)", () =>
            sh(["git", "-C", main, "fetch", "--prune", "--quiet", "origin"]),
          );
        }
        break;
      case "volume":
        step(label, () => sh(["docker", "volume", "rm", f.target]));
        break;
      case "record":
      case "hang-log":
      case "slot":
      case "lease":
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
