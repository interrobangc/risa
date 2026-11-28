// `pnpm prd down` when the dispatcher won't stop (down.sh): it stops nothing else,
// keeps the record and says how to retry; the retry stops them all. The throwaway
// repo and fakes are recover-fixture.mjs's.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { calls, put, main, loops, env, state, useRecoverRepo } from "./recover-fixture.mjs";

describe("down when the dispatcher won't stop", () => {
  useRecoverRepo();
  const record = () => join(loops, ".down.json");
  const lock = () => join(loops, ".dispatch.lock");
  const effects = () =>
    calls()
      .split("\n")
      .filter((l) => /^(stack (start|stop) |test-db (up|down)( |$)|serve )/.test(l))
      .map((l) => l.replace(/ \(record\)$/, ""));
  /** A stand-in dispatcher (not this test's child), its pid in the lock; `stubborn` ignores TERM. */
  const dispatcher = (stubborn) => {
    const code = `${stubborn ? "process.on('SIGTERM', () => {}); " : ""}setInterval(() => {}, 1000)`;
    const pid = Number(
      execFileSync(
        "bash",
        ["-c", `"${process.execPath}" -e "${code}" </dev/null >/dev/null 2>&1 & echo $!`],
        {
          encoding: "utf8",
        },
      ).trim(),
    );
    writeFileSync(lock(), `${pid}\n`);
    return pid;
  };
  const down = () =>
    spawnSync("bash", [join(main, "loops/prd.sh"), "down"], {
      cwd: main,
      encoding: "utf8",
      env: { ...env, RISA_DISPATCH_STOP_SECS: "0.5" },
    });
  const allUp = () => {
    put("running", "sample-loop1\nsample-loop2\nsample-loop3\n");
    put("testdb-up", "");
    put("listen", "6173\n6273\n");
  };

  it("stops nothing else, keeps the record and says how to retry", async () => {
    allUp();
    const pid = dispatcher(true);
    try {
      // Let it install its TERM handler before down sends TERM.
      await new Promise((r) => setTimeout(r, 500));
      const r = down();
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(`couldn't stop the dispatcher (pid ${pid})`);
      expect(r.stderr).toMatch(/stopped nothing else.*record stays.*then pnpm prd down/);
      expect(effects()).toEqual([]);
      expect(readFileSync(join(state, "running"), "utf8")).toBe("sample-loop1\nsample-loop2\nsample-loop3\n");
      expect(existsSync(join(state, "testdb-up"))).toBe(true);
      expect(readFileSync(join(state, "listen"), "utf8")).toBe("6173\n6273\n");
      expect(JSON.parse(readFileSync(record(), "utf8"))).toMatchObject({
        stacks: ["t", "t-1", "t-2"],
        servers: ["t", "t-2"],
        testDb: true,
        dispatcher: true,
      });
    } finally {
      process.kill(pid, "SIGKILL");
      rmSync(lock(), { force: true });
    }
  });

  it("the retry, with a dispatcher that stops, stops them all", () => {
    const pid = dispatcher(false);
    const r = down();
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`stopped the dispatcher (pid ${pid})`);
    expect(effects()).toEqual([
      "serve t --stop",
      "serve t-2 --stop",
      "stack stop t",
      "stack stop t-1",
      "stack stop t-2",
      "test-db down",
    ]);
    expect(readFileSync(join(state, "running"), "utf8")).toBe("");
    expect(existsSync(join(state, "testdb-up"))).toBe(false);
    expect(JSON.parse(readFileSync(record(), "utf8"))).toMatchObject({ testDb: true, dispatcher: true });
  });
});
