// Moving a project's inbox off its trunk into an inbox store (backlog/inbox-store.mjs):
// `backlog inbox to-repo <git url>`, the user's one command for it.
//
//   1. refuse unless gh says the repo is private (a public or missing one writes
//      nothing), and refuse with an `inbox` group already set (here or on origin);
//   2. fetch the remote's trunk and push trunk's backlog-only commits first (the trunk
//      writer's rule), so lines ingest filed here are tagged on origin too;
//   3. write the unfiled lines of origin's trunk inbox into the project's store file,
//      merged with any there (a line already in it, by its key, isn't added twice);
//      filed (tagged) lines are dropped: their items hold them;
//   4. one trunk commit, built on origin's tip and pushed without force, sets the
//      `inbox` group in the config and removes the trunk inbox file. A refused push
//      is fetched and rebuilt, TRIES times (the store write again, which adds only
//      what is new). `paths.inbox` stays, unread while `inbox` is set.
//
// It touches no working tree, index or HEAD: the pickup (dev-sync) is the caller's.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import * as amend from "./amend.mjs";
import * as fmt from "./format.mjs";
import * as edits from "./inbox-edit.mjs";
import { pushBacklogAhead } from "./origin.mjs";
import { storeFor } from "./inbox-store.mjs";
import { gh } from "../loops/host.mjs";

/** Pushes tried before the move gives up. */
export const TRIES = 5;
const GIT_TIMEOUT_MS = 120_000;

/**
 * @typedef {{
 *   main: string,              the main checkout
 *   gitDir: string,            its git dir, for the temporary index
 *   name: string,              the project's name: its store file is <name>.md
 *   remote: string, trunk: string,
 *   configRel: string,         the config file, relative to the main checkout (risa.json)
 *   inboxRel: string,          the trunk inbox (plans/inbox.md)
 *   hasInbox: boolean,         the loaded config has an `inbox` group
 *   by: string,
 *   backlogFiles: string[],
 *   withLock: <T>(fn: () => T) => T,
 *   env?: Record<string, string | undefined>,
 *   log?: (line: string) => void,
 * }} Move
 */

/**
 * What gh is asked about: an SSH URL as its https form, an https one without its
 * .git, else the URL as given.
 * @param {string} url
 */
export const ghTarget = (url) => {
  const ssh = /^(?:ssh:\/\/)?[^@/]+@([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(url);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return /^https?:\/\//.test(url) ? url.replace(/\.git\/?$/, "") : url;
};

/**
 * Move the project's trunk inbox to the store at URL. Returns the lines to print;
 * a refusal throws a BacklogError, having written nothing.
 * @param {string} url
 * @param {Move} o
 * @returns {string[]}
 */
export function moveToRepo(url, o) {
  const log = o.log ?? ((line) => console.error(line));
  if (!url?.trim()) throw new fmt.BacklogError("usage: inbox to-repo <git url>");
  if (o.hasInbox)
    throw new fmt.BacklogError(`${o.configRel} already has an inbox group: its inbox is in a store`);
  const view = gh(["repo", "view", ghTarget(url), "--json", "visibility"]);
  if (!view.ok) throw new fmt.BacklogError(`gh can't find ${url} (or isn't signed in); nothing was written`);
  let visibility = "";
  try {
    visibility = String(JSON.parse(view.out).visibility ?? "");
  } catch {
    // an answer gh never gives: not private
  }
  if (visibility.toUpperCase() !== "PRIVATE")
    throw new fmt.BacklogError(
      `${url} is ${visibility.toLowerCase() || "not known to be private"}: an inbox store must be a private repo; nothing was written`,
    );

  const git = (
    /** @type {string[]} */ args,
    /** @type {{ input?: string, env?: Record<string, string> }} */ x = {},
  ) =>
    execFileSync("git", ["-C", o.main, ...args], {
      encoding: "utf8",
      input: x.input,
      env: x.env ? { ...process.env, ...x.env } : process.env,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
    });
  const tryGit = (/** @type {string[]} */ args) => {
    try {
      return git(args).trim();
    } catch {
      return null;
    }
  };
  const show = (/** @type {string} */ rev, /** @type {string} */ rel) => {
    try {
      return git(["show", `${rev}:${rel}`]);
    } catch {
      return null;
    }
  };
  const dirty = tryGit(["status", "--porcelain", "--", o.configRel, o.inboxRel]);
  if (dirty)
    throw new fmt.BacklogError(
      `${o.configRel} or ${o.inboxRel} has uncommitted changes in ${o.main}: commit or drop them first; nothing was written`,
    );

  const tracking = `refs/remotes/${o.remote}/${o.trunk}`;
  const fetch = () => {
    if (tryGit(["fetch", "--quiet", o.remote, o.trunk]) === null)
      throw new fmt.BacklogError(`couldn't fetch ${o.remote}/${o.trunk}; nothing was written`);
    const tip = tryGit(["rev-parse", "--verify", "--quiet", tracking]);
    if (!tip) throw new fmt.BacklogError(`${o.remote} has no ${o.trunk}; nothing was written`);
    return tip;
  };
  fetch();
  pushBacklogAhead({ ...o, log });

  const store = storeFor(url, { env: o.env ?? process.env });
  const file = `${o.name}.md`;
  const tmpIndex = join(o.gitDir, `${o.name}-inbox-move-index-${process.pid}`);
  /**
   * Lines filed here (tagged in local trunk's copy) whose tag isn't on origin yet, by
   * line key: title and details, so an unfiled line that only shares a filed one's title
   * still moves. The key ignores the tag: parseInbox strips it from the text.
   */
  const localTagged = new Set(
    fmt
      .parseInbox(show(`refs/heads/${o.trunk}`, o.inboxRel) ?? "")
      .filter((e) => e.id)
      .map(fmt.lineKey),
  );
  try {
    for (let tries = 1; tries <= TRIES; tries++) {
      const tip = fetch();
      const configText = show(tip, o.configRel);
      if (configText === null)
        throw new fmt.BacklogError(`${o.remote}/${o.trunk} has no ${o.configRel}; nothing was written`);
      /** @type {Record<string, unknown>} */
      let parsed;
      try {
        parsed = JSON.parse(configText);
      } catch (e) {
        throw new fmt.BacklogError(
          `${o.remote}/${o.trunk}'s ${o.configRel} isn't JSON (${e instanceof Error ? e.message : e}); nothing was written`,
        );
      }
      if (parsed.inbox)
        throw new fmt.BacklogError(
          `${o.remote}/${o.trunk}'s ${o.configRel} already has an inbox group: its inbox is in a store`,
        );
      const inboxText = show(tip, o.inboxRel);
      const lines = fmt.newInboxEntries(inboxText ?? "").filter((e) => !localTagged.has(fmt.lineKey(e)));

      let added = 0;
      let storeSha;
      try {
        storeSha = store.write(
          file,
          (t) => {
            added = 0;
            if (!lines.length) return t;
            const have = new Set(fmt.newInboxEntries(t ?? "").map(fmt.lineKey));
            let out = t ?? "# Inbox\n";
            for (const e of lines) {
              if (have.has(fmt.lineKey(e))) continue;
              out = edits.addEntry(out, e.type, e.text, e.details);
              have.add(fmt.lineKey(e));
              added++;
            }
            return out;
          },
          `inbox: move ${lines.length} line${lines.length === 1 ? "" : "s"} from ${o.name}'s ${o.trunk}\n\nBy: ${o.by}\n`,
          { log },
        );
      } catch (e) {
        if (e instanceof Error && e.name === "StoreError")
          throw new fmt.BacklogError(`${e.message}; ${o.configRel} is unchanged`);
        throw e;
      }

      const env = { GIT_INDEX_FILE: tmpIndex };
      rmSync(tmpIndex, { force: true });
      git(["read-tree", tip], { env });
      const blob = git(["hash-object", "-w", "--stdin"], { input: withInbox(configText, url) }).trim();
      git(["update-index", "--add", "--cacheinfo", `100644,${blob},${o.configRel}`], { env });
      if (inboxText !== null) git(["update-index", "--force-remove", o.inboxRel], { env });
      const tree = git(["write-tree"], { env }).trim();
      const commit = git(["commit-tree", tree, "-p", tip, "-F", "-"], {
        input: amend.writeMessage({
          tool: "inbox to-repo",
          ids: [],
          text: "inbox: move the inbox to its store",
          lines: [`Store: ${url}`, `By: ${o.by}`],
        }),
      }).trim();
      if (tryGit(["push", "--quiet", o.remote, `${commit}:refs/heads/${o.trunk}`]) !== null) {
        tryGit(["update-ref", tracking, commit]);
        return [
          storeSha
            ? `moved ${added} inbox line${added === 1 ? "" : "s"} to ${url} ${file} as ${storeSha.slice(0, 7)}`
            : lines.length
              ? `the ${lines.length} unfiled inbox line${lines.length === 1 ? " is" : "s are"} already in ${url} ${file}`
              : `no unfiled inbox lines to move: ${url} ${file} is unchanged`,
          `${o.configRel} has the inbox group and ${o.inboxRel} is gone, on ${o.remote}/${o.trunk} as ${commit.slice(0, 7)}`,
        ];
      }
      if (tries < TRIES) log(`${o.remote}/${o.trunk} moved; building the move on its new tip`);
    }
  } finally {
    rmSync(tmpIndex, { force: true });
  }
  throw new fmt.BacklogError(
    `${o.remote}/${o.trunk} refused ${TRIES} pushes (it kept moving, or the push fails): ${o.configRel} is unchanged, and the lines already in the store stay (a rerun adds only what is new)`,
  );
}

/**
 * The config's text with `"inbox": { "repo": URL }` as its last key, the rest as written.
 * @param {string} text @param {string} url
 */
export function withInbox(text, url) {
  const body = text.replace(/\s*\}\s*$/, "");
  const empty = /\{\s*$/.test(body);
  return `${body}${empty ? "" : ","}\n  "inbox": { "repo": ${JSON.stringify(url)} }\n}\n`;
}
