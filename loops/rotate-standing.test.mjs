// `pnpm prd rotate` on a standing topic (RISA-952): its close when nothing
// runnable waits, against rotate-fixture.mjs's throwaway repo and stub claude.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASE, scaledWait } from "./test-limits.mjs";
import {
  git,
  plan,
  MERGED,
  main,
  loops,
  state,
  scripts,
  stubPid,
  run,
  backlog,
  start,
  until,
  liveSession,
  useRotateRepo,
} from "./rotate-fixture.mjs";

// The limits follow the load as this file starts, not only as the run did (RISA-994).
vi.setConfig({ testTimeout: scaledWait(BASE.testTimeout), hookTimeout: scaledWait(BASE.hookTimeout) });
useRotateRepo();

describe("pnpm prd rotate on a standing topic (RISA-952)", () => {
  const registry = (items = "") => `# Backlog tracker

Intro.

## PRDs

| PRD | Flags | After | Hot files | Doc and notes |
| --- | ----- | ----- | --------- | ------------- |
| \`fx\` | standing | — | — | a fixes topic |
| \`fy\` | standing | — | — | another fixes topic |
| \`w\` | — | — | — | a PRD |

## Items
${items}`;
  const item = (id, prd, status = "triaged", owner = "") => `
### ${id} · bug · Something

- status: ${status}
- prd: ${prd}
${owner ? `- owner: ${owner}\n` : ""}`;
  const fxDir = () => join(loops, "fx");
  const setUp = (items) => {
    writeFileSync(join(main, "plans/backlog.md"), registry(items));
    writeFileSync(join(main, "plans/fx-plan.md"), plan(MERGED));
    git(main, "add", "plans");
    git(main, "commit", "-q", "-m", "chore: registry");
    git(main, "worktree", "add", "-q", "-b", "prd/fx", fxDir(), "dev");
  };
  const fxSession = async () => {
    const s = start(
      "bash",
      [scripts("session.sh"), "prd-fx", "--", "x"],
      { STUB_MODE: "wait", STUB_NAME: "prd-fx" },
      fxDir(),
    );
    await until(() => existsSync(join(state, "ready")));
    return { s, pid: stubPid() };
  };
  // Two lanes: w's worktree (the other tests') takes one, fx the other.
  const caps = { RISA_MAX_PRDS: "2", RISA_FIXES_MIN: "" };
  afterEach(() => {
    if (existsSync(fxDir())) git(main, "worktree", "remove", "--force", fxDir());
    if (git(main, "branch", "--list", "prd/fx")) git(main, "branch", "-D", "prd/fx");
    git(main, "rm", "-q", "plans/backlog.md", "plans/fx-plan.md");
    git(main, "commit", "-q", "-m", "chore: no registry");
  });

  it(
    "closes one whose waiting items are all blocked: rm runs, its session ends, none opens",
    async () => {
      // Landed (nothing past dev), one item, and fy (four) would take the lane.
      setUp(idle());
      const { s } = await fxSession();
      const r = run("prd.sh", ["rotate", "fx"], caps);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(
        "Closing prd-fx instead of rotating: 1 waiting, under 3, and fy would start in its lane",
      );
      expect(r.stdout).toContain("Removed fx");
      expect(r.stdout).not.toContain("Rotating prd-fx");
      expect(r.stdout).not.toContain("rotate-into.sh");
      expect((await s.done).code).toBe(143);
      expect(existsSync(fxDir())).toBe(false);
      // rm leaves a standing row standing, not done.
      expect(JSON.parse(backlog("prd", "list", "--json")).find((x) => x.topic === "fx").flags).toEqual([
        "standing",
      ]);
    },
    scaledWait(60_000),
  );

  it("rotates one with a runnable item as now", async () => {
    setUp(["B-1", "B-2", "B-3"].map((id) => item(id, "fx")).join(""));
    const { s, pid } = await fxSession();
    const r = run("prd.sh", ["rotate", "fx"], caps);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Rotating prd-fx: pid ${pid} (from its record).`);
    expect(r.stdout).not.toContain("Closing");
    expect(existsSync(fxDir())).toBe(true);
    process.kill(pid, "SIGTERM");
    await s.done;
  });

  /** Nothing runnable: one item while fy (four) would take the lane. */
  const idle = () => item("B-1", "fx") + ["B-2", "B-3", "B-4", "B-5"].map((id) => item(id, "fy")).join("");
  const rotatesAsNow = async (args) => {
    const { s, pid } = await fxSession();
    const r = run("prd.sh", ["rotate", "fx", ...args], caps);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Rotating prd-fx: pid ${pid} (from its record)`);
    expect(r.stdout).not.toContain("Closing");
    expect(existsSync(fxDir())).toBe(true);
    process.kill(pid, "SIGTERM");
    await s.done;
  };

  it("rotates mid-wave as now, though nothing runnable waits", async () => {
    setUp(idle());
    await rotatesAsNow(["--mid-wave", "--reason", "context"]);
  });

  it("rotates as now while the branch has code past its last landing", async () => {
    setUp(idle());
    writeFileSync(join(fxDir(), "fix.mjs"), "export {};\n");
    git(fxDir(), "add", "fix.mjs");
    git(fxDir(), "commit", "-q", "-m", "fix(fx): a slice's merge, not landed");
    await rotatesAsNow([]);
  });

  it("rotates as now while its wave's items are claimed in-progress, though none waits", async () => {
    setUp(item("B-1", "fx", "in-progress", "prd/fx"));
    await rotatesAsNow([]);
  });

  it("rotates a non-standing topic as now, with the registry there", async () => {
    setUp("");
    const { s, pid } = await liveSession();
    const r = run("prd.sh", ["rotate", "w"], caps);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Rotating prd-w: pid ${pid} (from its record).`);
    expect(r.stderr).toBe("");
    process.kill(pid, "SIGTERM");
    await s.done;
  });
});
