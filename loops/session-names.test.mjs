// Session names for the outside (RISA-799, RISA-914): session.sh qualifies
// claude's --remote-control name and passes it as --name (and the main backlog's
// tab title), against a throwaway repo with the scripts copied in and a stub
// claude (RISA_CLAUDE_BIN); the keep-alive's and session requests' matchers
// still find each kind on the new process args; and a pushed question leads with
// the asking session's label (ask.mjs).
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.mjs";
import { label, personaFor } from "./flavor.mjs";
import { hasRemoteControl, remoteNamesOf } from "./keep-alive.mjs";
import { backlogRemoteOf } from "./session-requests.mjs";
import { displayName } from "./session-names.mjs";
import { recordVerdict } from "./skeptics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = loadConfig().config.name;
const CLAUDE = "claude-stub";

// Records its args, one per line, and exits.
const STUB = `#!/usr/bin/env bash
mkdir -p "$STUB_STATE"
printf '%s\\n' "$@" > "$STUB_STATE/args"
`;

let root, main, sessions, state, stub, noneConfig, env;
const scripts = (f) => join(main, "loops", f);
const record = (name) => JSON.parse(readFileSync(join(sessions, `${name}.json`), "utf8"));
const argsSeen = () => readFileSync(join(state, "args"), "utf8").replace(/\n$/, "").split("\n");
/** The value after FLAG in ARGS, or undefined. */
const after = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
/** The process's command line as ps shows it: the matchers' input. */
const psLine = (args) => [CLAUDE, ...args].join(" ");
const wrap = (name, claudeArgs, extra = {}) => {
  const r = spawnSync("bash", [scripts("session.sh"), name, "--", ...claudeArgs], {
    cwd: main,
    encoding: "utf8",
    env: { ...env, ...extra },
  });
  expect(r.status, r.stderr).toBe(0);
  return { ...r, args: argsSeen() };
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "session-names-test-")));
  main = join(root, "repo");
  sessions = join(root, "sessions");
  state = join(root, "state");
  mkdirSync(join(root, "bin"));
  stub = join(root, "bin", CLAUDE);
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  noneConfig = join(root, "machine-none.json");
  writeFileSync(noneConfig, JSON.stringify({ flavor: "none", repos: [] }));
  execFileSync("git", ["init", "-q", "-b", "dev", main]);
  mkdirSync(join(main, "loops"));
  for (const f of [
    "lib.sh",
    "config.mjs",
    "session.sh",
    "sessions.mjs",
    "session-names.mjs",
    "host.mjs",
    "captain.mjs",
    "flavor.mjs",
    "machine.mjs",
  ])
    copyFileSync(join(HERE, f), scripts(f));
  env = {
    ...process.env,
    TRUNK: "dev",
    RISA_CLAUDE_BIN: stub,
    RISA_SESSIONS_DIR: sessions,
    RISA_MACHINE_CONFIG: "",
    STUB_STATE: state,
  };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(state, { recursive: true, force: true });
  rmSync(sessions, { recursive: true, force: true });
});

describe("session.sh names the session for the outside", () => {
  it("the main backlog: `backlog (<project>) · Admiral <given>`, its --name and tab title; the record keeps the admiral", () => {
    const shown = `backlog (${PROJECT}) · Admiral Janeway`;
    const r = wrap("backlog", ["--remote-control", "Janeway", "a prompt"], { RISA_TAB_TITLE: "always" });
    expect(after(r.args, "--remote-control")).toBe(shown);
    expect(after(r.args, "--name")).toBe(shown);
    expect(r.args.at(-1)).toBe("a prompt");
    expect(r.stdout).toContain(`\x1b]0;${shown}\x07`);
    expect(record("backlog")).toMatchObject({ kind: "backlog", remote: "Janeway" });
  });

  it("an orchestrator: `prd-t (<project>) · Captain <its hashed name>`, the same on a second start", () => {
    const shown = `prd-t (${PROJECT}) · ${label(personaFor("prd", "prd-t"))}`;
    expect(label(personaFor("prd", "prd-t"))).toMatch(/^Captain \S+$/);
    for (let i = 0; i < 2; i++) {
      const r = wrap("prd-t", ["--remote-control", "prd-t", "x"], { RISA_TAB_TITLE: "always" });
      expect(after(r.args, "--remote-control")).toBe(shown);
      expect(after(r.args, "--name")).toBe(shown);
      expect(r.stdout).not.toContain("\x1b]0;");
      expect(record("prd-t").remote).toBe("prd-t");
    }
  });

  it("a `backlog - <name>` request session gets the project and no persona", () => {
    const r = wrap("backlog-triage", ["--remote-control", "backlog - triage", "x"], {
      RISA_TAB_TITLE: "always",
    });
    expect(after(r.args, "--remote-control")).toBe(`backlog - triage (${PROJECT})`);
    expect(after(r.args, "--name")).toBe(`backlog - triage (${PROJECT})`);
    expect(r.stdout).not.toContain("\x1b]0;");
    expect(record("backlog-triage").remote).toBe("backlog - triage");
  });

  it("under flavor none, no persona", () => {
    const none = { RISA_MACHINE_CONFIG: noneConfig, RISA_TAB_TITLE: "always" };
    expect(after(wrap("prd-t", ["--remote-control", "prd-t", "x"], none).args, "--remote-control")).toBe(
      `prd-t (${PROJECT})`,
    );
    expect(after(wrap("inbox", ["--remote-control", "inbox", "x"], none).args, "--remote-control")).toBe(
      `inbox (${PROJECT})`,
    );
    // The draw under none is the bare `backlog`: the project, no admiral, no title.
    const r = wrap("backlog", ["--remote-control", "backlog", "x"], none);
    expect(after(r.args, "--remote-control")).toBe(`backlog (${PROJECT})`);
    expect(r.stdout).not.toContain("\x1b]0;");
  });

  it("a qualified name isn't qualified twice, in either spelling of the flag", () => {
    const q = `prd-t (${PROJECT}) · Captain Sisko`;
    const r = wrap("prd-t", ["--remote-control", q, "x"]);
    expect(after(r.args, "--remote-control")).toBe(q);
    expect(after(r.args, "--name")).toBe(q);
    expect(record("prd-t").remote).toBe(q);
    const eq = wrap("hotfix-trim", [`--remote-control=hotfix-trim (${PROJECT})`, "x"]);
    expect(eq.args).toEqual([
      `--remote-control=hotfix-trim (${PROJECT})`,
      "--name",
      `hotfix-trim (${PROJECT})`,
      "x",
    ]);
    expect(
      displayName({ name: "backlog", kind: "backlog", remote: `backlog (${PROJECT})`, project: PROJECT }),
    ).toBe(`backlog (${PROJECT})`);
  });

  it("args that carry --name or -n keep theirs", () => {
    for (const flag of ["--name", "-n"]) {
      const r = wrap("prd-t", ["--remote-control", "prd-t", flag, "mine", "x"]);
      expect(r.args.filter((a) => a === "--name" || a === "-n")).toEqual([flag]);
      expect(after(r.args, flag)).toBe("mine");
      expect(after(r.args, "--remote-control")).toMatch(/^prd-t \(/);
    }
  });

  it("no --remote-control: neither name is added", () => {
    const r = wrap("prd-t", ["--model", "sonnet", "x"]);
    expect(r.args.slice(-3)).toEqual(["--model", "sonnet", "x"]);
    expect(r.args).not.toContain("--name");
    expect(record("prd-t").remote).toBeUndefined();
  });
});

describe("the matchers on the new process args, unchanged", () => {
  it("the main backlog under an admiral the old captain matchers don't know is still the backlog", () => {
    const { args } = wrap("backlog", ["--remote-control", "Ross", "x"]);
    const ps = psLine(args);
    expect(ps).toContain(`--remote-control backlog (${PROJECT}) · Admiral Ross`);
    expect(remoteNamesOf("backlog").some((n) => hasRemoteControl(ps, n, CLAUDE))).toBe(true);
    expect(hasRemoteControl(ps, "backlog", CLAUDE)).toBe(true);
    expect(backlogRemoteOf(ps, CLAUDE)).toBe("backlog");
    // The bare admiral, as it ran before: neither matcher knows it.
    expect(backlogRemoteOf(psLine(["--remote-control", "Ross", "x"]), CLAUDE)).toBeNull();
  });

  it("a request session is its own name, never the main backlog", () => {
    const ps = psLine(wrap("backlog-triage", ["--remote-control", "backlog - triage", "x"]).args);
    expect(backlogRemoteOf(ps, CLAUDE)).toBe("backlog-triage");
    expect(remoteNamesOf("backlog").some((n) => hasRemoteControl(ps, n, CLAUDE))).toBe(false);
  });

  it("the inbox is still the inbox, and an orchestrator is no kept kind", () => {
    const inbox = psLine(wrap("inbox", ["--remote-control", "inbox", "x"]).args);
    expect(remoteNamesOf("inbox").some((n) => hasRemoteControl(inbox, n, CLAUDE))).toBe(true);
    const prd = psLine(wrap("prd-t", ["--remote-control", "prd-t", "x"]).args);
    expect(hasRemoteControl(prd, "backlog", CLAUDE)).toBe(false);
    expect(hasRemoteControl(prd, "inbox", CLAUDE)).toBe(false);
    expect(backlogRemoteOf(prd, CLAUDE)).toBeNull();
  });
});

describe("a pushed question carries the asking session's label", () => {
  let asks, skeptic, osa;
  beforeAll(() => {
    osa = join(root, "osa");
    mkdirSync(osa);
    writeFileSync(join(osa, "osascript"), "#!/bin/sh\n");
    chmodSync(join(osa, "osascript"), 0o755);
  });
  beforeEach(() => {
    asks = mkdtempSync(join(root, "asks-"));
    skeptic = mkdtempSync(join(root, "skeptic-"));
  });
  const Q = "Land wave 1 now?";
  const ask = (extra = {}, session = []) => {
    const id = recordVerdict(skeptic, {
      kind: "ask",
      verdict: "ask",
      why: "the user's call",
      topic: "demo",
      question: Q,
      offers: ["yes", "no"],
      askerClass: "waits",
    }).id;
    const r = spawnSync(
      "node",
      [
        join(HERE, "ask.mjs"),
        "ask",
        "--topic",
        "demo",
        "--question",
        Q,
        "--option",
        "yes",
        "--option",
        "no",
        "--waits",
        "--skeptic",
        id,
        ...session,
      ],
      {
        encoding: "utf8",
        env: {
          ...env,
          PATH: `${osa}:${process.env.PATH}`,
          RISA_ASKS_DIR: asks,
          RISA_SKEPTIC_DIR: skeptic,
          ...extra,
        },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    const stored = JSON.parse(readFileSync(join(asks, "a1.json"), "utf8"));
    expect(stored.text).toBe(Q);
    return r.stdout.split("\n")[1];
  };

  it("an orchestrator's push leads with its captain; the ask holds the bare question", () => {
    const captain = label(personaFor("prd", "prd-t"));
    expect(ask({ RISA_SESSION_NAME: "prd-t" })).toBe(`Now send a PushNotification: ${captain} · demo: ${Q}`);
  });

  it("the main backlog's leads with its record's admiral", () => {
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "backlog.json"), JSON.stringify({ kind: "backlog", remote: "Ross" }));
    expect(ask({ RISA_SESSION_NAME: "backlog" })).toBe(
      `Now send a PushNotification: Admiral Ross · demo: ${Q}`,
    );
  });

  it("no label under none, without a session, or for a request session", () => {
    const bare = `Now send a PushNotification: demo: ${Q}`;
    expect(ask({ RISA_SESSION_NAME: "prd-t", RISA_MACHINE_CONFIG: noneConfig })).toBe(bare);
    expect(ask()).toBe(bare);
    expect(ask({ RISA_SESSION_NAME: "backlog-triage" })).toBe(bare);
  });

  it("no label for the dispatcher's own asks", () => {
    const r = spawnSync(
      "node",
      [join(HERE, "ask.mjs"), "ask", "--topic", "demo", "--question", Q, "--session", "dispatch"],
      {
        encoding: "utf8",
        env: {
          ...env,
          PATH: `${osa}:${process.env.PATH}`,
          RISA_ASKS_DIR: asks,
          RISA_SKEPTIC_DIR: skeptic,
          RISA_SESSION_NAME: "prd-t",
        },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.split("\n")[1]).toBe(`Now send a PushNotification: demo: ${Q}`);
  });
});
