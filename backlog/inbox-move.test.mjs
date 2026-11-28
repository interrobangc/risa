// Moving a project's inbox: `backlog inbox to-repo <git url>`. A stub gh answers the
// repo's visibility; temp bare repos stand in for the private store and the project's
// origin; the clones and the project are the test's own, never ~/.risa or this
// checkout's config.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_CONFIG } from "../loops/config-fixture.mjs";
import { ghTarget, withInbox } from "./inbox-move.mjs";

const BACKLOG = new URL("./backlog.mjs", import.meta.url).pathname;
const INBOX_REL = "plans/inbox.md";
const IDENTITY = {
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const INBOX =
  "# Inbox\n\n## Bugs\n\n- The export button does nothing\n  seen on the reports page\n- Timeline jumps on scroll (B-1)\n\n## Features\n\n- Dark mode for the dashboard\n";
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();

/** @type {string} */ let root;
/** @type {string} */ let store;
/** @type {string} */ let dir;
/** @type {string} */ let origin;
/** @type {Record<string, string | undefined>} */ let env;

/** `backlog …` in the project, gh answering VISIBILITY (missing: gh finds no repo). */
const backlog = (visibility, ...args) => {
  const r = spawnSync("node", [BACKLOG, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...env, RISA_CONFIG: join(dir, "risa.json"), STUB_GH_VISIBILITY: visibility },
  });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
const storeCommits = () => Number(git(store, "rev-list", "--count", "--all") || "0");
const originTip = () => git(origin, "rev-parse", "dev");

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "inbox-move-")));
  store = join(root, "store.git");
  execFileSync("git", ["init", "-q", "--bare", store]);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      '[ "$1 $2" = "repo view" ] || exit 2',
      'printf "%s\\n" "$*" >> "$STUB_GH_LOG"',
      'if [ "$STUB_GH_VISIBILITY" = missing ]; then echo "GraphQL: Could not resolve to a Repository" >&2; exit 1; fi',
      'printf \'{"visibility":"%s"}\\n\' "$STUB_GH_VISIBILITY"',
    ].join("\n"),
  );
  chmodSync(join(bin, "gh"), 0o755);
  env = {
    ...process.env,
    ...IDENTITY,
    PATH: `${bin}:${process.env.PATH}`,
    STUB_GH_LOG: join(root, "gh.log"),
    BACKLOG_BY: "",
    BACKLOG_PICKUP: "off",
    RISA_INBOX_STORE: join(root, "clones"),
    RISA_MACHINE_CONFIG: join(root, "machine.json"),
  };
  dir = join(root, "sample");
  origin = join(root, "sample-origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "dev", origin]);
  execFileSync("git", ["init", "-q", "-b", "dev", dir]);
  for (const [k, v] of [
    ["user.email", "t@example.com"],
    ["user.name", "T"],
    ["core.hooksPath", "/dev/null"],
    ["commit.gpgsign", "false"],
  ])
    git(dir, "config", k, v);
  git(dir, "remote", "add", "origin", origin);
  const fixture = JSON.parse(readFileSync(FIXTURE_CONFIG, "utf8"));
  writeFileSync(join(dir, "risa.json"), `${JSON.stringify({ ...fixture, name: "sample" }, null, 2)}\n`);
  mkdirSync(join(dir, "plans"));
  writeFileSync(
    join(dir, "plans/backlog.md"),
    "# Backlog\n\n## Items\n\n### B-1 · bug · Timeline jumps on scroll\n\n- status: inbox\n- prd:\n- owner:\n- commit:\n",
  );
  writeFileSync(join(dir, INBOX_REL), INBOX);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "push", "-q", "origin", "dev");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("backlog inbox to-repo", () => {
  it("refuses a public repo and a missing one, writing nothing", () => {
    const tip = originTip();
    const pub = backlog("PUBLIC", "inbox", "to-repo", store);
    expect(pub.status).toBe(1);
    expect(pub.err).toBe(
      `backlog: ${store} is public: an inbox store must be a private repo; nothing was written`,
    );
    const missing = backlog("missing", "inbox", "to-repo", store);
    expect(missing.status).toBe(1);
    expect(missing.err).toBe(`backlog: gh can't find ${store} (or isn't signed in); nothing was written`);
    expect(storeCommits()).toBe(0);
    expect(originTip()).toBe(tip);
    expect(readFileSync(join(dir, INBOX_REL), "utf8")).toBe(INBOX);
    expect(readFileSync(join(root, "gh.log"), "utf8")).toBe(
      `repo view ${store} --json visibility\n`.repeat(2),
    );
  });

  it("moves a private repo's unfiled lines (tagged ones dropped), merged with the store's, in one trunk commit", () => {
    // The store already holds a line for this project, and one of the trunk's.
    const seed = join(root, "seed");
    execFileSync("git", ["clone", "-q", store, seed], { stdio: "pipe" });
    writeFileSync(
      join(seed, "sample.md"),
      "# Inbox\n\n## Features\n\n- Dark mode for the dashboard\n\n## Questions\n\n- Should reports export to CSV?\n",
    );
    git(seed, "add", ".");
    git(seed, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "seed");
    git(seed, "push", "-q", "origin", "HEAD:main");
    const before = originTip();

    const r = backlog("PRIVATE", "inbox", "to-repo", store);
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    const [storeLine, trunkLine] = r.out.split("\n");
    expect(storeLine).toBe(
      `moved 1 inbox line to ${store} sample.md as ${git(store, "rev-parse", "main").slice(0, 7)}`,
    );
    expect(trunkLine).toBe(
      `risa.json has the inbox group and ${INBOX_REL} is gone, on origin/dev as ${originTip().slice(0, 7)}`,
    );
    expect(git(store, "show", "main:sample.md")).toBe(
      "# Inbox\n\n## Features\n\n- Dark mode for the dashboard\n\n## Questions\n\n- Should reports export to CSV?\n\n## Bugs\n\n- The export button does nothing\n  seen on the reports page",
    );
    // One trunk commit on origin's old tip, changing exactly the config and the inbox file.
    expect(git(origin, "rev-parse", "dev^")).toBe(before);
    expect(git(origin, "diff-tree", "--no-commit-id", "--name-status", "-r", "dev").split("\n")).toEqual([
      `D\t${INBOX_REL}`,
      "M\trisa.json",
    ]);
    const config = JSON.parse(git(origin, "show", "dev:risa.json"));
    expect(config.inbox).toEqual({ repo: store });
    expect(config.paths.inbox).toBe(INBOX_REL);
    expect(git(origin, "log", "-1", "--format=%s", "dev")).toMatch(/inbox: move the inbox to its store$/);
    expect(git(origin, "log", "-1", "--format=%b", "dev")).toContain(`Store: ${store}`);
    // The working tree is the pickup's: untouched here.
    expect(git(dir, "status", "--porcelain")).toBe("");

    // A second run refuses: on origin's config before the pickup, on its own config after.
    const tip = originTip();
    const storeTip = git(store, "rev-parse", "main");
    let again = backlog("PRIVATE", "inbox", "to-repo", store);
    expect(again.status).toBe(1);
    expect(again.err).toBe(
      "backlog: origin/dev's risa.json already has an inbox group: its inbox is in a store",
    );
    git(dir, "pull", "-q", "--ff-only", "origin", "dev");
    again = backlog("PRIVATE", "inbox", "to-repo", store);
    expect(again.status).toBe(1);
    expect(again.err).toBe("backlog: risa.json already has an inbox group: its inbox is in a store");
    expect(originTip()).toBe(tip);
    expect(git(store, "rev-parse", "main")).toBe(storeTip);
    // The moved project's inbox commands now go to the store.
    expect(backlog("PRIVATE", "inbox").out).toBe(
      "feature   Dark mode for the dashboard\nquestion  Should reports export to CSV?\nbug       The export button does nothing\n3 not filed yet (pnpm backlog ingest)",
    );
  });

  it("drops a line tagged locally but not on origin, and keeps an unfiled one sharing its title", () => {
    const two = "\n## Bugs\n\n- Export fails\n  on CSV downloads\n- Export fails\n  on PDF downloads\n";
    writeFileSync(join(dir, INBOX_REL), `# Inbox\n${two}`);
    git(dir, "commit", "-q", "-am", "two exports");
    git(dir, "push", "-q", "origin", "dev");
    // Filed here, the tag not on origin yet: a commit of the user's own, never pushed.
    writeFileSync(
      join(dir, INBOX_REL),
      `# Inbox\n${two.replace("- Export fails\n  on CSV", "- Export fails (B-2)\n  on CSV")}`,
    );
    git(dir, "commit", "-q", "-am", "file the CSV one");

    const r = backlog("PRIVATE", "inbox", "to-repo", store);
    expect(r.status).toBe(0);
    expect(r.out.split("\n")[0]).toMatch(/^moved 1 inbox line to /);
    expect(git(store, "show", "main:sample.md")).toBe(
      "# Inbox\n\n## Bugs\n\n- Export fails\n  on PDF downloads",
    );
    expect(git(origin, "diff-tree", "--no-commit-id", "--name-status", "-r", "dev").split("\n")).toEqual([
      `D\t${INBOX_REL}`,
      "M\trisa.json",
    ]);
  });

  it("takes back a moved line an ingest filed on the trunk between the store write and the push", () => {
    // The ingest's commit, ready on origin: it files the export line as B-2 (tagged).
    const other = join(root, "other");
    execFileSync("git", ["clone", "-q", origin, other], { stdio: "pipe" });
    writeFileSync(join(other, INBOX_REL), INBOX.replace("does nothing\n", "does nothing (B-2)\n"));
    writeFileSync(
      join(other, "plans/backlog.md"),
      `${readFileSync(join(other, "plans/backlog.md"), "utf8")}\n### B-2 · bug · The export button does nothing\n\n- status: inbox\n- prd:\n- owner:\n- commit:\n`,
    );
    git(other, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-am", "ingest");
    git(other, "push", "-q", "origin", "HEAD:refs/heads/ingest");
    // The store's first push lands it on origin's dev: the move's trunk push is refused.
    const mark = join(root, "raced");
    writeFileSync(
      join(store, "hooks", "post-receive"),
      [
        "#!/bin/sh",
        `[ -e '${mark}' ] && exit 0`,
        `touch '${mark}'`,
        `git --git-dir='${origin}' update-ref refs/heads/dev refs/heads/ingest`,
      ].join("\n"),
    );
    chmodSync(join(store, "hooks", "post-receive"), 0o755);
    const ingested = git(origin, "rev-parse", "ingest");

    const r = backlog("PRIVATE", "inbox", "to-repo", store);
    expect(r.status).toBe(0);
    expect(r.err).toBe("origin/dev moved; building the move on its new tip");
    const lines = r.out.split("\n");
    expect(lines[0]).toBe(
      `moved 1 inbox line to ${store} sample.md as ${git(store, "rev-parse", "main").slice(0, 7)}`,
    );
    expect(lines[1]).toBe(`took back from ${store} sample.md the 1 line origin/dev filed during the move`);
    expect(git(origin, "rev-parse", "dev^")).toBe(ingested);
    // The filed line is out of the store (its heading stays, as a settled line's does);
    // the unfiled one stays.
    expect(git(store, "show", "main:sample.md")).toBe(
      "# Inbox\n\n## Bugs\n\n## Features\n\n- Dark mode for the dashboard",
    );

    // A store ingest files only the line nobody filed, and nothing twice.
    git(dir, "pull", "-q", "--ff-only", "origin", "dev");
    const ingest = backlog("PRIVATE", "ingest");
    expect(ingest.status).toBe(0);
    const tracker = readFileSync(join(dir, "plans/backlog.md"), "utf8");
    expect(tracker.match(/· The export button does nothing$/gm)).toHaveLength(1);
    expect(tracker.match(/· Dark mode for the dashboard$/gm)).toHaveLength(1);
    expect(backlog("PRIVATE", "ingest").out).toBe("nothing new in the inbox");

    // A second move after the success changes nothing.
    const tip = originTip();
    const storeTip = git(store, "rev-parse", "main");
    const again = backlog("PRIVATE", "inbox", "to-repo", store);
    expect(again.status).toBe(1);
    expect(originTip()).toBe(tip);
    expect(git(store, "rev-parse", "main")).toBe(storeTip);
  });

  it("refuses with uncommitted changes to the inbox, writing nothing", () => {
    writeFileSync(join(dir, INBOX_REL), `${INBOX}- A line not committed\n`);
    const r = backlog("PRIVATE", "inbox", "to-repo", store);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/has uncommitted changes in .*nothing was written$/);
    expect(storeCommits()).toBe(0);
  });
});

describe("the move's parts", () => {
  it("asks gh about an SSH URL by its https form", () => {
    expect(ghTarget("git@github.com:acme/ideas.git")).toBe("https://github.com/acme/ideas");
    expect(ghTarget("ssh://git@github.com/acme/ideas.git")).toBe("https://github.com/acme/ideas");
    expect(ghTarget("https://github.com/acme/ideas.git")).toBe("https://github.com/acme/ideas");
  });

  it("adds the inbox group as the config's last key, the rest as written", () => {
    expect(withInbox('{\n  "name": "sample"\n}\n', "git@x:a/b.git")).toBe(
      '{\n  "name": "sample",\n  "inbox": { "repo": "git@x:a/b.git" }\n}\n',
    );
  });
});
