// lease.sh and lease.mjs against a throwaway lease root (CARETOOK_LEASE_ROOT),
// so these never take one of the machine's real leases.
import { execFileSync, spawn, spawnSync } from "node:child_process";
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
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { LEASE_SH, takeLease } from "./lease.mjs";

const PRD_SH = new URL("./prd.sh", import.meta.url).pathname;
// The variable naming the lease root lease.sh reads, named once (the boundary lint counts each).
const ROOT_VAR = "CARETOOK_LEASE_ROOT";

let root, env;
const children = [];

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "lease-test-")));
  env = { ...process.env, [ROOT_VAR]: join(root, "leases"), CARETOOK_LEASE_POLL: "1" };
  for (const k of Object.keys(env)) {
    if (
      /^CARETOOK_(BROWSER_LEASES|BROWSER_OLD_LEASES|BROWSER_SLOTS|CHECK_SLOTS|LEASES)$/.test(k) ||
      /_WAIT$/.test(k)
    )
      delete env[k];
  }
});
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// start(args, extra) → a running lease.sh, with its output so far and its exit.
const start = (args, extra = {}) => {
  const child = spawn("bash", [LEASE_SH, ...args], {
    env: { ...env, ...extra },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const p = { child, out: "", err: "" };
  child.stdout.on("data", (d) => (p.out += d));
  child.stderr.on("data", (d) => (p.err += d));
  p.exit = new Promise((r) => child.once("exit", (code, signal) => r(code ?? signal)));
  return p;
};
// until(cond, ms, state) → once cond() holds; past ms, fails with state()'s
// account of what it saw instead, so a CI-only timeout says which part stuck.
const until = async (cond, ms = 10_000, state) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms${state ? `:\n${state()}` : ""}`);
    await sleep(50);
  }
};
const holdLine = (p) => /^lease (\d+) (.+)$/m.exec(p.out);
const hold = async (kind, label, extra) => {
  const p = start(["hold", kind, "--label", label], extra);
  await until(() => holdLine(p));
  const [, n, path] = holdLine(p);
  return { ...p, n: Number(n), path };
};
const cli = (args, extra = {}) => {
  const r = spawnSync("bash", [LEASE_SH, ...args], { env: { ...env, ...extra }, encoding: "utf8" });
  return { out: r.stdout, err: r.stderr, status: r.status };
};
const dir = (kind, n) => join(env[ROOT_VAR], kind, String(n));

const SLOW = { timeout: 40_000 };

describe("taking and waiting", SLOW, () => {
  it("lets three takers of a three-slot kind in, and the fourth waits for a release", async () => {
    const extra = { CARETOOK_TRIO_SLOTS: "3" };
    const held = [];
    for (const label of ["one", "two", "three"]) held.push(await hold("trio", label, extra));
    expect(held.map((h) => h.n).sort()).toEqual([1, 2, 3]);

    const fourth = start(["hold", "trio", "--label", "four"], extra);
    await until(() => fourth.err.includes("All 3 trio leases are taken; waiting"));
    await sleep(1500);
    expect(holdLine(fourth)).toBeNull();
    const { out } = cli(["holders", "trio"], extra);
    expect(out).toMatch(/^trio leases: 3 of 3 held$/m);
    for (const label of ["one", "two", "three"])
      expect(out).toMatch(new RegExp(`lease \\d: \\S+: ${label} \\(pid \\d+`));

    const two = held.find((h) => h.n === 2);
    two.child.kill("SIGTERM");
    await until(() => holdLine(fourth), 8000);
    expect(holdLine(fourth)[1]).toBe("2");
    expect(fourth.err).toMatch(/Took trio lease 2 of 3 after waiting/);
    for (const h of [...held, fourth]) h.child.stdin.end();
    await Promise.all([...held, fourth].map((h) => h.exit));
    expect(cli(["holders", "trio"], extra).out).toMatch(/^trio leases: 0 of 3 held$/m);
  });

  it("gives up after --wait seconds with exit 75, naming the holders", async () => {
    const h = await hold("solo", "holding it");
    const r = cli(["take", "solo", "--wait", "1"]);
    expect(r.status).toBe(75);
    expect(r.err).toMatch(/Gave up after 0m01s waiting for a solo lease/);
    expect(r.err).toMatch(/lease 1: \S+: holding it/);
    h.child.stdin.end();
    await h.exit;
  });

  it("takes over a lease whose holder was killed", async () => {
    const h = await hold("killed", "doomed");
    h.child.kill("SIGKILL");
    await h.exit;
    expect(existsSync(join(h.path, "name"))).toBe(true); // a SIGKILL runs no trap
    expect(cli(["holders", "killed"]).out).toMatch(/lease 1: stale, \S+: doomed \(pid \d+.*isn't running/);

    const r = cli(["take", "killed", "--wait", "3", "--label", "next", "--pid", String(process.pid)]);
    expect(r.status).toBe(0);
    expect(r.err).toMatch(/Taking over stale killed lease 1: \S+: doomed/);
    expect(r.out.trim()).toBe(dir("killed", 1));
    expect(readFileSync(join(dir("killed", 1), "name"), "utf8")).toMatch(/^check=next$/m);
    expect(cli(["release", "killed", "--pid", String(process.pid)]).status).toBe(0);
    expect(existsSync(dir("killed", 1))).toBe(false);
  });

  // B-867: on CI a takeover removed a lease made a moment before, a second taker
  // made the slot again, and both went ahead. Here the test makes that
  // interleaving by hand: each taker stops after its mkdir, before writing its
  // name file (CARETOOK_LEASE_TEST_WRITE_PAUSE), and goes on once MARKER.go exists.
  it.each([
    ["the first taker writes first", ["a", "b"]],
    ["the second taker writes first", ["b", "a"]],
  ])("never lets two takers hold one slot when it is made twice (%s)", async (_, order) => {
    const kind = `race-${order[0]}`;
    const takers = {};
    for (const who of ["a", "b"]) {
      const marker = join(root, `${kind}-${who}`);
      // (start's object, not a copy: its out and err grow as the taker writes)
      takers[who] = Object.assign(
        start(["hold", kind, "--label", who], { CARETOOK_LEASE_TEST_WRITE_PAUSE: marker }),
        { marker },
      );
      await until(() => existsSync(marker));
      expect(existsSync(dir(kind, 1))).toBe(true);
      // a's slot goes as a takeover's rm -rf took it; b then makes it again.
      if (who === "a") rmSync(dir(kind, 1), { recursive: true });
    }
    const [first, second] = order.map((who) => takers[who]);
    writeFileSync(`${first.marker}.go`, "");
    await until(() => holdLine(first));
    expect(holdLine(first)[1]).toBe("1");
    writeFileSync(`${second.marker}.go`, "");
    await until(() => second.err.includes("All 1 race"));
    expect(holdLine(second)).toBeNull();
    expect(readFileSync(join(dir(kind, 1), "name"), "utf8")).toMatch(
      new RegExp(`^check=${order[0]}\\npid=${first.child.pid}$`, "m"),
    );
    expect(cli(["holders", kind]).out).toMatch(/^race-\w leases: 1 of 1 held$/m);

    first.child.stdin.end();
    expect(await first.exit).toBe(0);
    await until(() => holdLine(second), 8000);
    expect(readFileSync(join(dir(kind, 1), "name"), "utf8")).toMatch(new RegExp(`^check=${order[1]}$`, "m"));
    second.child.stdin.end();
    expect(await second.exit).toBe(0);
    expect(existsSync(dir(kind, 1))).toBe(false);
  });

  it("leaves a lone taker's name file whole, with no temp file beside it", async () => {
    const h = await hold("lone", "alone");
    expect(readFileSync(join(h.path, "name"), "utf8")).toMatch(/^check=alone\npid=\d+$/m);
    expect(execFileSync("ls", ["-A", h.path], { encoding: "utf8" }).trim()).toBe("name");
    h.child.stdin.end();
    expect(await h.exit).toBe(0);
  });
});

describe("waiting for a worktree's lease to go (lease.sh wait, pnpm prd wait)", SLOW, () => {
  const wt = { lease_worktree: "wt-a" };
  // pnpm prd wait names the worktree it runs in: outside git, its directory's name.
  const prdWait = (args, extra = {}) => {
    const cwd = join(root, "wt-a");
    mkdirSync(cwd, { recursive: true });
    const child = spawn("bash", [PRD_SH, "wait", ...args], {
      cwd,
      env: { ...env, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const p = { child, out: "", err: "" };
    child.stdout.on("data", (d) => (p.out += d));
    child.stderr.on("data", (d) => (p.err += d));
    p.exit = new Promise((r) => child.once("exit", (code, signal) => r(code ?? signal)));
    return p;
  };

  it("returns once the worktree's check lease is released", async () => {
    const h = await hold("check", "pnpm check (quick)", wt);
    const w = start(["wait", "check", "--worktree", "wt-a", "--timeout", "30"]);
    await until(() => w.out.includes("Waiting (up to 0m30s) for wt-a's check:"));
    expect(w.out).toMatch(/wt-a: pnpm check \(quick\) \(pid \d+/);
    await sleep(1500);
    expect(w.child.exitCode).toBeNull();
    h.child.stdin.end();
    await h.exit;
    expect(await w.exit).toBe(0);
    expect(w.out).toMatch(/wt-a's check is done \(waited/);
  });

  it("exits 75 at its timeout while the lease is held, and ignores other worktrees' holders", async () => {
    const h = await hold("check", "held by a", wt);
    const w = prdWait(["--timeout", "1"]);
    expect(await w.exit).toBe(75);
    expect(w.err).toMatch(/Gave up after 0m0[12]s: wt-a's check is still running/);
    expect(w.err).toMatch(/wt-a: held by a/);
    const other = cli(["wait", "check", "--worktree", "wt-b", "--timeout", "1"]);
    expect(other.status).toBe(0);
    expect(other.out).toMatch(/wt-b holds no check lease/);
    h.child.stdin.end();
    await h.exit;
    expect(cli(["wait", "check", "--worktree", "wt-a", "--timeout", "1"]).status).toBe(0);
  });

  it("counts a check still queued for a lease, and forgets it once it takes one or is killed", async () => {
    const extra = { CARETOOK_QUEUE_SLOTS: "1" };
    const first = await hold("queue", "first", { ...extra, lease_worktree: "wt-other" });
    const queued = start(["hold", "queue", "--label", "queued"], { ...extra, ...wt });
    await until(() => queued.err.includes("All 1 queue leases are taken; waiting"));
    const w = cli(["wait", "queue", "--worktree", "wt-a", "--timeout", "1"], extra);
    expect(w.status).toBe(75);
    expect(w.err).toMatch(/wt-a: queued \(waiting for a lease\)/);

    first.child.stdin.end();
    await until(() => holdLine(queued), 8000);
    const waiting = join(env[ROOT_VAR], "queue", ".waiting");
    expect(existsSync(join(waiting, String(queued.child.pid)))).toBe(false);
    queued.child.stdin.end();
    await Promise.all([first.exit, queued.exit]);

    const blocker = await hold("queue", "blocker", { ...extra, lease_worktree: "wt-other" });
    const doomed = start(["hold", "queue", "--label", "doomed"], { ...extra, ...wt });
    await until(() => doomed.err.includes("waiting"));
    doomed.child.kill("SIGKILL");
    await doomed.exit;
    expect(cli(["wait", "queue", "--worktree", "wt-a", "--timeout", "1"], extra).status).toBe(0);
    blocker.child.stdin.end();
    await blocker.exit;
  });

  it("is in pnpm prd help, defaulting to the check kind", () => {
    const help = spawnSync("bash", [PRD_SH, "help"], { env, encoding: "utf8" }).stdout;
    expect(help).toMatch(/^ {4}wait \[check\|browser\|<kind>\] \[--timeout <s>\]/m);
    expect(help).toContain("never `pgrep -f`");
  });
});

describe("releasing", SLOW, () => {
  it("releases a hold on SIGTERM", async () => {
    const h = await hold("term", "held");
    expect(existsSync(h.path)).toBe(true);
    h.child.kill("SIGTERM");
    expect(await h.exit).toBe(143);
    expect(existsSync(h.path)).toBe(false);
  });

  // B-742: a TERM between the lease's mkdir and lease_path= left the directory behind.
  it.each([
    ["hold", ["hold", "window", "--label", "held"]],
    ["run", ["run", "window", "--", "true"]],
  ])("leaves no lease when %s is TERMed between making the lease and recording it", async (_, args) => {
    const marker = join(root, `window-${args[0]}`);
    const p = start(args, { CARETOOK_LEASE_TEST_PAUSE: marker });
    await until(() => existsSync(marker));
    expect(existsSync(dir("window", 1))).toBe(true); // made, not yet recorded
    p.child.kill("SIGTERM");
    expect(await p.exit).toBe(143);
    expect(existsSync(dir("window", 1))).toBe(false);
  });

  it("releases a hold when its stdin closes or its watched pid exits", async () => {
    const h = await hold("eof", "held");
    h.child.stdin.end();
    expect(await h.exit).toBe(0);
    expect(existsSync(h.path)).toBe(false);

    const watched = spawn("sleep", ["30"]);
    children.push(watched);
    const w = start(["hold", "eof", "--watch", String(watched.pid)]);
    await until(() => holdLine(w));
    watched.kill("SIGKILL");
    expect(await w.exit).toBe(0);
    expect(existsSync(dir("eof", 1))).toBe(false);
  });

  it("run holds the lease while its command runs, exits with its code, and stops it on SIGTERM", async () => {
    const r = cli(["run", "runk", "--label", "fake", "--", "sh", "-c", 'ls "$0"; exit 3', dir("runk", 1)]);
    expect(r.status).toBe(3);
    expect(r.out).toMatch(/^name$/m); // the lease existed while the command ran
    expect(existsSync(dir("runk", 1))).toBe(false);

    const marker = join(root, "run-marker");
    const p = start(["run", "runk", "--", "sh", "-c", `echo $$ > ${marker}; sleep 30`]);
    await until(() => existsSync(marker) && readFileSync(marker, "utf8").trim() !== "");
    const pid = Number(readFileSync(marker, "utf8"));
    p.child.kill("SIGTERM");
    expect(await p.exit).toBe(143);
    expect(existsSync(dir("runk", 1))).toBe(false);
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 3000);
  });
});

describe("pnpm prd check's check lease", SLOW, () => {
  it("wraps the check (quick or full: the project's hook, then the tooling tests) in `lease.sh run check`", () => {
    expect(readFileSync(PRD_SH, "utf8")).toMatch(
      /lease\.sh" run check --label "pnpm check[^"]*" -- \\\n\s*"\$bin\/check-run\.sh" "\$pmode" [^\n]* -- "\$bin\/check-hook\.sh"/,
    );
  });

  // Every run's command holds until the test creates `go`, so nothing ends
  // while the test looks: no real-time race between a 2 s fake check, the
  // takers' start-up (slow under load) and `holders` (B-654). The late case
  // spawns its fifth taker only once the first four have settled (two started,
  // two told to wait), a state, not a fixed sleep; both cases give the four
  // start-ups the same budget, since they are the same work (B-824: the late
  // case's first wait had half of it and was the only one that timed out on CI).
  // Each case has its own lease root, so nothing an earlier test left can count.
  it.each([
    ["all at once", false],
    ["one taker slowed", true],
  ])(
    "makes the runs beyond the default limit of two wait, and holders shows who holds what (%s)",
    async (name, late) => {
      const here = join(root, `check-${late ? "late" : "once"}`);
      const extra = { [ROOT_VAR]: join(here, "leases") };
      mkdirSync(here);
      const log = join(here, "log");
      const go = join(here, "go");
      writeFileSync(log, "");
      // A fake pnpm check: note its start, hold until `go`, note its end.
      const fake = [
        "sh",
        "-c",
        `echo start >> ${log}; while [ ! -e ${go} ]; do sleep 0.05; done; echo end >> ${log}`,
      ];
      const run = () => start(["run", "check", "--label", "pnpm check", "--", ...fake], extra);
      const lines = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
      const waiting = (r) => r.err.includes("All 2 check leases are taken; waiting");
      const settled = (n) => () => lines().length === 2 && runs.filter(waiting).length === n;
      // What each taker saw, for a timeout: the log, each run's exit and stderr, holders.
      const state = () =>
        [
          `${name}: log ${JSON.stringify(lines())}`,
          ...runs.map(
            (r, i) =>
              `run ${i} (pid ${r.child.pid}, exit ${r.child.exitCode ?? r.child.signalCode ?? "-"}): ${JSON.stringify(r.err)}`,
          ),
          cli(["holders", "check"], extra).out,
        ].join("\n");
      const runs = [];
      for (let i = 0; i < 4; i++) runs.push(run());
      if (late) await until(settled(2), 20_000, state);
      runs.push(run());
      // Each taker's own state: two started, three told they wait.
      await until(settled(3), 20_000, state);
      const { out } = cli(["holders"], extra);
      expect(out).toMatch(/^check leases: 2 of 2 held$/m);
      expect(out.match(/lease \d: \S+: pnpm check \(pid \d+/g)).toHaveLength(2);
      expect(out).toMatch(/^browser leases: 0 of 2 held$/m);
      expect(lines()).toEqual(["start", "start"]); // nobody ran past the limit while waiting

      writeFileSync(go, "");
      expect(await Promise.all(runs.map((r) => r.exit))).toEqual([0, 0, 0, 0, 0]);
      expect(runs.filter(waiting)).toHaveLength(3);
      let running = 0;
      let most = 0;
      for (const line of lines()) {
        running += line === "start" ? 1 : -1;
        most = Math.max(most, running);
      }
      expect(most).toBe(2);
      expect(lines()).toHaveLength(10);
    },
  );
});

describe("browser leases and the old path", SLOW, () => {
  it("lives under the lease root, and CARETOOK_BROWSER_LEASES still moves it", () => {
    const pid = String(process.pid);
    const r = cli(["take", "browser", "--pid", pid]);
    expect(r.out.trim()).toBe(join(root, "leases", "browser", "1"));
    cli(["release", "browser", "--pid", pid]);
    const own = join(root, "own-browser");
    const o = cli(["take", "browser", "--pid", pid], { CARETOOK_BROWSER_LEASES: own });
    expect(o.out.trim()).toBe(join(own, "1"));
    cli(["release", "browser", "--pid", pid], { CARETOOK_BROWSER_LEASES: own });
    expect(existsSync(join(own, "1"))).toBe(false);
  });

  it("counts live holders under the old path until they're gone, and lists them", async () => {
    const old = join(root, "old-browser");
    const extra = { CARETOOK_BROWSER_OLD_LEASES: old, CARETOOK_BROWSER_SLOTS: "2" };
    // An unsynced worktree's browser.sh holding old lease 2 (a lease.sh name file).
    const holder = spawn("bash", ["-c", "sleep 30; :", "browser.sh"]);
    children.push(holder);
    mkdirSync(join(old, "2"), { recursive: true });
    writeFileSync(
      join(old, "2", "name"),
      `kind=browser\nworktree=other-prd\ncheck=phase2.mjs\npid=${holder.pid}\ncmd=browser.sh\nstarted=${Math.floor(Date.now() / 1000)}\n`,
    );
    const pid = String(process.pid);
    const first = cli(["take", "browser", "--pid", pid], extra);
    expect(first.status).toBe(0);
    const full = cli(["take", "browser", "--wait", "1", "--pid", pid], extra);
    expect(full.status).toBe(75);
    expect(full.err).toMatch(/old path .*other-prd: phase2\.mjs/);
    expect(cli(["holders", "browser"], extra).out).toMatch(/1 of 2 held[\s\S]*old path/);

    holder.kill("SIGKILL");
    await sleep(200);
    const second = cli(["take", "browser", "--wait", "2", "--pid", pid], extra);
    expect(second.status).toBe(0);
    expect(existsSync(join(old, "2"))).toBe(true); // the old path is left as it was
    cli(["release", "browser", "--pid", pid], extra);
  });

  it("keeps a holder whose program name differs from its process name (Linux's comm)", () => {
    const holder = spawn("bash", ["-c", "exec -a lease-holder-prog sleep 30"]);
    children.push(holder);
    const extra = { CARETOOK_BROWSER_SLOTS: "1", CARETOOK_BROWSER_LEASES: join(root, "comm-browser") };
    const pid = String(holder.pid);
    spawnSync("sh", [
      "-c",
      `until ps -p ${pid} -o command= | grep -q lease-holder-prog; do sleep 0.05; done`,
    ]);
    expect(cli(["take", "browser", "--pid", pid], extra).status).toBe(0);
    expect(cli(["take", "browser", "--wait", "1", "--pid", String(process.pid)], extra).status).toBe(75);
    cli(["release", "browser", "--pid", pid], extra);
  });

  it("holds browser leases under lease.sh's own command line", async () => {
    const h = await hold("browser", "web:components");
    const command = execFileSync("ps", ["-p", String(h.child.pid), "-o", "command="], { encoding: "utf8" });
    expect(command).toMatch(/lease\.sh/);
    expect(command).not.toMatch(/browser\.sh\)/);
    h.child.stdin.end();
    await h.exit;
  });
});

describe("takeLease (Node)", SLOW, () => {
  it("takes a lease, waits behind holders, and releases", async () => {
    const extra = { ...env, CARETOOK_NODEK_SLOTS: "1" };
    const first = await takeLease("nodek", { label: "vitest one", env: extra });
    expect(first.n).toBe(1);
    expect(readFileSync(join(first.path, "name"), "utf8")).toMatch(/^check=vitest one$/m);

    let second;
    const pending = takeLease("nodek", { label: "vitest two", env: extra }).then((l) => (second = l));
    await sleep(1500);
    expect(second).toBeUndefined();
    await first.release();
    await pending;
    expect(second.n).toBe(1);
    await second.release();
    expect(existsSync(dir("nodek", 1))).toBe(false);
  });

  it("rejects when lease.sh gives up, and takes nothing with CARETOOK_LEASES=off", async () => {
    const extra = { ...env, CARETOOK_NODEK_SLOTS: "1" };
    const held = await takeLease("nodek", { env: extra });
    await expect(takeLease("nodek", { wait: 1, env: extra })).rejects.toThrow(/exited with 75/);
    await held.release();
    const off = await takeLease("nodek", { env: { ...extra, CARETOOK_LEASES: "off" } });
    expect(off).toMatchObject({ n: 0, path: null });
    await off.release();
  });
});
