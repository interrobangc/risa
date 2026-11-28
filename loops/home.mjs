// Home machines: which machine runs a project's backlog, so two machines never run one
// (RISA-1007). The claims are one file in the inbox store, `homes.json`, one entry a
// name: a project as `--project` names it (its store file's stem) or `inbox` (the one
// inbox session). The store module (backlog/inbox-store.mjs) does every read and write.
//
//   { "risa": { "machine": "mac-a", "since": "2026-11-28T10:00:00Z" }, "inbox": { … } }
//
// claim writes only when the name is unclaimed or already this machine's; take
// overwrites (the user's command). The machine's name is the short host name
// (RISA_MACHINE_NAME overrides, for tests).
//
// The dispatcher (dispatch.mjs, for a project with `inbox` only: it loads this module
// then) runs homeTick each tick: the first tick of a run claims the project's home,
// and the inbox home too from the inbox keeper (the machine config's first repo with
// `inbox` whose work switch is on, RISA_WORK_SELF aside so every shell agrees; prd.sh
// inbox opens the session from the same repo). Later ticks read the homes file's last
// fetched copy, and fetch it at most every REFETCH_MS. A name this run couldn't claim
// (the store can't be reached) is unknown: nothing starts for it until it is; so is every
// name while the homes file can't be read or parsed (RISA-1080). A project
// whose work switch is off (read as the keeper's is) claims nothing: its homes read as
// away or unknown, as on any machine that doesn't hold them (RISA-1078).
//
//   node home.mjs                      the claims, one a line: name, machine, since
//   node home.mjs take <project|inbox> moves that home to this machine
//   node home.mjs inbox-repo           the inbox keeper's main checkout (else the
//                                      machine config's first repo with inbox); exit 1: none
import { hostname } from "node:os";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  StoreError,
  findStoreRepo,
  storeFor,
  storeProjectList,
  storeProjects,
} from "../backlog/inbox-store.mjs";
import { inboxStore, loadConfig, toolCmd } from "./config.mjs";
import { MachineConfigError, WORK_VAR, loadMachineConfig, workSwitch } from "./machine.mjs";

/** The store file holding the claims. */
export const HOMES_FILE = "homes.json";
/** The inbox session's home's name. */
export const INBOX_HOME = "inbox";
/** The dispatcher fetches the homes file at most this often. */
export const REFETCH_MS = 5 * 60_000;

/** This machine's name: RISA_MACHINE_NAME, else the short host name. */
export const machineName = (env = process.env) =>
  env.RISA_MACHINE_NAME || hostname().split(".")[0] || "unknown";

/**
 * The claims in the homes file's text (null: no file yet).
 * @param {string | null} text
 * @returns {Record<string, { machine: string, since?: string }>}
 */
export function homesOf(text) {
  if (text === null || !text.trim()) return {};
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new StoreError(`${HOMES_FILE}: not JSON (${e instanceof Error ? e.message : e})`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new StoreError(`${HOMES_FILE}: must hold one JSON object`);
  // An entry without a machine would read as unclaimed, and a claim would take it as held
  // here: the file is unreadable then, as a file that isn't JSON is (RISA-1080).
  for (const [name, entry] of Object.entries(raw))
    if (typeof entry?.machine !== "string" || !entry.machine)
      throw new StoreError(`${HOMES_FILE}: ${name} names no machine`);
  return raw;
}

const homesText = (/** @type {Record<string, unknown>} */ homes) =>
  `${JSON.stringify(Object.fromEntries(Object.entries(homes).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`;

const stamp = (/** @type {number} */ ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

/** @typedef {ReturnType<typeof storeFor>} Store */

/**
 * The machine NAME's home is, or null when unclaimed.
 * @param {Store} store @param {string} name @param {{ fetch?: boolean }} [opts]
 */
export function homeOf(store, name, { fetch = true } = {}) {
  return homesOf(store.read(HOMES_FILE, { fetch }))[name]?.machine ?? null;
}

/**
 * Claims NAME for MACHINE when it is unclaimed (or already MACHINE's). Returns the holder
 * after it, and the commit (null: nothing written, held already). Throws a StoreError
 * when the store can't be reached.
 * @param {Store} store @param {string} name @param {string} machine
 * @param {{ now?: number, log?: (line: string) => void }} [opts]
 */
export function claim(store, name, machine, { now = Date.now(), log } = {}) {
  /** @type {string} */
  let holder = machine;
  const commit = store.write(
    HOMES_FILE,
    (text) => {
      const homes = homesOf(text);
      holder = homes[name]?.machine ?? machine;
      if (homes[name]) return text;
      return homesText({ ...homes, [name]: { machine, since: stamp(now) } });
    },
    `home: ${name} on ${machine}`,
    log ? { log } : {},
  );
  return { holder, commit };
}

/**
 * Moves NAME's home to MACHINE, whoever held it. Returns the machine it came from
 * (null: unclaimed) and the commit (null: MACHINE's already).
 * @param {Store} store @param {string} name @param {string} machine
 * @param {{ now?: number, log?: (line: string) => void }} [opts]
 */
export function take(store, name, machine, { now = Date.now(), log } = {}) {
  /** @type {string | null} */
  let from = null;
  const commit = store.write(
    HOMES_FILE,
    (text) => {
      const homes = homesOf(text);
      from = homes[name]?.machine ?? null;
      if (from === machine) return text;
      return homesText({ ...homes, [name]: { machine, since: stamp(now) } });
    },
    `home: ${name} taken by ${machine}`,
    log ? { log } : {},
  );
  return { from, commit };
}

const real = (/** @type {string} */ p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * The inbox keeper: the machine config's first repo with `inbox` whose work switch is
 * on (read without RISA_WORK_SELF, so a dispatcher and a shell agree), or null.
 * @param {{ env?: Record<string, string | undefined> }} [opts]
 */
export function inboxKeeper({ env = process.env } = {}) {
  const machine = loadMachineConfig({ env });
  const { [WORK_VAR]: _self, ...plain } = env;
  return (
    storeProjects({ env }).find(
      (p) => workSwitch({ main: p.main, config: p.config, machine, env: plain }).on,
    ) ?? null
  );
}

/**
 * @typedef {{ pid?: number, claimed?: string[], fetchedAt?: number,
 *   reported?: Record<string, string> }} HomeState the dispatcher's state's `home`
 */

/**
 * One dispatcher tick's home facts for the project at MAIN; null for a project
 * without `inbox` (untouched). `away` names each home another machine holds;
 * `unknown`, each this run couldn't claim; `blocked` is the project's reason to start,
 * plan, reopen and keep alive nothing but the inbox session (null: none); `inboxWhy`,
 * the inbox kind's reason to stay closed, from the keeper choice and the inbox home
 * alone (null: this dispatcher keeps it). REPORT files one report
 * (true: filed); `state` is the next `home` state (dry run: unchanged, nothing written).
 * @param {{ main: string, state?: HomeState, now: number, dryRun?: boolean,
 *   env?: Record<string, string | undefined>, pid?: number,
 *   report?: (text: string) => boolean, config?: Record<string, any> }} facts
 */
export function homeTick({
  main,
  state = {},
  now,
  dryRun = false,
  env = process.env,
  pid = process.pid,
  report,
  config,
}) {
  const cfg = config ?? loadConfig({ env }).config;
  const s = inboxStore(cfg);
  if (!s) return null;
  const name = s.file.replace(/\.md$/, "");
  const me = machineName(env);
  const store = storeFor(s.repo, { env });
  const keeper = inboxKeeper({ env });
  // The project's work switch, read as inboxKeeper reads it (RISA_WORK_SELF aside, so a
  // dispatcher and a shell agree): with it off, this machine claims no home (RISA-1078).
  const { [WORK_VAR]: _self, ...plain } = env;
  const work = workSwitch({ main, config: cfg, env: plain });
  const keepsInbox = keeper !== null && real(keeper.main) === real(main);
  const names = keepsInbox ? [name, INBOX_HOME] : [name];
  const fresh = state.pid !== pid;
  /** @type {string[]} */
  const claimed = fresh ? [] : [...(state.claimed ?? [])];
  /** @type {string[]} */
  const lines = [];
  const takeCmd = `${toolCmd.prd} home take`;
  const offWhy = work.on ? null : `the work switch is off (${work.why})`;
  if (offWhy && fresh) lines.push(`home: claims no home for ${name}: ${offWhy}`);
  let reached = false;
  for (const n of names.filter((x) => !claimed.includes(x))) {
    if (dryRun || offWhy) continue;
    try {
      const r = claim(store, n, me, { now, log: () => {} });
      claimed.push(n);
      reached = true;
      if (r.commit) lines.push(`home: claimed ${n} for ${me}`);
    } catch (e) {
      lines.push(`home: couldn't claim ${n} (${e instanceof Error ? e.message : e})`);
    }
  }
  const due = !reached && (state.fetchedAt === undefined || now - state.fetchedAt >= REFETCH_MS);
  let homes = {};
  // A homes file that can't be read or parsed leaves every home unknown, not open: what
  // this run claimed earlier is dropped, so the gate stays shut until a readable file
  // says this machine holds the home (the next tick's claim reads it) (RISA-1080).
  /** @type {string | null} */
  let unreadable = null;
  try {
    homes = homesOf(store.read(HOMES_FILE, { fetch: due }));
  } catch (e) {
    unreadable = `the homes file is unreadable (${e instanceof Error ? e.message : e})`;
    for (const n of names) if (claimed.includes(n)) claimed.splice(claimed.indexOf(n), 1);
  }
  /** @type {Record<string, string>} */
  const away = {};
  /** @type {string[]} */
  const unknown = [];
  for (const n of names) {
    const holder = homes[n]?.machine ?? null;
    if (holder && holder !== me) away[n] = holder;
    else if (unreadable || (!dryRun && !claimed.includes(n))) unknown.push(n);
    else if (dryRun && !holder && !offWhy) lines.push(`home: would claim ${n} for ${me}`);
  }
  const blocked = away[name]
    ? `${name}'s home is ${away[name]}, not ${me} (${takeCmd} ${name} moves it here)`
    : unknown.includes(name)
      ? unreadable
        ? `${name}'s home isn't known (${unreadable})`
        : offWhy
          ? `${name}'s home isn't claimed here (${offWhy})`
          : `${name}'s home isn't known yet (the inbox store can't be reached)`
      : null;
  let inboxWhy = null;
  if (!keepsInbox) {
    inboxWhy = `the inbox keeper is ${keeper ? keeper.main : "no repo"} (the machine config's first \`work: true\` repo with inbox)`;
    if (fresh) lines.push(`home: the inbox session is left to ${keeper ? keeper.main : "no repo here"}`);
  } else if (away[INBOX_HOME])
    // The inbox session is the inbox home's alone: the project's home away doesn't close it (RISA-1079).
    inboxWhy = `the inbox home is ${away[INBOX_HOME]}, not ${me} (${takeCmd} ${INBOX_HOME} moves it here)`;
  else if (unknown.includes(INBOX_HOME))
    inboxWhy = unreadable
      ? `the inbox home isn't known (${unreadable})`
      : offWhy
        ? `the inbox home isn't claimed here (${offWhy})`
        : "the inbox home isn't known yet (the inbox store can't be reached)";
  if (blocked)
    lines.push(
      `home: ${blocked}: nothing starts, plans, reopens or is kept alive here${keepsInbox && !inboxWhy ? " but the inbox session" : ""}`,
    );
  if (inboxWhy && keepsInbox) lines.push(`home: ${inboxWhy}: the inbox session isn't kept here`);

  /** @type {Record<string, string>} */
  const reported = {};
  for (const [n, holder] of Object.entries(away)) {
    if (state.reported?.[n] === holder) {
      reported[n] = holder;
      continue;
    }
    const what =
      n === INBOX_HOME
        ? "doesn't keep the inbox session"
        : `starts, plans, reopens and keeps alive nothing for ${n}`;
    const text = `${n}'s home is ${holder}, not this machine (${me}): this machine's dispatcher ${what}. \`${takeCmd} ${n}\` moves it here.`;
    if (dryRun) lines.push(`home: would report ${n} is ${holder}'s`);
    else if (report?.(text)) {
      reported[n] = holder;
      lines.push(`home: reported ${n} is ${holder}'s`);
    }
  }
  /** @type {HomeState} */
  const next = dryRun ? state : { pid, claimed, fetchedAt: due || reached ? now : state.fetchedAt, reported };
  return { name, me, away, unknown, blocked, inboxWhy, lines, state: next };
}

// ---- CLI ---------------------------------------------------------------------

const isMain = () => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

/** @param {string[]} argv */
function cli(argv) {
  const [verb, ...rest] = argv;
  if (verb === "inbox-repo") {
    const p = inboxKeeper() ?? storeProjects()[0] ?? null;
    if (!p) process.exit(1);
    console.log(p.main);
    return;
  }
  const repo = findStoreRepo();
  const store = storeFor(repo);
  const me = machineName();
  if (verb === undefined) {
    const homes = homesOf(store.read(HOMES_FILE));
    const names = Object.keys(homes).sort();
    if (!names.length) console.log(`no homes claimed in ${repo} yet`);
    for (const n of names)
      console.log(
        [n, homes[n].machine, homes[n].since ?? "", homes[n].machine === me ? "(this machine)" : ""]
          .join("\t")
          .trimEnd(),
      );
    return;
  }
  if (verb === "take" && rest.length === 1) {
    const [name] = rest;
    const known = [INBOX_HOME, ...storeProjectList(repo).map((p) => p.project)];
    if (!known.includes(name))
      throw new StoreError(`${name}: not a project in the inbox store (${known.join(", ")})`);
    const { from, commit } = take(store, name, me);
    console.log(
      commit
        ? `${name}'s home is now ${me}${from ? ` (was ${from})` : ""}: on ${repo} ${HOMES_FILE} as ${commit.slice(0, 7)}`
        : `${name}'s home is ${me} already`,
    );
    return;
  }
  throw new StoreError(`usage: ${toolCmd.prd} home [take <project|inbox>]`);
}

if (isMain()) {
  try {
    cli(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof StoreError || e instanceof MachineConfigError)) throw e;
    console.error(`home: ${e.message.replace(/\n/g, "; ")}`);
    process.exit(1);
  }
}
