#!/usr/bin/env node
// Collects the facts inventory.mjs classifies: every .loops worktree (git), its
// stack and containers (docker), its dev server (lsof), the locks and their
// holders, the dispatcher and its restart intent, which sessions it manages,
// a running recover, migrates cut off, the down record and free disk. Read-only: it runs only git, `docker info|ps|inspect`, `lsof` and
// `df`, and writes nothing (git runs with --no-optional-locks, so not even the
// index is refreshed).
//
//   node inventory-facts.mjs [--main DIR] [--facts|--json|--text]
//     --text (default)  the inventory as a table and an action list
//     --json            the inventory as JSON (recover --dry-run --json)
//     --facts           the raw facts as JSON
//
// DIR defaults to the main checkout of the repo this file is in. Env: TRUNK
// (dev), CARETOOK_LEASE_ROOT (DIR/.loops/.lease), CARETOOK_MIN_FREE_GB (10),
// CARETOOK_FREE_GB (overrides the df reading, for tests), CARETOOK_SESSIONS_DIR
// (DIR/.loops/.sessions), CARETOOK_LANDING_DIR (DIR/.loops/.landing: the
// landing journal).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_MIN_FREE_GB, formatInventory, inventory } from "./inventory.mjs";
import { listRecords } from "./land-journal.mjs";

/** The backlog lock is stale after this long (backlog.mjs takes it over then too). */
export const BACKLOG_LOCK_STALE_MS = 30_000;

const run = (
  /** @type {string} */ cmd,
  /** @type {string[]} */ args,
  /** @type {NodeJS.ProcessEnv} */ env,
) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
};
const git = (/** @type {string} */ cwd, /** @type {string[]} */ args, /** @type {NodeJS.ProcessEnv} */ env) =>
  run("git", ["--no-optional-locks", "-C", cwd, ...args], env);
const lines = (/** @type {string} */ s) => s.split("\n").filter(Boolean);
/** A JSON object file's contents, or null (missing, unreadable, not an object). */
const readObject = (/** @type {string} */ p) => {
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};
const readOr = (/** @type {string} */ p, fallback = "") => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return fallback;
  }
};
const files = (/** @type {string} */ p) => {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
};
const dirs = (/** @type {string} */ p) => {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
};

/** KEY's value in an env file, as lib.sh's env_get reads it. */
export function envGet(/** @type {string} */ file, /** @type {string} */ key) {
  const hits = readOr(file)
    .split("\n")
    .filter((l) => l.startsWith(`${key}=`));
  return hits.length ? hits[hits.length - 1].slice(key.length + 1).replaceAll('"', "") : "";
}

/** Is process `pid` alive? (EPERM means it is, just not ours.) */
export function pidAlive(/** @type {number|null|undefined} */ pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
}

/** lib.sh's parent_of: slice/<topic>/<n> → prd/<topic>, anything else → trunk. */
export function parentOf(/** @type {string} */ branch, trunk = "dev") {
  const m = /^slice\/([^/]+)\/[^/]+$/.exec(branch);
  return m ? `prd/${m[1]}` : trunk;
}

/** stack-lib.sh's slice_merged: the slice's tip is a merge's second parent in its PRD branch. */
function sliceMerged(
  /** @type {string} */ dir,
  /** @type {string} */ branch,
  /** @type {NodeJS.ProcessEnv} */ env,
) {
  if (!/^slice\/[^/]+\/[^/]+$/.test(branch)) return false;
  const parent = parentOf(branch);
  const tip = git(dir, ["rev-parse", "HEAD"], env);
  if (!tip.ok || !git(dir, ["rev-parse", "--verify", "--quiet", parent], env).ok) return false;
  if (!git(dir, ["merge-base", "--is-ancestor", tip.out, parent], env).ok) return false;
  const merges = git(dir, ["log", "--merges", "--format=%P", "-n", "2000", parent], env).out;
  return lines(merges).some((l) => l.split(" ").slice(1).includes(tip.out));
}

/** Container ids of a Compose project: running only, or all. */
function containers(
  /** @type {string} */ project,
  all = false,
  /** @type {NodeJS.ProcessEnv} */ env = process.env,
) {
  const r = run(
    "docker",
    ["ps", all ? "-aq" : "-q", "--filter", `label=com.docker.compose.project=${project}`],
    env,
  );
  return r.ok ? lines(r.out) : [];
}

/** How long ago the newest container of a stopped project finished, in seconds. */
function stoppedSecs(/** @type {string[]} */ ids, /** @type {NodeJS.ProcessEnv} */ env, now = Date.now()) {
  if (!ids.length) return null;
  const r = run("docker", ["inspect", "-f", "{{.State.Running}} {{.State.FinishedAt}}", ...ids], env);
  if (!r.ok) return null;
  let newest = 0;
  for (const l of lines(r.out)) {
    const [running, at] = l.split(" ");
    if (running === "true") return null;
    const t = Date.parse(at ?? "");
    if (t > newest) newest = t;
  }
  return newest > 0 ? Math.max(0, Math.round((now - newest) / 1000)) : null;
}

const listening = (/** @type {number} */ port, /** @type {NodeJS.ProcessEnv} */ env) =>
  run("lsof", ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"], env).out !== "";

/** Free GB on the volume holding DIR (CARETOOK_FREE_GB overrides it). */
export function freeGb(/** @type {string} */ dir, /** @type {NodeJS.ProcessEnv} */ env = process.env) {
  if (env.CARETOOK_FREE_GB) {
    const n = Number(env.CARETOOK_FREE_GB);
    return Number.isFinite(n) ? n : null;
  }
  const r = run("df", ["-Pk", dir], env);
  const cols = lines(r.out)[1]?.split(/\s+/);
  const kb = Number(cols?.[3]);
  return r.ok && Number.isFinite(kb) ? Math.round((kb / 1024 / 1024) * 10) / 10 : null;
}

/** The pid=, worktree= and check= lines of a lease.sh `name` file. */
function leaseInfo(/** @type {string} */ file) {
  /** @type {Record<string, string>} */
  const kv = {};
  for (const l of lines(readOr(file))) {
    const i = l.indexOf("=");
    if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1);
  }
  return kv;
}

/**
 * @param {{ main: string, env?: NodeJS.ProcessEnv, now?: number }} opts
 * @returns {import("./inventory.mjs").Facts}
 */
export function collectFacts({ main, env = process.env, now = Date.now() }) {
  const trunk = env.TRUNK || "dev";
  const loops = join(main, ".loops");
  const dockerUp = run("docker", ["info"], env).ok;

  // Migrates recover's stack step started and never finished (.loops/.migrate/<name>,
  // holding when it started): a crash cut them off.
  const migrateDir = join(loops, ".migrate");
  const migrating = new Map(files(migrateDir).map((n) => [n, readOr(join(migrateDir, n)).trim() || "?"]));

  const worktrees = [];
  for (const name of dirs(loops)) {
    const dir = join(loops, name);
    if (!existsSync(join(dir, ".git"))) continue;
    const branch = git(dir, ["branch", "--show-current"], env).out;
    const stack = envGet(join(dir, ".env"), "CARETOOK_STACK") || null;
    const port = Number(envGet(join(dir, "apps/web/.env"), "WEB_PORT")) || null;
    const up = stack && dockerUp ? containers(stack, false, env) : [];
    const all = stack && dockerUp ? containers(stack, true, env) : [];
    worktrees.push({
      name,
      branch,
      parent: parentOf(branch, trunk),
      merged: sliceMerged(dir, branch, env),
      dirty: git(dir, ["status", "--porcelain"], env).out !== "",
      stack,
      containersUp: up.length,
      containersAll: all.length,
      stoppedSecs: stack && dockerUp && up.length === 0 ? stoppedSecs(all, env, now) : null,
      webPort: port,
      serverRunning: port ? listening(port, env) : false,
      ...(migrating.has(name) ? { migrating: migrating.get(name) } : {}),
    });
  }
  const names = new Set(worktrees.map((w) => w.name));

  /** @type {import("./inventory.mjs").LockFacts[]} */
  const locks = [];
  // Slot leases: stale when the worktree that holds one is gone.
  const slots = join(loops, ".slots");
  for (const n of dirs(slots)) {
    const holder = readOr(join(slots, n, "name")).trim();
    const alive = !!holder && names.has(holder);
    locks.push({
      kind: "slot",
      path: join(slots, n),
      holder: holder || "nobody",
      pid: null,
      alive,
      why: alive ? "its worktree exists" : `slot ${n}: no worktree ${holder || "named"}`,
    });
  }
  // The dispatcher's lock (dispatch.mjs): its pid. Stale when that pid is gone
  // (a crash, or a restart with it running): recover clears it and reopens it.
  const dispatchLock = join(loops, ".dispatch.lock");
  let dispatcher = { running: false, pid: /** @type {number|null} */ (null), lock: dispatchLock };
  if (existsSync(dispatchLock)) {
    const pid = Number(readOr(dispatchLock).trim()) || null;
    const alive = pidAlive(pid);
    dispatcher = { running: alive, pid, lock: dispatchLock };
    locks.push({
      kind: "dispatch",
      path: dispatchLock,
      holder: "pnpm prd dispatch",
      pid,
      alive,
      why: alive ? `the dispatcher, pid ${pid}, is running` : `the dispatcher's pid ${pid ?? "?"} is gone`,
    });
  }
  // Migrate markers whose worktree is gone: nothing to rerun, so the marker is stale.
  for (const [n, at] of migrating)
    if (!names.has(n))
      locks.push({
        kind: "migrate",
        path: join(migrateDir, n),
        holder: n,
        pid: null,
        alive: false,
        why: `a migrate of ${n} cut off at ${at}, and ${n} has no worktree now`,
      });
  // The dispatcher's restart intent (.loops/.dispatch-intent.json): recover writes it
  // before clearing a stale lock and deletes it once the new dispatcher holds its lock.
  const dispatchIntent = readObject(join(loops, ".dispatch-intent.json"));
  // A running recover (.loops/.recover.lock, its pid): one at a time.
  const recoverPid = Number(readOr(join(loops, ".recover.lock")).trim()) || null;
  const recover = { running: pidAlive(recoverPid), pid: recoverPid };
  // The backlog lock: no pid; backlog.mjs takes over one older than 30 s.
  const common = git(main, ["rev-parse", "--git-common-dir"], env);
  if (common.ok) {
    const lock = join(resolve(main, common.out), "caretook-backlog.lock");
    if (existsSync(lock)) {
      const age = now - statSync(lock).mtimeMs;
      const alive = age <= BACKLOG_LOCK_STALE_MS;
      locks.push({
        kind: "backlog",
        path: lock,
        holder: "pnpm backlog",
        pid: null,
        alive,
        why: `${Math.round(age / 1000)}s old${alive ? "" : `, over ${BACKLOG_LOCK_STALE_MS / 1000}s`}`,
      });
    }
  }
  // Machine-wide leases (lease.sh): reported; a dead holder is taken over by the next taker.
  const leaseRoot = env.CARETOOK_LEASE_ROOT || join(loops, ".lease");
  for (const kind of dirs(leaseRoot))
    for (const n of dirs(join(leaseRoot, kind))) {
      const info = leaseInfo(join(leaseRoot, kind, n, "name"));
      const pid = Number(info.pid) || null;
      const alive = pidAlive(pid);
      locks.push({
        kind: "lease",
        path: join(leaseRoot, kind, n),
        holder: [info.worktree, info.check].filter(Boolean).join(": ") || kind,
        pid,
        alive,
        why: `${kind} lease, pid ${pid ?? "?"} ${alive ? "running" : "gone"}`,
      });
    }

  const downRecordPath = join(loops, ".down.json");
  let downRecord = null;
  let downRecordError;
  if (existsSync(downRecordPath)) {
    try {
      downRecord = JSON.parse(readFileSync(downRecordPath, "utf8"));
      if (!downRecord || typeof downRecord !== "object" || Array.isArray(downRecord))
        throw new Error("not a JSON object");
    } catch (e) {
      downRecord = null;
      downRecordError = `${downRecordPath}: ${/** @type {Error} */ (e).message}`;
    }
  }

  const testDbProject = env.CARETOOK_SHARED_TEST_PROJECT || "caretook-shared-test";
  const testDbRunning =
    dockerUp &&
    run(
      "docker",
      [
        "ps",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${testDbProject}`,
        "--filter",
        "label=com.docker.compose.service=postgres",
        "--filter",
        "status=running",
      ],
      env,
    ).out !== "";

  // Which session records the dispatcher manages (session.sh --managed).
  const sessionsDir = env.CARETOOK_SESSIONS_DIR || join(loops, ".sessions");
  /** @type {string[]} */
  const managed = [];
  let records = [];
  try {
    records = readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    /* no records */
  }
  for (const f of records)
    try {
      if (JSON.parse(readOr(join(sessionsDir, f), "{}")).managed === true) managed.push(f.slice(0, -5));
    } catch {
      /* a record being written */
    }

  // Landings cut off midway (land-journal.mjs): one record each.
  const landings = listRecords(env.CARETOOK_LANDING_DIR || join(loops, ".landing")).map((r) => ({
    branch: String(r.branch ?? ""),
    path: String(r.path ?? ""),
    step: String(r.step ?? ""),
    at: String(r.at ?? ""),
    file: r.file,
  }));

  const min = Number(env.CARETOOK_MIN_FREE_GB);
  return {
    landings,
    worktrees,
    locks,
    dispatcher,
    dispatchIntent,
    recover,
    managed,
    docker: { running: dockerUp },
    testDb: { running: testDbRunning },
    downRecord,
    downRecordPath,
    ...(downRecordError ? { downRecordError } : {}),
    disk: {
      freeGb: freeGb(main, env),
      minGb: env.CARETOOK_MIN_FREE_GB && min >= 0 ? min : DEFAULT_MIN_FREE_GB,
    },
  };
}

function main() {
  const argv = process.argv.slice(2);
  let mainDir = "";
  let mode = "text";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--main") mainDir = argv[++i] ?? "";
    else if (a === "--json") mode = "json";
    else if (a === "--facts") mode = "facts";
    else if (a === "--text") mode = "text";
    else {
      console.error(`inventory-facts: unknown argument ${a} (--main DIR, --json, --facts, --text)`);
      process.exit(2);
    }
  }
  if (!mainDir) {
    const here = dirname(fileURLToPath(import.meta.url));
    mainDir = execFileSync("git", ["-C", here, "worktree", "list", "--porcelain"], { encoding: "utf8" })
      .split("\n")[0]
      .replace(/^worktree /, "");
  }
  const facts = collectFacts({ main: mainDir });
  if (mode === "facts") console.log(JSON.stringify(facts, null, 2));
  else if (mode === "json") console.log(JSON.stringify(inventory(facts), null, 2));
  else console.log(formatInventory(inventory(facts)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
