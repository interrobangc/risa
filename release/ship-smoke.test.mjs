// Risa's smoke and notify hooks (release/ship.mjs). The tags come from a throwaway
// clone of this checkout's HEAD, tagged there, so an install's bin/risa is this
// checkout's code at that commit; the shipping repo the hooks run in is a sample
// project (makeRepo) holding those tags, so smoke's backlog list reads the sample's
// backlog, never this checkout's. HOME, the machine config and every asks folder are
// temp paths, and osascript is a stub; nothing here pushes, tags this repo or writes
// the real ~/.risa.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SAMPLE_CONFIG, makeRepo, sampleData } from "../loops/sample-project/repo.mjs";
import { NOTIFY_TOPIC, installDir } from "./ship.mjs";

const SCRIPT = fileURLToPath(new URL("./ship.mjs", import.meta.url));
const HERE = fileURLToPath(new URL("..", import.meta.url));
const VERSION = "9.9.9";
const BROKEN = "9.9.8";
const BACKLOG = "# Backlog\n\n## Topics\n\n## Items\n\n### SAM-1 · bug · A sample item\n\n- status: ready\n";

let root = "",
  clone = "",
  repo = "",
  home = "";
const gitIn = (/** @type {string} */ dir, /** @type {string[]} */ ...a) =>
  execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: "pipe" }).trim();
const git = (/** @type {string[]} */ ...a) => gitIn(repo, ...a);

/** The environment with none of the running test's RISA_* variables. */
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("RISA_")));

/** A sample project at DIR whose config pins PIN (null: no pin), named NAME. */
const sample = (/** @type {string} */ dir, /** @type {string} */ name, /** @type {string | null} */ pin) => {
  const config = JSON.parse(readFileSync(SAMPLE_CONFIG, "utf8"));
  config.name = name;
  if (pin) config.risaVersion = pin;
  makeRepo(dir, {
    files: {
      ...sampleData(),
      "work/backlog.md": BACKLOG,
      "risa.json": `${JSON.stringify(config, null, 2)}\n`,
    },
  });
  return dir;
};

const machine = (/** @type {string[]} */ ...paths) =>
  writeFileSync(join(root, "machine.json"), JSON.stringify({ repos: paths.map((path) => ({ path })) }));

const hook = (/** @type {string} */ verb, /** @type {string} */ version, extra = {}) => {
  const r = spawnSync(process.execPath, [SCRIPT, verb, version], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...clean(),
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      HOME: home,
      RISA_MACHINE_CONFIG: join(root, "machine.json"),
      // As a ship's hook inherits them: the shipping repo's config, found.
      RISA_CONFIG: join(repo, "risa.json"),
      RISA_CONFIG_FOUND: join(repo, "risa.json"),
      ...extra,
    },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
};
const smoke = (/** @type {string} */ version) => hook("smoke", version);

/** The open asks in DIR's repo, read through the install's `risa asks --json`. */
const asksIn = (/** @type {string} */ dir) =>
  JSON.parse(
    execFileSync(join(installDir(VERSION, home), "bin", "risa"), ["asks", "--json"], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...clean(),
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        HOME: home,
        RISA_MACHINE_CONFIG: join(root, "machine.json"),
      },
    }),
  );

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "release-smoke-")));
  clone = join(root, "clone");
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "osascript"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(root, "bin", "osascript"), 0o755);
  const c = (/** @type {string[]} */ ...a) => gitIn(clone, ...a);
  const head = gitIn(HERE, "rev-parse", "HEAD");
  execFileSync("git", ["clone", "-q", "--no-checkout", HERE, clone]);
  // The clone's origin is this checkout: drop it, so nothing can reach it.
  c("remote", "remove", "origin");
  c("checkout", "-q", "-B", "main", head);
  c("config", "user.email", "t@example.com");
  c("config", "user.name", "T");
  c("config", "core.hooksPath", "/dev/null");
  c("tag", "-a", `v${VERSION}`, "-m", `v${VERSION}`);
  // A release whose bin/risa can't start, on a side branch.
  c("checkout", "-q", "-b", "broken");
  writeFileSync(join(clone, "bin", "risa"), "#!/usr/bin/env bash\necho 'risa: broken' >&2\nexit 3\n");
  c("commit", "-qam", "chore: a broken risa");
  c("tag", "-a", `v${BROKEN}`, "-m", `v${BROKEN}`);
  // The shipping repo: a sample project with no pin, holding the clone's tags.
  repo = sample(join(root, "ship"), "sample-ship", null);
  git("fetch", "-q", clone, "refs/tags/*:refs/tags/*");
  sample(join(root, "old"), "sample-old", "0.1.0");
  sample(join(root, "current"), "sample-current", VERSION);
}, 60_000);
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  home = join(root, `home-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home);
  machine(repo, join(root, "old"));
});

describe("smoke", () => {
  it("installs the tag, tries it, and reuses the install when run again", () => {
    const dir = installDir(VERSION, home);
    const r = smoke(VERSION);
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    expect(r.out).toBe(`install=${dir}\nlink=ln -sf ${dir}/bin/risa ~/.local/bin/risa\n`);
    expect(execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(
      git("rev-parse", `v${VERSION}^{commit}`),
    );
    expect(existsSync(join(home, ".local"))).toBe(false);

    const again = smoke(VERSION);
    expect(again.status).toBe(0);
    expect(again.out).toBe(`${dir} is already at v${VERSION}: reusing it\n${r.out}`);
    expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(2);
  }, 60_000);

  it("refuses an install at another commit", () => {
    const dir = installDir(VERSION, home);
    git("worktree", "add", "-q", "--detach", dir, `v${VERSION}~1`);
    const r = smoke(VERSION);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(new RegExp(`${dir} is at \\w+, not v${VERSION} \\(\\w+\\): move it aside`));
    expect(r.out).not.toMatch(/install=/);
    git("worktree", "remove", "--force", dir);
  }, 60_000);

  it("names the step when the install's bin/risa --root fails", () => {
    const r = smoke(BROKEN);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(`v${BROKEN}'s bin/risa --root failed (exit 3): risa: broken`);
    expect(r.out).not.toMatch(/install=/);
    git("worktree", "remove", "--force", installDir(BROKEN, home));
  }, 60_000);
});

describe("notify", () => {
  it("files one report in each project pinned below the version, none in the shipping repo's asks", () => {
    expect(smoke(VERSION).status).toBe(0);
    machine(repo, join(root, "old"), join(root, "current"));
    const shipAsks = join(root, "ship-asks");
    const config = join(repo, "risa.json");
    const r = hook("notify", VERSION, {
      RISA_ASKS_DIR: shipAsks,
      RISA_SHIPS_DIR: join(root, "ships"),
      RISA_CONFIG: config,
      RISA_CONFIG_FOUND: config,
    });
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    expect(r.out).toBe("notified=sample-old (0.1.0)\nelsewhere=cross-machine-messages (RISA-1055)\n");
    const old = asksIn(join(root, "old"));
    expect(old).toHaveLength(1);
    expect(old[0]).toMatchObject({ kind: "report", topic: NOTIFY_TOPIC });
    expect(old[0].text).toMatch(`Risa v${VERSION} is out; this project pins 0.1.0`);
    expect(asksIn(join(root, "current"))).toEqual([]);
    expect(existsSync(shipAsks) ? readdirSync(shipAsks) : []).toEqual([]);
    expect(existsSync(join(repo, ".loops", ".asks"))).toBe(false);
    git("worktree", "remove", "--force", installDir(VERSION, home));
  }, 60_000);

  it("prints only elsewhere= with no other repo", () => {
    expect(smoke(VERSION).status).toBe(0);
    machine(repo);
    const r = hook("notify", VERSION);
    expect(r.status).toBe(0);
    expect(r.out).toBe("elsewhere=cross-machine-messages (RISA-1055)\n");
    git("worktree", "remove", "--force", installDir(VERSION, home));
  }, 60_000);

  it("refuses without an install", () => {
    const r = hook("notify", VERSION);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/no install at .*the smoke phase makes it/);
  });
});
