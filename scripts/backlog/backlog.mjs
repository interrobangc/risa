#!/usr/bin/env node
// The live backlog: plans/backlog.md on dev, in the main checkout.
//
// Anyone (the user, orchestrators, PRD-writing and slice agents) runs this from
// any worktree. Every write takes a lock, edits the main checkout's copy, and
// commits only that file onto dev, so the list is live for everyone without
// merges. Reads show the main checkout's copy too.
//
//   pnpm backlog list [--all] [--prd P] [--status S] [--type T] [--owner O]
//   pnpm backlog show B-n
//   pnpm backlog add <type> <title…> [--prd P] [--status S] [--note TEXT]
//   pnpm backlog set B-n key=value…          keys: status type title prd owner commit
//   pnpm backlog note B-n <text…>
//   pnpm backlog claim B-n [--as OWNER] [--force]   owner defaults to your branch
//   pnpm backlog release B-n
//   pnpm backlog done B-n… [--commit SHA]    work merged into its PRD branch (default: your HEAD)
//   pnpm backlog refresh [--no-fetch]        write the derived statuses (landed, staging, live)
//   pnpm backlog commit [message]            commit hand edits of backlog.md (normalised)
//   pnpm backlog path
//
// Env: BACKLOG_BY (who's writing; default your branch, or git user.name on dev),
// BACKLOG_BRANCH (default dev), BACKLOG_REMOTE (default origin).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as fmt from "./format.mjs";

const TRUNK = process.env.BACKLOG_BRANCH ?? "dev";
const REMOTE = process.env.BACKLOG_REMOTE ?? "origin";
const REL = "plans/backlog.md";

const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryGit = (cwd, ...args) => {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
};

const here = process.cwd();
const mainCheckout = git(here, "worktree", "list", "--porcelain")
  .split("\n")[0]
  .replace(/^worktree /, "");
const file = join(mainCheckout, REL);
const lockDir = join(
  resolve(mainCheckout, git(mainCheckout, "rev-parse", "--git-common-dir")),
  "caretook-backlog.lock",
);

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const myBranch = () => tryGit(here, "branch", "--show-current") || "";
const who = () => {
  if (process.env.BACKLOG_BY) return process.env.BACKLOG_BY;
  const b = myBranch();
  return b && b !== TRUNK ? b : tryGit(here, "config", "user.name") || "unknown";
};

// ---- arguments ------------------------------------------------------------

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const flag = ["all", "force", "no-fetch"].includes(key);
      opts[key] = flag ? true : argv[++i];
      if (!flag && opts[key] === undefined) throw new fmt.BacklogError(`${a} needs a value`);
    } else pos.push(a);
  }
  return { pos, opts };
}

// ---- reading and writing --------------------------------------------------

const read = () => {
  if (!existsSync(file)) throw new fmt.BacklogError(`${file} doesn't exist (is dev checked out there?)`);
  return fmt.parse(readFileSync(file, "utf8"));
};

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Run `fn` under the lock; a lock older than 30 s is from a crashed writer and is taken over. */
function withLock(fn) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let age;
      try {
        age = Date.now() - statSync(lockDir).mtimeMs;
      } catch {
        continue; // released between the two calls
      }
      if (age > 30_000) rmSync(lockDir, { recursive: true, force: true });
      else if (Date.now() > deadline) throw new fmt.BacklogError(`backlog is locked (${lockDir}); try again`);
      else sleep(150);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/**
 * Read, change, write and commit backlog.md on dev in the main checkout.
 * `message` is the commit subject, or a function of `change`'s result.
 */
function write(message, change) {
  return withLock(() => {
    const branch = git(mainCheckout, "branch", "--show-current");
    if (branch !== TRUNK)
      throw new fmt.BacklogError(
        `the main checkout is on "${branch}", not ${TRUNK}; the backlog lives on ${TRUNK}`,
      );
    if (existsSync(join(mainCheckout, ".git", "MERGE_HEAD")))
      throw new fmt.BacklogError("the main checkout is in the middle of a merge; try again when it's done");
    const tracked = tryGit(mainCheckout, "ls-files", "--error-unmatch", REL) !== null;
    const handEdited = tracked && tryGit(mainCheckout, "diff", "--quiet", "HEAD", "--", REL) === null;
    const b = read();
    const result = change(b);
    writeFileSync(file, fmt.render(b));
    git(mainCheckout, "add", "--", REL);
    if (tryGit(mainCheckout, "diff", "--cached", "--quiet", "--", REL) !== null) return result; // nothing changed
    const subject = typeof message === "function" ? message(result) : message;
    const body = [`By: ${who()}`, ...(handEdited ? ["Includes uncommitted hand edits of backlog.md."] : [])];
    git(
      mainCheckout,
      "commit",
      "--quiet",
      "-m",
      `backlog: ${subject}`.slice(0, 72),
      "-m",
      body.join("\n"),
      "--",
      REL,
    );
    return result;
  });
}

// ---- deriving statuses from git -------------------------------------------

function containment(fetch) {
  if (fetch) tryGit(mainCheckout, "fetch", "--quiet", REMOTE, TRUNK, "staging", "main");
  const ref = (b) =>
    tryGit(mainCheckout, "rev-parse", "--verify", "--quiet", `refs/remotes/${REMOTE}/${b}`)
      ? `${REMOTE}/${b}`
      : b;
  const refs = { dev: TRUNK, staging: ref("staging"), main: ref("main") };
  const contains = (sha, r) => tryGit(mainCheckout, "merge-base", "--is-ancestor", sha, r) !== null;
  return (it) => {
    if (!it.commit) return it.status;
    if (!tryGit(mainCheckout, "rev-parse", "--verify", "--quiet", `${it.commit}^{commit}`)) return it.status;
    return fmt.derive(it, {
      dev: contains(it.commit, refs.dev),
      staging: contains(it.commit, refs.staging),
      main: contains(it.commit, refs.main),
    });
  };
}

// ---- commands -------------------------------------------------------------

function list(opts) {
  const b = read();
  const status = containment(false);
  const rows = b.items
    .map((i) => ({ ...i, status: status(i) }))
    .filter((i) => opts.all || !["live", "dropped"].includes(i.status))
    .filter((i) => !opts.prd || i.prd === opts.prd)
    .filter((i) => !opts.status || i.status === opts.status)
    .filter((i) => !opts.type || i.type === opts.type)
    .filter((i) => !opts.owner || i.owner === opts.owner);
  const w = (k, min) => Math.max(min, ...rows.map((r) => r[k].length));
  const ws = {
    id: w("id", 4),
    type: w("type", 4),
    status: w("status", 6),
    prd: w("prd", 3),
    owner: w("owner", 5),
  };
  const line = (r) =>
    [
      r.id.padEnd(ws.id),
      r.type.padEnd(ws.type),
      r.status.padEnd(ws.status),
      r.prd.padEnd(ws.prd),
      r.owner.padEnd(ws.owner),
      r.title,
    ].join("  ");
  console.log(line({ id: "ID", type: "TYPE", status: "STATUS", prd: "PRD", owner: "OWNER", title: "TITLE" }));
  for (const r of rows) console.log(line(r));
  if (!rows.length) console.log("(no items)");
}

function show(id) {
  const it = fmt.find(read(), id);
  const status = containment(false)(it);
  console.log(`${it.id} · ${it.type} · ${it.title}`);
  for (const f of fmt.FIELDS)
    console.log(
      `  ${f}: ${f === "status" && status !== it.status ? `${status} (file says ${it.status})` : it[f]}`,
    );
  if (it.notes) console.log(`\n${it.notes}`);
}

const ids = (pos) => {
  if (!pos.length) throw new fmt.BacklogError("which item? (B-n)");
  return pos;
};

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opts } = parseArgs(rest);
  const ctx = () => ({ by: who(), date: today() });
  switch (cmd) {
    case "list":
    case undefined:
      return list(opts);
    case "show":
      return show(ids(pos)[0]);
    case "path":
      return console.log(file);
    case "add": {
      const [type, ...words] = pos;
      if (!type) throw new fmt.BacklogError("usage: add <type> <title…>");
      const it = write(
        (item) => `add ${item.id} (${item.type}) ${item.title}`,
        (b) =>
          fmt.add(b, {
            type,
            title: words.join(" "),
            prd: opts.prd,
            status: opts.status,
            note: opts.note,
            ...ctx(),
          }),
      );
      return console.log(`added ${it.id}`);
    }
    case "set": {
      const [id, ...pairs] = pos;
      if (!pairs.length) throw new fmt.BacklogError("usage: set B-n key=value…");
      write(`${id.toUpperCase()}: set ${pairs.join(", ")}`, (b) => {
        const it = fmt.find(b, id);
        for (const p of pairs) {
          const eq = p.indexOf("=");
          if (eq < 1) throw new fmt.BacklogError(`"${p}" isn't key=value`);
          fmt.setField(it, p.slice(0, eq), p.slice(eq + 1));
        }
      });
      return console.log(`updated ${id}`);
    }
    case "note": {
      const [id, ...words] = pos;
      write(`${id?.toUpperCase()}: note`, (b) =>
        fmt.addNote(fmt.find(b, ids([id])[0]), { text: words.join(" "), ...ctx() }),
      );
      return console.log(`noted ${id}`);
    }
    case "claim": {
      const owner = opts.as ?? myBranch();
      if (!owner || owner === TRUNK)
        throw new fmt.BacklogError("claim from your prd/ or plan/ branch, or pass --as OWNER");
      for (const id of ids(pos)) {
        write(`${id.toUpperCase()}: claimed by ${owner}`, (b) =>
          fmt.claim(fmt.find(b, id), owner, !!opts.force),
        );
        console.log(`${id} claimed by ${owner}`);
      }
      return;
    }
    case "release":
      for (const id of ids(pos)) write(`${id.toUpperCase()}: released`, (b) => fmt.release(fmt.find(b, id)));
      return;
    case "done": {
      const sha = git(here, "rev-parse", "--short", `${opts.commit ?? "HEAD"}^{commit}`);
      for (const id of ids(pos))
        write(`${id.toUpperCase()}: ready at ${sha}`, (b) => {
          const it = fmt.find(b, id);
          it.commit = sha;
          it.status = "ready";
        });
      return console.log(`${pos.join(", ")} ready at ${sha}`);
    }
    case "refresh": {
      const status = containment(!opts["no-fetch"]);
      const changed = write("refresh derived statuses", (b) => {
        const moved = [];
        for (const it of b.items) {
          const s = status(it);
          if (s === it.status) continue;
          moved.push(`${it.id} ${it.status} → ${s}`);
          it.status = s;
        }
        return moved;
      });
      return console.log(changed.length ? changed.join("\n") : "no status changes");
    }
    case "commit":
      write(pos.join(" ") || "hand edits", () => undefined);
      return console.log("committed");
    default:
      throw new fmt.BacklogError(`unknown command "${cmd}" (see the top of scripts/backlog/backlog.mjs)`);
  }
}

try {
  main();
} catch (e) {
  if (e instanceof fmt.BacklogError) {
    console.error(`backlog: ${e.message}`);
    process.exit(1);
  }
  if (e && typeof e === "object" && "stderr" in e && e.stderr) console.error(String(e.stderr));
  throw e;
}
