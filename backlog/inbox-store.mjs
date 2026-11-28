// The inbox store: a private git repo holding the inbox files (`<project>.md`), in the
// trunk inbox's format, so format.mjs's parsers and inbox-edit.mjs serve both. This
// module is the only code that knows the repo's clone and the only one that runs git
// in it; every other file asks it. It never touches a project's checkout.
//
// The clone is bare, one per repo URL (its folder's name carries a short hash of the
// URL, so two URLs never share one), under ~/.risa/inbox-store/ (RISA_INBOX_STORE
// names another folder, made absolute), made on first use: in a temporary folder
// renamed into place, so two processes making it at once both end on one clone. It reads and writes the remote's BRANCH
// through its remote-tracking ref: a read shows the file at that ref; a write builds
// a commit on the ref's tip from a temporary index, changing only its file, and
// pushes it without force. A refused push is fetched and rebuilt on the new tip,
// TRIES times in all; then it fails and nothing was written. A remote with no
// branch (emptied, or replaced by an empty repo) clears the ref: nothing to read,
// and the next write starts the branch.
//
// Run directly, it is the store CLI (the inbox session's entry point; see CLI below).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_NAME, inboxStore, loadConfig } from "../loops/config.mjs";
import { MACHINE_DIR, MachineConfigError, loadMachineConfig } from "../loops/machine.mjs";

/** Pushes tried before a write gives up. */
export const TRIES = 5;
/** The store's one branch. */
export const BRANCH = "main";
const REMOTE = "origin";
const TRACKING = `refs/remotes/${REMOTE}/${BRANCH}`;
const GIT_TIMEOUT_MS = 120_000;

/** A store that can't be cloned, fetched for a write, or pushed to. */
export class StoreError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "StoreError";
  }
}

/**
 * The folder the clones are in: RISA_INBOX_STORE, else ~/.risa/inbox-store.
 * @param {Record<string, string | undefined>} [env]
 */
export const storeRoot = (env = process.env) =>
  resolve(env.RISA_INBOX_STORE || join(env.HOME || homedir(), MACHINE_DIR, "inbox-store"));

/**
 * The clone's folder name for a repo URL: its host and path, one safe name, then a
 * short hash of the whole URL, so URLs the safe name folds together (a/b-c, a-b/c)
 * never share a clone (git@github.com:me/ideas.git → github.com-me-ideas-<8 hex>).
 * @param {string} repo
 */
export const cloneName = (repo) => {
  const readable =
    repo
      .replace(/^[a-z+]+:\/\//i, "")
      .replace(/^[^@/]+@/, "")
      .replace(/\.git\/?$/, "")
      .replace(/[^\w.-]+/g, "-")
      .replace(/^[-.]+|-+$/g, "") || "store";
  return `${readable}-${createHash("sha256").update(repo).digest("hex").slice(0, 8)}`;
};

/**
 * The store for a git URL.
 * @param {string} repo the store repo's URL (a config's `inbox.repo`)
 * @param {{ env?: Record<string, string | undefined> }} [opts]
 */
export function storeFor(repo, { env = process.env } = {}) {
  const dir = join(storeRoot(env), cloneName(repo));
  /** git in the clone, its output untouched. */
  const run = (
    args,
    { input, extraEnv } = /** @type {{ input?: string, extraEnv?: Record<string, string> }} */ ({}),
  ) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      input,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
    });
  const tryRun = (args) => {
    try {
      return run(args).trim();
    } catch {
      return null;
    }
  };

  /**
   * Makes the clone when there is none: a bare repo with the URL as its remote, made
   * in a temporary folder and renamed into place. A process that loses the race to
   * rename (another made the clone first) drops its own and uses the winner's.
   */
  const ensure = () => {
    if (existsSync(join(dir, "HEAD"))) return;
    const tmp = `${dir}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      mkdirSync(tmp, { recursive: true });
      execFileSync("git", ["init", "-q", "--bare", tmp], { stdio: "pipe" });
      execFileSync("git", ["-C", tmp, "remote", "add", REMOTE, repo], { stdio: "pipe" });
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      throw new StoreError(
        `couldn't make the inbox store's clone at ${dir}: ${e instanceof Error ? e.message : e}`,
      );
    }
    try {
      renameSync(tmp, dir);
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      if (!existsSync(join(dir, "HEAD")))
        throw new StoreError(
          `couldn't make the inbox store's clone at ${dir}: ${e instanceof Error ? e.message : e}`,
        );
    }
  };
  /**
   * Fetches the branch; false when the remote can't be reached. A remote that answers
   * with no branch (empty) is reachable, and clears the tracking ref: its old tip is gone.
   */
  const fetch = () => {
    if (tryRun(["fetch", "--quiet", REMOTE, `+refs/heads/${BRANCH}:${TRACKING}`]) !== null) return true;
    const heads = tryRun(["ls-remote", "--quiet", REMOTE, `refs/heads/${BRANCH}`]);
    if (heads !== "") return false;
    tryRun(["update-ref", "-d", TRACKING]);
    return true;
  };
  const tip = () => tryRun(["rev-parse", "--verify", "--quiet", TRACKING]) || null;
  /** The file at a commit, or null. */
  const show = (rev, file) => {
    if (!rev) return null;
    try {
      return run(["show", `${rev}:${file}`]);
    } catch {
      return null;
    }
  };

  return {
    repo,
    /** The clone's folder. */
    dir,
    /**
     * The file's text at the store's tip, or null when there is no such file. Fetches
     * first, best effort (offline: the last fetched copy); `fetch: false` reads that
     * copy with no network.
     * @param {string} file a store file (risa.md)
     * @param {{ fetch?: boolean }} [opts]
     * @returns {string | null}
     */
    read(file, { fetch: doFetch = true } = {}) {
      checkFile(file);
      if (!existsSync(join(dir, "HEAD"))) {
        if (!doFetch) return null;
        ensure();
      }
      if (doFetch) fetch();
      return show(tip(), file);
    },
    /**
     * Applies EDIT to the tip's copy of FILE (null: no file yet) and pushes the result
     * as one commit changing only that file. Returns the commit, or null when the edit
     * changed nothing. Throws a StoreError when the store can't be fetched or after
     * TRIES refused pushes; nothing was written then. A throw from EDIT stops it.
     * @param {string} file
     * @param {(text: string | null) => string | null} edit
     * @param {string} message the commit message
     * @param {{ log?: (line: string) => void }} [opts]
     * @returns {string | null}
     */
    write(file, edit, message, { log = (line) => console.error(line) } = {}) {
      checkFile(file);
      ensure();
      const tmpIndex = join(dir, `inbox-store-index-${process.pid}`);
      try {
        for (let tries = 1; tries <= TRIES; tries++) {
          if (!fetch()) throw new StoreError(`couldn't fetch the inbox store (${repo}); nothing was written`);
          const base = tip();
          const text = show(base, file);
          const next = edit(text);
          if (next === text || next === null) return null;
          const extraEnv = { GIT_INDEX_FILE: tmpIndex };
          rmSync(tmpIndex, { force: true });
          if (base) run(["read-tree", base], { extraEnv });
          const blob = run(["hash-object", "-w", "--stdin"], { input: next }).trim();
          run(["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`], { extraEnv });
          const tree = run(["write-tree"], { extraEnv }).trim();
          const commit = run(["commit-tree", tree, ...(base ? ["-p", base] : []), "-F", "-"], {
            input: message.endsWith("\n") ? message : `${message}\n`,
          }).trim();
          if (tryRun(["push", "--quiet", REMOTE, `${commit}:refs/heads/${BRANCH}`]) !== null) {
            tryRun(["update-ref", TRACKING, commit]);
            return commit;
          }
          if (tries < TRIES) log(`the inbox store moved; building the edit on its new tip`);
        }
      } finally {
        rmSync(tmpIndex, { force: true });
      }
      throw new StoreError(
        `the inbox store (${repo}) refused ${TRIES} pushes (it kept moving, or the push fails); nothing was written`,
      );
    },
  };
}

/** A store file is a name at the store's root (risa.md), never a path. @param {string} file */
function checkFile(file) {
  if (!/^[\w][\w.-]*$/.test(file)) throw new StoreError(`${file}: not a store file (a name like risa.md)`);
}

// ---- finding the store -----------------------------------------------------

/**
 * @typedef {{ name: string, file: string, repo: string, main: string, configPath: string,
 *   config: Record<string, any> }} StoreProject a machine config repo with an `inbox` group
 */

/**
 * The machine config's repos that have an `inbox` group (a repo whose config doesn't
 * load is left out). None without a machine config.
 * @param {{ env?: Record<string, string | undefined> }} [opts]
 * @returns {StoreProject[]}
 */
export function storeProjects({ env = process.env } = {}) {
  const machine = loadMachineConfig({ env });
  /** @type {StoreProject[]} */
  const out = [];
  for (const r of machine?.repos ?? []) {
    const configPath = join(r.path, CONFIG_NAME);
    let config;
    try {
      config = loadConfig({ path: configPath, env }).config;
    } catch {
      continue;
    }
    const s = inboxStore(config);
    if (s) out.push({ name: config.name, file: s.file, repo: s.repo, main: r.path, configPath, config });
  }
  return out;
}

/**
 * The store this machine uses: the machine config's repos' `inbox.repo` (all the same;
 * two differing refuse, naming both), else the one existing clone under storeRoot.
 * Throws a StoreError when there is none, or more than one to choose from.
 * @param {{ env?: Record<string, string | undefined> }} [opts]
 * @returns {string} the store repo's URL
 */
export function findStoreRepo({ env = process.env } = {}) {
  const projects = storeProjects({ env });
  const repos = [...new Set(projects.map((p) => p.repo))];
  if (repos.length > 1) {
    const [a, b] = repos.map((repo) => projects.find((p) => p.repo === repo));
    throw new StoreError(
      `the machine config's repos name different inbox stores: ${a?.repo} (${a?.main}) and ${b?.repo} (${b?.main}); give them one inbox.repo`,
    );
  }
  if (repos.length) return repos[0];
  const root = storeRoot(env);
  const clones = existsSync(root)
    ? readdirSync(root).filter((n) => !n.includes(".tmp-") && existsSync(join(root, n, "HEAD")))
    : [];
  const urls = clones
    .map((n) => {
      try {
        return execFileSync("git", ["-C", join(root, n), "config", "--get", `remote.${REMOTE}.url`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        return "";
      }
    })
    .filter(Boolean);
  if (urls.length === 1) return urls[0];
  if (urls.length > 1)
    throw new StoreError(
      `no repo in the machine config has an inbox store, and ${root} holds ${urls.length} clones (${urls.join(", ")}): set one inbox.repo`,
    );
  throw new StoreError(
    `no inbox store: no repo in the machine config has an inbox group, and ${root} holds no clone`,
  );
}

// ---- CLI ---------------------------------------------------------------------
//
//   node <tool>/backlog/inbox-store.mjs <add|edit|move|remove|list> --project <name> …
//
// The inbox commands (backlog/inbox-commands.mjs) on the store file `<name>.md`, from
// any folder, inside a repo or not: it needs no project config. The store is
// findStoreRepo's. When a machine config repo's inbox file is that one, its config is
// the one read (the ids' form) and its main checkout's backlog joins the look-alikes;
// else the tool's own config is read and only the store's lines are compared.
// Arguments after the verb are `backlog inbox`'s; exit 3 on a look-alike, 1 on a refusal.

const isMain = () => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

/** @param {string[]} argv */
async function cli(argv) {
  const [verb, ...rest] = argv;
  /** @type {string[]} */
  const pos = [];
  /** @type {Record<string, string | boolean | undefined>} */
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const key = a.slice(2);
    if (key === "anyway") opts.anyway = true;
    else if (["project", "details", "to"].includes(key) && rest[i + 1] !== undefined) opts[key] = rest[++i];
    else
      throw new StoreError(
        `${a}: ${["project", "details", "to"].includes(key) ? "needs a value" : "unknown option"}`,
      );
  }
  const verbs = ["add", "edit", "move", "remove", "list"];
  if (!verbs.includes(verb) || typeof opts.project !== "string")
    throw new StoreError(`usage: inbox-store.mjs <${verbs.join("|")}> --project <name> [arguments…]`);
  const file = `${opts.project}.md`;
  checkFile(file);
  const repo = findStoreRepo();
  const project = storeProjects().find((p) => p.repo === repo && p.file === file) ?? null;
  // format.mjs reads a project config as it loads: the project's own when it is here.
  if (project) process.env.RISA_CONFIG = project.configPath;
  const fmt = await import("./format.mjs");
  const { storeInbox } = await import("./inbox-commands.mjs");
  const { LookAlikeStop, lookAlikeLine } = await import("./inbox-edit.mjs");
  /** The project's backlog and archive items, from its main checkout's copies. */
  const pool = () => {
    if (!project) return [];
    const at = (/** @type {string} */ rel) => {
      const path = join(project.main, rel);
      return existsSync(path) ? fmt.parse(readFileSync(path, "utf8"), { lenient: true }).items : [];
    };
    return [
      ...at(project.config.paths.backlog),
      ...at(project.config.paths.archive).map((i) => ({ ...i, archived: true })),
    ];
  };
  const by = process.env.BACKLOG_BY || userInfo().username || "unknown";
  try {
    for (const line of storeInbox(
      { store: storeFor(repo), file, by, pool },
      verb === "list" ? undefined : verb,
      pos,
      opts,
    ))
      console.log(line);
  } catch (e) {
    if (e instanceof LookAlikeStop) {
      console.error("inbox-store: this looks like what's already filed or in the inbox; nothing was added:");
      for (const m of e.matches) console.error(`  ${lookAlikeLine(m)}`);
      console.error("Rerun with --anyway to add it all the same.");
      process.exit(3);
    }
    if (e instanceof fmt.BacklogError) {
      console.error(`inbox-store: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

if (isMain()) {
  try {
    await cli(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof StoreError || e instanceof MachineConfigError)) throw e;
    console.error(`inbox-store: ${e.message.replace(/\n/g, "; ")}`);
    process.exit(1);
  }
}
