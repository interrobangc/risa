// status-trim.mjs: moving finished-wave history out of a plan's _Status_ (B-598).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main, nextSlice, splitBlocks, statusBytes, trimStatus } from "./status-trim.mjs";

const plan = (rows) => `# Plan: Fixes (x)

Topic \`fixes-x\`.

## Status

**Landing mode: run everything through** (land each green wave).

**Hand-off (2026-11-20, after the wave 1 landing).** Wave 1 landed as aaaa1111.

**Wave 1 (2026-11-19, this session).** Slices 1-3 started.

**Hand-off (2026-11-22, after the wave 2 landing).** The latest one.

**Hand-over (2026-11-21, mid-wave).** Open things:

- one open thing
- another

**Wave 3 (2026-11-22).** Slices 4 and 5 started.

**Later waves:** keep this.

- Gotchas: the table's columns stay.

| Slice | Item | State | Merge |
| ----- | ---- | ----- | ----- |
${rows}

## Wave 1

### Slice 1: one (B-1)

### Slice 2: two (B-2)

### Slice 3: three (B-3)

## Wave 2

### Slice 6: six (B-6)

## Wave 3

### Slice 4: four (B-4)

### Slice 5: five (B-5)
`;

const ROWS = [
  "| 1 | B-1 | merged | aaaa1111 |",
  "| 2 | B-2 | merged (note) | bbbb2222 (cafe0001) |",
  "| 3 | B-3 | handed off (no commits) | — |",
  "| 6 | B-6 | done (no commits) | — |",
  "| 4 | B-4 | merged | cccc3333 |",
  "| 5 | B-5 | started (opus) | — |",
].join("\n");
const LANDED = new Set(["aaaa1111", "bbbb2222"]);
const isLanded = (sha) => LANDED.has(sha);
const statusOf = (text) => /^## Status\n([\s\S]*?)(?=^## )/m.exec(text)[1];

describe("trimStatus on a fixes plan", () => {
  const before = plan(ROWS);
  const r = trimStatus(before, { topic: "fixes-x", isLanded, date: "2026-11-24" });
  const status = statusOf(r.plan);

  it("keeps the latest hand-off, the landing mode, the open rows and the other paragraphs", () => {
    expect(status).toContain("**Landing mode: run everything through**");
    expect(status).toContain("The latest one.");
    expect(status).toContain("**Wave 3 (2026-11-22).**");
    expect(status).toContain("**Later waves:** keep this.");
    expect(status).toContain("- Gotchas: the table's columns stay.");
    expect(status).toContain("| 4 | B-4 | merged | cccc3333 |");
    expect(status).toContain("| 5 | B-5 | started (opus) | — |");
    // Wave 2 has no merge SHA and the wave after it hasn't landed: unknown, so it stays.
    expect(status).toContain("| 6 | B-6 | done (no commits) | — |");
    expect(status).toContain("| Slice | Item | State | Merge |");
  });

  it("moves the older hand-offs, the landed waves' paragraphs and rows, and a list after a colon", () => {
    for (const gone of ["after the wave 1 landing", "**Wave 1 (2026-11-19", "Hand-over", "one open thing"])
      expect(status).not.toContain(gone);
    for (const slice of ["| 1 |", "| 2 |", "| 3 |"]) expect(status).not.toContain(slice);
    expect(r.landedWaves).toEqual([1]);
    expect(r.rows).toBe(3);
    expect(r.paragraphs).toBe(4); // two hand-offs, the hand-over's list, Wave 1
  });

  it("writes the history newest first, with the moved rows under the plan's columns", () => {
    const h = r.history;
    expect(h).toMatch(/^# History: fixes-x\n/);
    expect(h).toContain("## Trimmed 2026-11-24");
    const order = ["Hand-over (2026-11-21", "one open thing", "Hand-off (2026-11-20", "Wave 1 (2026-11-19"];
    const at = order.map((s) => h.indexOf(s));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const rows = h.split("\n").filter((l) => l.startsWith("|"));
    expect(rows[0]).toBe("| Slice | Item | State | Merge |");
    expect(rows.slice(2).map((l) => l.split("|")[1].trim())).toEqual(["3", "2", "1"]);
  });

  it("leaves a one-line pointer after the landing mode", () => {
    const blocks = splitBlocks(status);
    expect(blocks[0]).toMatch(/^\*\*Landing mode/);
    expect(blocks[1]).toContain("[`plans/fixes-x-history.md`](fixes-x-history.md)");
    expect(blocks[1].split("\n")).toHaveLength(1);
    expect(statusBytes(r.plan)).toBeLessThan(statusBytes(before));
  });

  it("leaves the plan below _Status_ alone", () => {
    expect(r.plan.slice(r.plan.indexOf("## Wave 1"))).toBe(before.slice(before.indexOf("## Wave 1")));
  });

  it("changes nothing on a rerun", () => {
    const again = trimStatus(r.plan, {
      topic: "fixes-x",
      historyText: r.history,
      isLanded,
      date: "2026-11-25",
    });
    expect(again.plan).toBe(r.plan);
    expect(again.history).toBe(r.history);
    expect(again.paragraphs + again.rows).toBe(0);
  });

  it("keeps the next slice number across the trim", () => {
    expect(nextSlice(before)).toBe(7);
    expect(nextSlice(r.plan, r.history)).toBe(7);
    // With the plan's slices gone, the history's rows still count.
    expect(nextSlice("# P\n\n## Status\n", r.history)).toBe(4);
  });

  it("numbers the next slice past the plan's headings and the history's rows, alone", () => {
    const plan = "# P\n\n## Wave 1\n\n### Slice 2: A\n\n#### Slice 5: B\n";
    const history = "# H\n\n| Slice | What |\n| ----- | ---- |\n| 9 | old |\n| x | not a row |\n";
    expect(nextSlice(plan)).toBe(6);
    expect(nextSlice(plan, history)).toBe(10);
    expect(nextSlice("# P\n", "")).toBe(1);
  });

  it("puts a second trim's section above the first", () => {
    LANDED.add("cccc3333");
    try {
      const next = trimStatus(r.plan, {
        topic: "fixes-x",
        historyText: r.history,
        isLanded,
        date: "2026-11-30",
      });
      expect(next.rows).toBe(2); // slice 4, and 6 now that a later wave landed; 5 is still in flight
      expect(next.landedWaves).toEqual([2, 3]); // wave 1's rows are in the history now
      expect(statusOf(next.plan)).toContain("| 5 | B-5 | started (opus) | — |");
      expect(next.history.indexOf("## Trimmed 2026-11-30")).toBeLessThan(
        next.history.indexOf("## Trimmed 2026-11-24"),
      );
      expect(next.history.match(/^# History/gm)).toHaveLength(1);
      expect(next.plan.match(/fixes-x-history\.md`\]/g)).toHaveLength(1);
    } finally {
      LANDED.delete("cccc3333");
    }
  });
});

describe("trimStatus elsewhere", () => {
  it("moves only hand-offs in a plan that isn't a fixes plan", () => {
    const r = trimStatus(plan(ROWS).replace("fixes-x", "feature"), { topic: "feature", isLanded });
    const status = statusOf(r.plan);
    expect(status).toContain("**Wave 1 (2026-11-19");
    expect(status).toContain("| 1 | B-1 | merged | aaaa1111 |");
    expect(status).not.toContain("after the wave 1 landing");
    expect(status).toContain("The latest one.");
    expect(r.rows).toBe(0);
  });

  it("ranks hand-offs on the same date by the wave they name", () => {
    const text = plan(ROWS)
      .replace("2026-11-20, after the wave 1", "2026-11-22, after the wave 3")
      .replace("2026-11-21, mid-wave", "2026-11-19, mid-wave");
    const status = statusOf(trimStatus(text, { topic: "feature" }).plan);
    expect(status).toContain("after the wave 3 landing");
    expect(status).not.toContain("The latest one.");
  });

  it("does nothing with one hand-off and no landed wave", () => {
    const text = "# P\n\n## Status\n\n**Hand-off (2026-11-24).** Only one.\n\n## Slice 1: a\n";
    const r = trimStatus(text, { topic: "fixes-y" });
    expect(r.plan).toBe(text);
    expect(r.history).toBe("");
  });

  it("keeps a fenced block whole", () => {
    expect(splitBlocks("a\n\n```sh\nx\n\ny\n```\n\nb")).toEqual(["a", "```sh\nx\n\ny\n```", "b"]);
  });
});

describe("the CLI", () => {
  let repo;
  const g = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
  const cli = async (...argv) => {
    const out = [];
    const code = await main([...argv, "--repo", repo], { out: (s) => out.push(s), err: (s) => out.push(s) });
    return { code, out: out.join("\n") };
  };
  const planFile = () => join(repo, "plans", "fixes-x-plan.md");
  const historyFile = () => join(repo, "plans", "fixes-x-history.md");

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "status-trim-"));
    g("init", "-q", "-b", "dev");
    g("config", "user.email", "t@example.com");
    g("config", "user.name", "t");
    mkdirSync(join(repo, "plans"));
    writeFileSync(join(repo, "a"), "1");
    g("add", "-A");
    g("commit", "-q", "-m", "one");
    const landed = g("rev-parse", "--short=8", "HEAD");
    g("checkout", "-q", "-b", "prd/fixes-x");
    writeFileSync(join(repo, "a"), "2");
    g("commit", "-q", "-am", "two");
    const open = g("rev-parse", "--short=8", "HEAD");
    const rows = ROWS.replace("aaaa1111", landed)
      .replace("bbbb2222 (cafe0001)", landed)
      .replace("cccc3333", open);
    writeFileSync(planFile(), plan(rows));
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("a dry run writes nothing", async () => {
    const before = readFileSync(planFile(), "utf8");
    const r = await cli("fixes-x", "--dry-run");
    expect(r.code).toBe(0);
    expect(r.out).toContain("would move 4 paragraph(s) and 3 row(s)");
    expect(readFileSync(planFile(), "utf8")).toBe(before);
    expect(existsSync(historyFile())).toBe(false);
  });

  it("writes both files, formatted, then a rerun changes nothing", async () => {
    const r = await cli("fixes-x", "--date", "2026-11-24", "--base", "dev");
    expect(r.code).toBe(0);
    expect(r.out).toContain("moved 4 paragraph(s) and 3 row(s) to plans/fixes-x-history.md; landed waves 1");
    const plan1 = readFileSync(planFile(), "utf8");
    const history1 = readFileSync(historyFile(), "utf8");
    expect(plan1).toMatch(/^\| 5 {5}\| B-5 {2}\| started \(opus\) +\| — +\|$/m); // Prettier realigned the table
    expect(history1).toContain("## Trimmed 2026-11-24");
    const again = await cli("fixes-x", "--date", "2026-11-25", "--base", "dev");
    expect(again.out).toContain("nothing to move");
    expect(readFileSync(planFile(), "utf8")).toBe(plan1);
    expect(readFileSync(historyFile(), "utf8")).toBe(history1);
  });

  it("--next counts the plan and its history", async () => {
    const r = await cli("fixes-x", "--next");
    expect(r).toEqual({ code: 0, out: "7" });
  });

  it("refuses a missing plan or a bad topic", async () => {
    expect((await cli("nope")).code).toBe(1);
    expect((await cli("Bad Topic")).code).toBe(2);
  });
});
