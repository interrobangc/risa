// Home machines (home.mjs): the claims in the inbox store's homes.json, `risa home`,
// the dispatcher's home gate, and prd.sh inbox's hop to the inbox keeper. A temp bare
// repo stands in for the private store; two machines are two names by env
// (RISA_MACHINE_NAME), each with its own clones (RISA_INBOX_STORE). The dispatcher runs
// from a copy of the tool with stubs for the backlog (its rows a JSON file), the worktree
// command and the opener, as dispatch.test.mjs does; never this checkout's config or ~/.risa.
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storeFor } from "../backlog/inbox-store.mjs";
import { FIXTURE_CONFIG } from "./config-fixture.mjs";
import { HOMES_FILE, REFETCH_MS, claim, homeOf, homeTick, homesOf, machineName, take } from "./home.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();

const OPEN_SH = `#!/usr/bin/env bash
echo "$*" >> "$STUB_STATE/open.calls"
echo "Opened in a new background iTerm2 tab."
`;
const NEW_SH = `#!/usr/bin/env bash
echo "$*" >> "$STUB_STATE/new.calls"
echo "made $2"
`;
const BACKLOG = `import { readFileSync } from "node:fs";
const [a, b] = process.argv.slice(2);
if (a === "prd" && b === "list") console.log(readFileSync(process.env.STUB_ROWS, "utf8"));
else process.exit(2);
`;

/** @type {string} */ let root;
/** @type {string} */ let remote;
/** @type {string} */ let tool;
/** @type {Record<string, string>} */ const repos = {};
/** @type {Record<string, string | undefined>} */ let base;

/** A project's main checkout at root/NAME: the fixture's risa.json, renamed, with INBOX when given. */
function project(name, inbox) {
  const dir = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "dev", dir]);
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  const fixture = JSON.parse(readFileSync(FIXTURE_CONFIG, "utf8"));
  writeFileSync(
    join(dir, "risa.json"),
    JSON.stringify({ ...fixture, name, ...(inbox ? { inbox } : {}) }, null, 2),
  );
  writeFileSync(join(dir, ".gitignore"), ".loops/\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** Machine M's env: its name and its own clones. */
const machine = (/** @type {string} */ m) => ({
  ...base,
  RISA_MACHINE_NAME: m,
  RISA_INBOX_STORE: join(root, `clones-${m}`),
});

/** The dispatcher for repo NAME on machine M, from the tool's copy. */
const dispatch = (
  /** @type {string} */ name,
  /** @type {string} */ m,
  args = ["--dry-run"],
  rows = args.includes("--dry-run") ? "planned" : "none",
  extra = {},
) => {
  const r = spawnSync("node", [join(tool, "loops/dispatch.mjs"), ...args], {
    cwd: repos[name],
    encoding: "utf8",
    env: {
      ...machine(m),
      RISA_MAIN: repos[name],
      RISA_CONFIG: join(repos[name], "risa.json"),
      STUB_ROWS: join(root, `${rows}.json`),
      ...extra,
    },
  });
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  return r.stdout;
};
const setClock = (/** @type {number} */ secs) => writeFileSync(join(root, "clock"), String(secs));
const T0 = 1_800_000_000;
const homes = () => homesOf(storeFor(remote, { env: machine("probe") }).read(HOMES_FILE));
const reports = (/** @type {string} */ name) => {
  const dir = join(repos[name], ".loops/.asks");
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
        .filter((a) => a.session === "dispatch-home" && a.kind === "report")
    : [];
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "home-test-")));
  remote = join(root, "store.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  // The tool's copy: its scripts (no tests or fixtures), the backlog, worktree and opener stubbed.
  tool = join(root, "tool");
  for (const d of ["loops", "backlog", "ci"])
    cpSync(join(HERE, "..", d), join(tool, d), {
      recursive: true,
      filter: (src) => !/\.test\.mjs$|\/(sample-project|fixture-project|codex-review\.fixtures)$/.test(src),
    });
  writeFileSync(join(tool, "backlog/backlog.mjs"), BACKLOG);
  writeFileSync(join(tool, "loops/open-session.sh"), OPEN_SH, { mode: 0o755 });
  writeFileSync(join(tool, "loops/new.sh"), NEW_SH, { mode: 0o755 });
  // An install is a checkout: the dispatcher reads its code's git facts.
  execFileSync("git", ["init", "-q", "-b", "main", tool]);
  // The machine config: an idle repo first (work off), then the inbox keeper, a
  // second repo with inbox, and one without.
  repos.idle = project("idle", { repo: remote });
  repos.first = project("first", { repo: remote });
  repos.second = project("second", { repo: remote });
  repos.plain = project("plain", null);
  const machineFile = join(root, "machine.json");
  writeFileSync(
    machineFile,
    JSON.stringify({
      repos: [
        { path: repos.idle, work: false },
        { path: repos.first, work: true },
        { path: repos.second, work: true },
        { path: repos.plain, work: true },
      ],
    }),
  );
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude-stub"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  // A stub osascript, as dispatch.test.mjs has: none on Linux, and never the real one here.
  writeFileSync(join(bin, "osascript"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  mkdirSync(join(root, "iTerm.app"));
  const inboxDir = join(root, "home/.risa/inbox");
  mkdirSync(inboxDir, { recursive: true });
  // The inbox folder trusted, as a first `risa inbox` by hand leaves it.
  writeFileSync(
    join(root, "claude.json"),
    JSON.stringify({ projects: { [inboxDir]: { hasTrustDialogAccepted: true } } }),
  );
  writeFileSync(join(root, "processes"), "claude-stub --remote-control backlog You are\n");
  // One planned topic, for the dry runs and the ticks a home stops; none for the other ticks.
  writeFileSync(
    join(root, "planned.json"),
    JSON.stringify([{ topic: "a", state: "planned", flags: [], after: [], hot: [], waiting: 0, notes: "" }]),
  );
  writeFileSync(join(root, "none.json"), "[]");
  mkdirSync(join(root, "state"));
  setClock(T0);
  base = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: join(root, "home"),
    GIT_AUTHOR_NAME: "T",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "T",
    GIT_COMMITTER_EMAIL: "t@example.com",
    RISA_MACHINE_CONFIG: machineFile,
    RISA_CAPTAIN: "Nechayev",
    RISA_CLAUDE_BIN: join(bin, "claude-stub"),
    RISA_ITERM_APP: join(root, "iTerm.app"),
    RISA_LOAD_FILE: join(root, "load"),
    RISA_CLOCK_FILE: join(root, "clock"),
    RISA_KEEP_SESSIONS: "on",
    RISA_PROCESS_FILE: join(root, "processes"),
    RISA_USAGE_WATCH: "off",
    RISA_PICKUP_EVERY: "off",
    RISA_CONTEXT_WATCH: "off",
    RISA_INBOX_DIR: inboxDir,
    RISA_CLAUDE_PROJECTS: join(root, "projects"),
    RISA_CLAUDE_CONFIG: join(root, "claude.json"),
    STUB_STATE: join(root, "state"),
  };
  writeFileSync(join(root, "load"), "1 1 1");
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the claims", () => {
  it("names the machine by its short host name, or RISA_MACHINE_NAME", () => {
    expect(machineName({ RISA_MACHINE_NAME: "mac-a" })).toBe("mac-a");
    expect(machineName({})).not.toContain(".");
  });

  it("the first claim wins, a second machine's is refused, and take moves it", () => {
    const a = storeFor(remote, { env: machine("mac-a") });
    const b = storeFor(remote, { env: machine("mac-b") });
    expect(homeOf(a, "solo")).toBeNull();
    expect(claim(a, "solo", "mac-a").holder).toBe("mac-a");
    const refused = claim(b, "solo", "mac-b");
    expect(refused).toEqual({ holder: "mac-a", commit: null });
    expect(claim(a, "solo", "mac-a").commit).toBeNull();
    const moved = take(b, "solo", "mac-b");
    expect(moved.from).toBe("mac-a");
    expect(moved.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(homeOf(a, "solo")).toBe("mac-b");
    expect(take(b, "solo", "mac-b").commit).toBeNull();
  });
});

describe("the dispatcher's home gate", () => {
  it("the inbox keeper claims its project and inbox on its first tick and keeps the inbox session", () => {
    const out = dispatch("first", "mac-a", ["--once"]);
    expect(out).toContain("home: claimed first for mac-a");
    expect(out).toContain("home: claimed inbox for mac-a");
    expect(out).toContain("keep-alive inbox: open (no live inbox session)");
    expect(homes()).toMatchObject({ first: { machine: "mac-a" }, inbox: { machine: "mac-a" } });
    expect(dispatch("first", "mac-a")).toContain("start a:");
  });

  it("a second repo with inbox claims its own home and leaves the inbox session to the keeper", () => {
    const out = dispatch("second", "mac-a", ["--once"]);
    expect(out).toContain("home: claimed second for mac-a");
    expect(out).not.toContain("claimed inbox");
    expect(out).toContain(`home: the inbox session is left to ${repos.first}`);
    expect(dispatch("second", "mac-a")).toContain(`keep-alive inbox: the inbox keeper is ${repos.first}`);
    expect(homes().inbox.machine).toBe("mac-a");
  });

  it("a repo without inbox claims nothing and keeps its own inbox session", () => {
    const before = homes();
    const out = dispatch("plain", "mac-a", ["--once"]);
    expect(out).not.toContain("home:");
    expect(out).toContain("keep-alive inbox: open (no live inbox session)");
    expect(homes()).toEqual(before);
  });

  it("after another machine takes the project, the next tick past the refetch skips it and files one report", () => {
    setClock(T0 + 30);
    const took = spawnSync("node", [join(tool, "loops/home.mjs"), "take", "first"], {
      cwd: root,
      encoding: "utf8",
      env: machine("mac-b"),
    });
    expect(took.stderr).toBe("");
    expect(took.stdout).toMatch(
      /^first's home is now mac-b \(was mac-a\): on .* homes\.json as [0-9a-f]{7}\n$/,
    );
    // Within five minutes of its last fetch, machine A still reads its own copy.
    setClock(T0 + 60);
    expect(dispatch("first", "mac-a")).toContain("start a:");
    // Past it, A fetches and stops: nothing starts, nothing is kept alive, one report.
    setClock(T0 + REFETCH_MS / 1000 + 1);
    const dry = dispatch("first", "mac-a");
    expect(dry).toContain(
      "nothing: first's home is mac-b, not mac-a (pnpm prd home take first moves it here)",
    );
    expect(dry).toContain("  a: waits: first's home is mac-b");
    expect(dry).toContain("keep-alive inbox: first's home is mac-b");
    expect(dry).toContain("home: would report first is mac-b's");
    expect(reports("first")).toEqual([]);
    const opens = () =>
      existsSync(join(root, "state/open.calls")) ? readFileSync(join(root, "state/open.calls"), "utf8") : "";
    const opened = opens();
    expect(dispatch("first", "mac-a", ["--once"], "planned")).toContain("home: reported first is mac-b's");
    dispatch("first", "mac-a", ["--once"], "planned");
    const filed = reports("first");
    expect(filed).toHaveLength(1);
    expect(filed[0].text).toContain("mac-b");
    expect(filed[0].text).toContain("mac-a");
    expect(filed[0].text).toContain("`pnpm prd home take first`");
    expect(existsSync(join(root, "state/new.calls"))).toBe(false);
    expect(opens()).toBe(opened);
  });

  it("`home` lists the claims, this machine's marked", () => {
    const r = spawnSync("node", [join(tool, "loops/home.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: machine("mac-b"),
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^first\tmac-b\t\S+Z\t\(this machine\)$/m);
    expect(r.stdout).toMatch(/^inbox\tmac-a\t\S+Z$/m);
    const bad = spawnSync("node", [join(tool, "loops/home.mjs"), "take", "nope"], {
      cwd: root,
      encoding: "utf8",
      env: machine("mac-b"),
    });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("nope: not a project in the inbox store");
  });

  it("a machine with the project's work off claims no home; a work-on machine claims or takes it (RISA-1078)", () => {
    repos.spare = project("spare", { repo: remote });
    const config = (/** @type {string} */ f, /** @type {object[]} */ list) => {
      writeFileSync(join(root, f), JSON.stringify({ repos: list }));
      return { RISA_MACHINE_CONFIG: join(root, f) };
    };
    const off = config("machine-off.json", [
      { path: repos.idle, work: false },
      { path: repos.spare, work: false },
    ]);
    const on = config("machine-on.json", [
      { path: repos.first, work: true },
      { path: repos.idle, work: true },
      { path: repos.spare, work: true },
    ]);
    // Work off: no claim, and the line says why; RISA_WORK_SELF doesn't change that.
    for (const name of ["idle", "spare"]) {
      const out = dispatch(name, "mac-c", ["--once"], "none", { ...off, RISA_WORK_SELF: "1" });
      expect(out).toContain(`home: claims no home for ${name}: the work switch is off ("work": false`);
      expect(out).toContain(`home: ${name}'s home isn't claimed here (the work switch is off`);
      expect(out).not.toContain("home: claimed");
      expect(homes()[name]).toBeUndefined();
    }
    expect(dispatch("idle", "mac-c", ["--dry-run"], "planned", off)).not.toContain("would claim");
    // Work on: the first tick claims as before.
    expect(dispatch("spare", "mac-d", ["--once"], "none", on)).toContain("home: claimed spare for mac-d");
    expect(homes().spare.machine).toBe("mac-d");
    // A take by the work-on machine finds no claim in the way.
    const took = spawnSync("node", [join(tool, "loops/home.mjs"), "take", "idle"], {
      cwd: root,
      encoding: "utf8",
      env: { ...machine("mac-d"), ...on },
    });
    expect(took.stderr).toBe("");
    expect(took.stdout).toMatch(/^idle's home is now mac-d: on .* homes\.json as [0-9a-f]{7}\n$/);
    // The work-off machine then reads it as away, like any machine that doesn't hold it.
    setClock(T0 + (3 * REFETCH_MS) / 1000);
    expect(dispatch("idle", "mac-c", ["--dry-run"], "planned", off)).toContain(
      "home: idle's home is mac-d, not mac-c",
    );
  });
});

describe("an unreadable homes file (RISA-1080)", () => {
  it("homesOf and homeOf throw on a file that isn't JSON or names no machine; absent is no claims", () => {
    expect(homesOf(null)).toEqual({});
    expect(() => homesOf("{ not json")).toThrow(/homes\.json: not JSON/);
    expect(() => homesOf("[]")).toThrow(/must hold one JSON object/);
    expect(() => homesOf('{"x": "mac-a"}')).toThrow(/homes\.json: x names no machine/);
    const lone = join(root, "lone.git");
    execFileSync("git", ["init", "-q", "--bare", lone]);
    const s = storeFor(lone, { env: machine("probe") });
    expect(homeOf(s, "x")).toBeNull();
    s.write(HOMES_FILE, () => "{ not json", "corrupt", { log: () => {} });
    expect(() => homeOf(s, "x")).toThrow(/not JSON/);
  });

  it("a claimed home reads as unknown while the file can't be parsed, claims nothing, and opens once it names this machine", () => {
    const remote2 = join(root, "unreadable.git");
    execFileSync("git", ["init", "-q", "--bare", remote2]);
    const probe = storeFor(remote2, { env: machine("probe") });
    const config = {
      ...JSON.parse(readFileSync(join(repos.second, "risa.json"), "utf8")),
      name: "lone",
      inbox: { repo: remote2 },
    };
    const env = machine("mac-e");
    const tick = (/** @type {number} */ now, /** @type {any} */ state, pid = 4242) =>
      homeTick({ main: repos.second, state, now, env, pid, config, report: () => false });
    const t0 = T0 * 1000;
    // An absent file in a reached store: the first tick claims, as before.
    const first = tick(t0, {});
    expect(first.lines).toContain("home: claimed lone for mac-e");
    expect(first.blocked).toBeNull();
    expect(first.state.claimed).toEqual(["lone"]);
    // The file broken, past the refetch: blocked, named unreadable, the claim dropped, nothing written.
    probe.write(HOMES_FILE, () => "{ not json", "corrupt", { log: () => {} });
    const later = t0 + REFETCH_MS;
    const bad = tick(later, first.state);
    expect(bad.blocked).toMatch(
      /^lone's home isn't known \(the homes file is unreadable \(homes\.json: not JSON/,
    );
    expect(bad.unknown).toEqual(["lone"]);
    expect(
      bad.lines.some((l) => l.startsWith("home: lone's home isn't known (the homes file is unreadable")),
    ).toBe(true);
    expect(bad.state.claimed).toEqual([]);
    // The next tick tries to claim, can't over the broken file, and stays shut.
    const still = tick(later + 1000, bad.state);
    expect(still.blocked).toMatch(/the homes file is unreadable/);
    expect(still.lines.some((l) => l.startsWith("home: couldn't claim lone"))).toBe(true);
    expect(probe.read(HOMES_FILE)).toBe("{ not json");
    // A dry run says the same.
    expect(
      homeTick({
        main: repos.second,
        state: still.state,
        now: later + 2000,
        env,
        pid: 4242,
        config,
        dryRun: true,
      }).blocked,
    ).toMatch(/unreadable/);
    // The file readable again and naming this machine: the gate opens.
    probe.write(HOMES_FILE, () => `${JSON.stringify({ lone: { machine: "mac-e" } })}\n`, "fixed", {
      log: () => {},
    });
    const fixed = tick(later + 3000, still.state);
    expect(fixed.blocked).toBeNull();
    expect(fixed.unknown).toEqual([]);
    expect(fixed.state.claimed).toEqual(["lone"]);
    expect(fixed.lines).not.toContain("home: claimed lone for mac-e");
  });
});

describe("prd.sh inbox's hop to the inbox keeper", () => {
  it("names the first work-on repo with inbox, skipping one switched off", () => {
    const r = spawnSync("node", [join(HERE, "home.mjs"), "inbox-repo"], { encoding: "utf8", env: base });
    expect(r.stdout.trim()).toBe(repos.first);
  });

  it("moves an inherited RISA_SESSIONS_DIR to the keeper's, so the record lands there (RISA-1072)", () => {
    const own = join(repos.second, ".loops/.sessions");
    const r = spawnSync("bash", [join(HERE, "prd.sh"), "inbox"], {
      cwd: repos.second,
      encoding: "utf8",
      env: { ...machine("mac-a"), RISA_SESSIONS_DIR: own },
    });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(existsSync(join(repos.first, ".loops/.sessions/inbox.json"))).toBe(true);
    expect(existsSync(join(own, "inbox.json"))).toBe(false);
  });
});
