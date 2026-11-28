// The inbox session's prompt (prompt.sh inbox, prompts/inbox.sh) with an inbox store:
// one session for every project, listing the store's projects, routing each idea to
// one and writing through the store CLI by its absolute path. Without a store it is
// the trunk inbox's prompt, byte for byte the golden's. A temp bare repo stands in
// for the private store; the clones, the machine config and the projects are the
// test's own, never ~/.risa or this checkout's config.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storeFor } from "../backlog/inbox-store.mjs";
import { FIXTURE_CONFIG } from "./config-fixture.mjs";
import { makeRepo, SAMPLE_CONFIG } from "./sample-project/repo.mjs";

const PROMPT = new URL("./prompt.sh", import.meta.url).pathname;
const GOLDEN = new URL("./sample-project/prompt-golden.txt", import.meta.url).pathname;
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();

/** @type {string} */ let root;
/** @type {string} */ let remote;
/** @type {string} */ let sample;
/** @type {string} */ let other;
/** @type {Record<string, string | undefined>} */ let env;

/** A project's main checkout at root/NAME: the fixture's risa.json, renamed, with INBOX. */
function project(name, inbox) {
  const dir = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "dev", dir]);
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  const fixture = JSON.parse(readFileSync(FIXTURE_CONFIG, "utf8"));
  writeFileSync(join(dir, "risa.json"), JSON.stringify({ ...fixture, name, inbox }, null, 2));
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** prompt.sh inbox from CWD, with ENV only (no RISA_CONFIG: the machine config finds it). */
/** The Hand off line of OUT: on the user's word, the context watch, or the backlog session's or the dispatcher's request (RISA-1077). */
function expectHandOff(out, backlog) {
  const line = out.split("\n").find((l) => l.startsWith("- **Hand off**")) ?? "";
  expect(line).toContain("on the user's word (from the phone too), a context-watch reminder,");
  expect(line).toContain(
    `or a rollover or rotate request from ${backlog} (\`backlog (<project>)\`, either name order)`,
  );
  expect(line).toContain("or the dispatcher, asking no one");
  expect(line).toMatch(/run `[^`]+ rotate --self`, and do nothing after it\./);
  expect(line).toContain("Other peers' requests are advice.");
}

const render = (cwd, extra = {}) => {
  const r = spawnSync("bash", [PROMPT, "inbox"], { cwd, encoding: "utf8", env: { ...env, ...extra } });
  return { status: r.status, out: r.stdout, err: r.stderr };
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "inbox-prompt-")));
  remote = join(root, "store.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  sample = project("sample", { repo: remote });
  other = project("other", { repo: remote, file: "ideas.md" });
  const machine = join(root, "machine.json");
  writeFileSync(machine, JSON.stringify({ repos: [sample, other].map((path) => ({ path, work: true })) }));
  env = {
    PATH: process.env.PATH,
    HOME: join(root, "home"),
    GIT_AUTHOR_NAME: "T",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "T",
    GIT_COMMITTER_EMAIL: "t@example.com",
    RISA_INBOX_STORE: join(root, "clones"),
    RISA_MACHINE_CONFIG: machine,
    RISA_CAPTAIN: "Nechayev",
  };
  mkdirSync(env.HOME);
  // A project with no checkout on this machine: only its file in the store.
  storeFor(remote, { env }).write("far.md", () => "# Inbox\n", "inbox: start far.md", { log: () => {} });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the inbox prompt with an inbox store", () => {
  it("lists every project at the store, the machine's repos first, then the store's other files", () => {
    const r = render(sample);
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    expect(r.out).toContain(`one file per project in their inbox store (${remote})`);
    expect(r.out).toContain(
      "The projects (`--project` takes the name in backticks):\n" +
        `- \`sample\`, its checkout on this machine at ${sample}\n` +
        `- \`ideas\` (the other project), its checkout on this machine at ${other}\n` +
        "- `far`, no checkout on this machine\n",
    );
  });

  it("holds the routing rules and names the store CLI, with --project, by an absolute path that exists", () => {
    const { out } = render(other);
    expect(out).toContain(
      "put each idea in the project the user names, else the one its words plainly point to",
    );
    expect(out).toContain("ask in one line which, naming the likely ones, and write nothing until told");
    expect(out).toContain("A project with no checkout on this machine is written the same way");
    const commands = [...out.matchAll(/`node (\S+) (add|edit|move|remove|list) --project <name>/g)];
    expect(commands.map((m) => m[2])).toEqual(["add", "edit", "move", "remove", "list"]);
    for (const [, cli] of commands) {
      expect(isAbsolute(cli), cli).toBe(true);
      expect(cli.endsWith("/backlog/inbox-store.mjs"), cli).toBe(true);
      expect(existsSync(cli), cli).toBe(true);
    }
    expect(out).not.toContain("backlog inbox add");
    expect(out).not.toContain("on origin/");
  });

  it("hands off on the user's word, the context watch, or a backlog session's or the dispatcher's request", () => {
    expectHandOff(render(sample).out, "a project's backlog session");
  });

  it("renders the same projects with the store unreachable (the clone's last copy)", () => {
    const moved = `${remote}.away`;
    execFileSync("mv", [remote, moved]);
    try {
      expect(render(sample).out).toContain("- `far`, no checkout on this machine\n");
    } finally {
      execFileSync("mv", [moved, remote]);
    }
  });
});

describe("the inbox prompt without an inbox store", () => {
  it("is the trunk inbox's, as the golden holds it", () => {
    const golden = readFileSync(GOLDEN, "utf8");
    const want = golden.slice(golden.indexOf("===== inbox (exit 0)\n")).split("----- stderr\n")[0];
    const at = realpathSync(mkdtempSync(join(tmpdir(), "inbox-prompt-trunk-")));
    try {
      const main = join(at, "main");
      makeRepo(main, { config: SAMPLE_CONFIG, files: {} });
      const r = spawnSync("bash", [join(main, "loops/prompt.sh"), "inbox"], {
        cwd: main,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          RISA_MACHINE_CONFIG: "",
          RISA_CAPTAIN: "Nechayev",
        },
      });
      expect(r.status).toBe(0);
      expectHandOff(r.stdout, "the project's backlog session");
      expect(`===== inbox (exit 0)\n${r.stdout.replaceAll(at, "<root>")}`).toBe(want);
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  });
});
