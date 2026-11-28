// The dispatcher's code check between ticks and its re-exec on new code
// (B-809): the loop's pure parts, and dispatch.mjs on dispatch-fixture.mjs's
// throwaway repo.
import { execFileSync, spawn } from "node:child_process";
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
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { codeHash, mainCheckout, lockHolder, runLoop, staleCode } from "./dispatch.mjs";
import {
  HERE,
  main,
  loops,
  env,
  scripts,
  ok,
  dstate,
  logText,
  setRows,
  until,
  useDispatchRepo,
} from "./dispatch-fixture.mjs";

useDispatchRepo();

describe("the code check between ticks (B-809)", () => {
  const STOP = new Error("stop");
  /** Runs the loop with a fake sleep that ends it after TICKS ticks; CODES are the main checkout's hashes. */
  const drive = async (/** @type {(string | null)[]} */ codes, ticks = 3) => {
    let steps = 0;
    let checks = 0;
    const end = runLoop({
      every: 60,
      started: "aaa",
      current: () => codes[Math.min(checks++, codes.length - 1)],
      step: () => void steps++,
      sleep: async () => {
        if (steps >= ticks) throw STOP;
      },
    }).catch((e) => (e === STOP ? "ran on" : Promise.reject(e)));
    return { end: await end, steps, checks };
  };

  it("a changed hash ends the loop between ticks, before the next tick", async () => {
    expect(await drive(["aaa", "bbb"])).toEqual({
      end: { stale: true, from: "aaa", to: "bbb" },
      steps: 2,
      checks: 2,
    });
  });

  it("an unchanged or unreadable hash keeps ticking", async () => {
    expect(await drive(["aaa"])).toEqual({ end: "ran on", steps: 3, checks: 2 });
    expect(await drive([null])).toEqual({ end: "ran on", steps: 3, checks: 2 });
    expect(staleCode(null, "bbb")).toBe(false);
    expect(staleCode("aaa", "aaa")).toBe(false);
    expect(staleCode("aaa", "bbb")).toBe(true);
  });

  it("--once ticks once and never checks", async () => {
    let checks = 0;
    let steps = 0;
    const end = await runLoop({
      every: 60,
      once: true,
      started: "aaa",
      current: () => (checks++, "bbb"),
      step: () => void steps++,
    });
    expect({ end, steps, checks }).toEqual({ end: { stale: false }, steps: 1, checks: 0 });
  });

  // The tool lives outside the project: the repo is the one lib.sh found (RISA_MAIN).
  it("takes the main checkout from RISA_MAIN, else the checkout this file is in", () => {
    const was = process.env.RISA_MAIN;
    try {
      process.env.RISA_MAIN = "/fictional/project";
      expect(mainCheckout()).toBe("/fictional/project");
      delete process.env.RISA_MAIN;
      // The main checkout, even from a linked worktree (a slice's): its common git dir's folder.
      const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
        cwd: HERE,
        encoding: "utf8",
      }).trim();
      expect(mainCheckout()).toBe(dirname(common));
    } finally {
      if (was === undefined) delete process.env.RISA_MAIN;
      else process.env.RISA_MAIN = was;
    }
  });

  it("hashes the non-test .mjs files of loops and backlog", () => {
    const r = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-code-")));
    try {
      expect(codeHash(r)).toBeNull();
      for (const d of ["loops", "backlog"]) mkdirSync(join(r, d), { recursive: true });
      writeFileSync(join(r, "loops/a.mjs"), "1");
      writeFileSync(join(r, "backlog/b.mjs"), "2");
      const h = codeHash(r);
      expect(h).toMatch(/^[0-9a-f]{12}$/);
      for (const f of ["a.test.mjs", "land-fixture.mjs", "notes.md", "x.sh"])
        writeFileSync(join(r, "loops", f), "3");
      expect(codeHash(r)).toBe(h);
      writeFileSync(join(r, "backlog/b.mjs"), "22");
      expect(codeHash(r)).not.toBe(h);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});

describe("re-exec on new code (B-809)", () => {
  it("a landing on the main checkout re-execs the running dispatcher between ticks: same pid and lock, new code", async () => {
    setRows([]);
    const file = scripts("drain.mjs");
    const before = readFileSync(file, "utf8");
    const child = spawn("node", [scripts("dispatch.mjs"), "--every", "1"], {
      cwd: main,
      env,
      stdio: "ignore",
    });
    const exited = new Promise((r) => child.on("exit", (code) => r(code)));
    try {
      await until(() => existsSync(join(loops, ".dispatch.json")) && /started \(pid/.test(logText()));
      const old = dstate().code;
      expect(old).toMatchObject({ hash: codeHash(main), pid: child.pid });
      expect(logText()).not.toContain("re-exec");
      writeFileSync(file, `${before}\n// a landing\n`);
      await until(() => logText().includes("re-exec'd on new code"));
      const now = dstate().code;
      expect(now).toMatchObject({ hash: codeHash(main), pid: child.pid });
      expect(now.hash).not.toBe(old.hash);
      expect(logText()).toContain(`re-exec: the tool's code changed (${old.hash} -> ${now.hash})`);
      expect(logText()).toContain(`re-exec'd on new code ${now.hash} (was ${old.hash}; pid ${child.pid}`);
      expect(lockHolder(join(loops, ".dispatch.lock"))).toBe(child.pid);
      expect(ok(["--stop"])).toContain(`Stopped the dispatcher (pid ${child.pid})`);
      expect(await exited).toBe(0);
    } finally {
      writeFileSync(file, before);
      child.kill("SIGTERM");
    }
  });
});
