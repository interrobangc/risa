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

let root, env;
const children = [];

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "lease-test-")));
  env = { ...process.env, CARETOOK_LEASE_ROOT: join(root, "leases"), CARETOOK_LEASE_POLL: "1" };
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
const until = async (cond, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
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
const dir = (kind, n) => join(env.CARETOOK_LEASE_ROOT, kind, String(n));

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
});

describe("releasing", SLOW, () => {
  it("releases a hold on SIGTERM", async () => {
    const h = await hold("term", "held");
    expect(existsSync(h.path)).toBe(true);
    h.child.kill("SIGTERM");
    expect(await h.exit).toBe(143);
    expect(existsSync(h.path)).toBe(false);
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
  it("wraps pnpm check (then the bundle budget) in `lease.sh run check`", () => {
    expect(readFileSync(PRD_SH, "utf8")).toMatch(
      /lease\.sh" run check --label "pnpm check" -- sh -c 'pnpm check && pnpm build:budget'/,
    );
  });

  it("makes two runs beyond the limit of three wait, and holders shows who holds what", async () => {
    const log = join(root, "check-log");
    writeFileSync(log, "");
    // A fake pnpm check: note its start and end, run for 2 s.
    const fake = ["sh", "-c", `echo start >> ${log}; sleep 2; echo end >> ${log}`];
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push(start(["run", "check", "--label", "pnpm check", "--", ...fake]));
    await until(
      () =>
        readFileSync(log, "utf8")
          .split("\n")
          .filter((l) => l === "start").length === 3,
    );
    const { out } = cli(["holders"]);
    expect(out).toMatch(/^check leases: 3 of 3 held$/m);
    expect(out.match(/lease \d: \S+: pnpm check \(pid \d+/g)).toHaveLength(3);
    expect(out).toMatch(/^browser leases: 0 of 3 held$/m);

    expect(await Promise.all(runs.map((r) => r.exit))).toEqual([0, 0, 0, 0, 0]);
    expect(runs.filter((r) => r.err.includes("All 3 check leases are taken; waiting"))).toHaveLength(2);
    let running = 0;
    let most = 0;
    for (const line of readFileSync(log, "utf8").split("\n").filter(Boolean)) {
      running += line === "start" ? 1 : -1;
      most = Math.max(most, running);
    }
    expect(most).toBe(3);
  });
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
