// Ingest from an inbox store: `backlog ingest` for a project with an `inbox` group files
// the store file's lines, pushes trunk's backlog-only commits, and only then removes the
// lines whose items are on origin's trunk. Temp bare repos stand in for the private
// store and the project's origin; the clones, the machine config and the project are
// the test's own, never ~/.risa or this checkout's config.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
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
import { newInboxEntries } from "./format.mjs";
import { storeFor } from "./inbox-store.mjs";

const BACKLOG = new URL("./backlog.mjs", import.meta.url).pathname;
const BACKLOG_REL = "plans/backlog.md";
const IDENTITY = {
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const BASE_BACKLOG =
  "# Backlog\n\n## Items\n\n### B-1 · bug · Sign-in can be submitted twice\n\n- status: triaged\n- prd:\n- owner:\n- commit:\n";
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();

/** @type {string} */ let root;
/** @type {string} */ let storeRemote;
/** @type {Record<string, string | undefined>} */ let env;

/** A project's main checkout at root/NAME on dev, pushed to its own bare origin. */
function project(name, extra = {}, files = {}) {
  const dir = join(root, name);
  const origin = join(root, `${name}-origin.git`);
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
  writeFileSync(join(dir, "risa.json"), JSON.stringify({ ...fixture, name, ...extra }, null, 2));
  mkdirSync(join(dir, "plans"));
  writeFileSync(join(dir, BACKLOG_REL), BASE_BACKLOG);
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(dir, rel), text);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "push", "-q", "origin", "dev");
  return { dir, origin };
}

/** `backlog …` in a project. */
const backlog = (dir, ...args) => {
  const r = spawnSync("node", [BACKLOG, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...env, RISA_CONFIG: join(dir, "risa.json") },
  });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
/** The store as another machine sees it (its own clone). */
const elsewhere = () => storeFor(storeRemote, { env: { RISA_INBOX_STORE: join(root, "clones-other") } });
const storeLines = () => newInboxEntries(elsewhere().read("sample.md") ?? "").map((e) => e.text);
const ids = (text) => [...text.matchAll(/^### (B-\d+) /gm)].map((m) => m[1]);
/** A pre-receive hook on the store that refuses every push (on: true), or none. */
const refuseStorePushes = (on) => {
  const hook = join(storeRemote, "hooks", "pre-receive");
  if (!on) return rmSync(hook, { force: true });
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  git(storeRemote, "config", "core.hooksPath", join(storeRemote, "hooks"));
};

/** @type {{ dir: string, origin: string }} */ let sample;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "inbox-ingest-")));
  storeRemote = join(root, "store.git");
  execFileSync("git", ["init", "-q", "--bare", storeRemote]);
  env = {
    ...process.env,
    ...IDENTITY,
    BACKLOG_BY: "",
    BACKLOG_PICKUP: "off",
    RISA_INBOX_STORE: join(root, "clones"),
    RISA_MACHINE_CONFIG: join(root, "machine.json"),
  };
  Object.assign(process.env, IDENTITY);
  sample = project("sample", { inbox: { repo: storeRemote } });
  const s = elsewhere();
  s.write(
    "sample.md",
    () =>
      "# Inbox\n\n## Bugs\n\n- The export button does nothing\n  seen on the reports page\n\n## Features\n\n- Dark mode for the dashboard\n",
    "seed",
    { log: () => {} },
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ingest from the inbox store", () => {
  it("files two lines, pushes them to origin, and then empties the store", () => {
    const r = backlog(sample.dir, "ingest");
    expect(r.status).toBe(0);
    const lines = r.out.split("\n");
    expect(lines.slice(0, 3)).toEqual([
      "B-2  bug       The export button does nothing",
      "B-3  feature   Dark mode for the dashboard",
      "filed 2",
    ]);
    expect(lines[3]).toMatch(
      new RegExp(`^removed 2 filed lines from ${storeRemote} sample\\.md as [0-9a-f]{7}$`),
    );
    expect(storeLines()).toEqual([]);
    const onOrigin = git(sample.origin, "show", `dev:${BACKLOG_REL}`);
    expect(ids(onOrigin)).toEqual(["B-1", "B-2", "B-3"]);
    expect(onOrigin).toMatch(/From the inbox: seen on the reports page \(inbox key [0-9a-f]{12}\)/);
    expect(onOrigin).toMatch(/From the inbox \(inbox key [0-9a-f]{12}\)/);
    expect(git(sample.dir, "rev-parse", "dev")).toBe(git(sample.origin, "rev-parse", "dev"));
    expect(existsSync(join(sample.dir, "plans/inbox.md"))).toBe(false);
    expect(git(sample.dir, "status", "--porcelain")).toBe("");
    expect(backlog(sample.dir, "doctor")).toMatchObject({ status: 0, out: "backlog ok" });
    expect(backlog(sample.dir, "ingest").out).toBe("nothing new in the inbox");
  });

  it("files nothing twice when the store write failed after the backlog commit, and empties it on the rerun", () => {
    refuseStorePushes(true);
    const crashed = backlog(sample.dir, "ingest");
    expect(crashed.status).toBe(0);
    expect(crashed.out).toContain("filed 2");
    expect(crashed.out).toMatch(
      /refused 5 pushes.*the filed lines stay in the inbox store for the next ingest/,
    );
    expect(storeLines()).toEqual(["The export button does nothing", "Dark mode for the dashboard"]);
    const doctor = backlog(sample.dir, "doctor");
    expect(doctor.status).toBe(1);
    expect(doctor.out).toContain("B-2  is filed, but its line");

    refuseStorePushes(false);
    const rerun = backlog(sample.dir, "ingest");
    expect(rerun.status).toBe(0);
    expect(rerun.out).toMatch(/^nothing new in the inbox\nremoved 2 filed lines from /);
    expect(storeLines()).toEqual([]);
    expect(ids(readFileSync(join(sample.dir, BACKLOG_REL), "utf8"))).toEqual(["B-1", "B-2", "B-3"]);
    expect(ids(git(sample.origin, "show", `dev:${BACKLOG_REL}`))).toEqual(["B-1", "B-2", "B-3"]);
  });

  it("leaves the lines when a commit of the user's own keeps the backlog off origin, and the doctor names them", () => {
    writeFileSync(join(sample.dir, "README.md"), "# Sample\n");
    git(sample.dir, "add", "README.md");
    git(sample.dir, "commit", "-q", "-m", "docs: a readme");
    const r = backlog(sample.dir, "ingest");
    expect(r.status).toBe(0);
    expect(r.out.split("\n")).toEqual([
      "B-2  bug       The export button does nothing",
      "B-3  feature   Dark mode for the dashboard",
      "filed 2",
    ]);
    expect(r.err).toContain("dev has a commit of your own that isn't pushed: it stays yours to push");
    expect(storeLines()).toEqual(["The export button does nothing", "Dark mode for the dashboard"]);
    expect(ids(git(sample.origin, "show", `dev:${BACKLOG_REL}`))).toEqual(["B-1"]);

    const doctor = backlog(sample.dir, "doctor");
    expect(doctor.status).toBe(1);
    expect(doctor.out).toMatch(
      /^B-2 {2}is filed, but its line \("The export button does nothing"\) is still in the inbox store .* \(--fix\)$/m,
    );
    expect(doctor.out).toMatch(/^B-3 {2}is filed, but its line \("Dark mode for the dashboard"\)/m);

    // The user pushes their commit: the doctor's fix (the next ingest's step) removes them.
    git(sample.dir, "push", "-q", "origin", "dev");
    const fixed = backlog(sample.dir, "doctor", "--fix");
    expect(fixed.out).toMatch(/removed 2 filed lines from /);
    expect(fixed.out).toContain("backlog ok");
    expect(storeLines()).toEqual([]);
  });

  it("leaves a project without a store as before: its trunk inbox tagged, no store touched", () => {
    const trunk = project(
      "plain",
      {},
      { "plans/inbox.md": "# Inbox\n\n## Bugs\n\n- Timeline jumps on scroll\n" },
    );
    const r = backlog(trunk.dir, "ingest");
    expect(r).toMatchObject({ status: 0, out: "B-2  bug       Timeline jumps on scroll\nfiled 1" });
    expect(readFileSync(join(trunk.dir, "plans/inbox.md"), "utf8")).toBe(
      "# Inbox\n\n## Bugs\n\n- Timeline jumps on scroll (B-2)\n",
    );
    expect(readFileSync(join(trunk.dir, BACKLOG_REL), "utf8")).not.toContain("inbox key");
    expect(git(trunk.dir, "rev-list", "--count", "origin/dev..dev")).toBe("1");
    expect(existsSync(join(root, "clones"))).toBe(false);
  });
});
