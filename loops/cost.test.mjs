// cost.mjs: the pure parser, attribution, merge and summary, and the CLI against a
// temp projects folder (RISA_CLAUDE_PROJECTS) and main checkout (RISA_MAIN). Every
// transcript here is made up.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attribute, mergeRows, parseTranscript, summarise } from "./cost.mjs";
import { projectFolder } from "./host.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const OPUS = "claude-opus-5-5";
const HAIKU = "claude-haiku-5-5";

/** An assistant line of message ID. */
const reply = (id, { model = OPUS, input = 1, output = 2, read = 3, write = 4, branch = "" } = {}) =>
  JSON.stringify({
    type: "assistant",
    ...(branch ? { gitBranch: branch } : {}),
    message: {
      id,
      model,
      role: "assistant",
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: write,
      },
    },
  });
const user = (text, branch = "") =>
  JSON.stringify({
    type: "user",
    ...(branch ? { gitBranch: branch } : {}),
    message: { role: "user", content: text },
  });
const jsonl = (...lines) => `${lines.join("\n")}\n`;

describe("parseTranscript", () => {
  it("counts a message streamed over three lines once, its last line winning", () => {
    const { rows } = parseTranscript(
      jsonl(reply("m1", { output: 1 }), reply("m1", { output: 5 }), reply("m1", { output: 9 })),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "m1",
      model: OPUS,
      input: 1,
      output: 9,
      cacheRead: 3,
      cacheWrite: 4,
    });
  });

  it("counts malformed lines and skips them", () => {
    const p = parseTranscript(jsonl(reply("m1"), "{not json", "", "[1,", reply("m2")));
    expect(p.malformed).toBe(2);
    expect(p.rows.map((r) => r.id)).toEqual(["m1", "m2"]);
  });

  it("keeps the first prompt and branch, and leaves out synthetic replies", () => {
    const p = parseTranscript(
      jsonl(user("go", "prd/t"), reply("m1", { model: "<synthetic>" }), reply("m2")),
      {
        file: "f",
        worktree: "t",
        meta: { description: "t slice 3" },
      },
    );
    expect(p).toMatchObject({ prompt: "go", branch: "prd/t" });
    expect(p.rows).toEqual([
      expect.objectContaining({
        id: "m2",
        file: "f",
        worktree: "t",
        subagent: true,
        description: "t slice 3",
      }),
    ]);
  });
});

describe("attribute", () => {
  const rows = (text, opts) => parseTranscript(text, opts).rows;
  it("goes by description, then prompt, else orchestration; plan- is planning", () => {
    const out = attribute(
      [
        ...rows(jsonl(reply("a")), { worktree: "t", meta: { description: "t slice 2" } }),
        ...rows(jsonl(user("worktree /x/.loops/t-4 is yours"), reply("b")), { worktree: "t", meta: {} }),
        ...rows(jsonl(user("review the diff"), reply("c")), {
          worktree: "t",
          meta: { description: "review" },
        }),
        ...rows(jsonl(reply("d")), { worktree: "t" }),
        ...rows(jsonl(reply("e")), { worktree: "plan-t", meta: { description: "slice 1" } }),
        ...rows(jsonl(reply("f")), { worktree: "t-5" }),
        // Another topic's worktree named in a prompt isn't a slice of this one.
        ...rows(jsonl(user("see .loops/t-2-1"), reply("g")), { worktree: "t", meta: {} }),
      ],
      "t",
    );
    expect(Object.fromEntries(out.map((r) => [r.id, r.line]))).toEqual({
      a: "slice 2",
      b: "slice 4",
      c: "orchestration",
      d: "orchestration",
      e: "planning",
      f: "slice 5",
      g: "orchestration",
    });
    expect(Object.keys(out[0]).sort()).toEqual(
      ["cacheRead", "cacheWrite", "id", "input", "line", "model", "output"].sort(),
    );
  });

  it("keeps a ledger row's line", () => {
    expect(
      attribute(
        [{ id: "x", model: OPUS, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, line: "slice 9" }],
        "t",
      )[0].line,
    ).toBe("slice 9");
  });
});

describe("mergeRows and summarise", () => {
  it("counts a message in a session and its --continue copy once", () => {
    const first = parseTranscript(jsonl(reply("m1"), reply("m2")), { worktree: "t" }).rows;
    const copy = parseTranscript(jsonl(reply("m1"), reply("m2"), reply("m3")), { worktree: "t" }).rows;
    const s = summarise(attribute(mergeRows(first, copy), "t"));
    expect(s.total.messages).toBe(3);
    expect(s.total.models[OPUS]).toEqual({ input: 3, output: 6, cacheRead: 9, cacheWrite: 12 });
  });

  it("keeps one row per id from a ledger and newer transcripts, the newer winning", () => {
    const ledger = [
      { id: "m1", model: OPUS, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, line: "slice 1" },
      { id: "old", model: OPUS, input: 7, output: 0, cacheRead: 0, cacheWrite: 0, line: "planning" },
    ];
    const fresh = attribute(
      parseTranscript(jsonl(reply("m1", { output: 8 }), reply("m2")), { worktree: "t-1" }).rows,
      "t",
    );
    const merged = mergeRows(ledger, fresh);
    expect(merged.map((r) => r.id).sort()).toEqual(["m1", "m2", "old"]);
    expect(merged.find((r) => r.id === "m1")?.output).toBe(8);
  });

  it("totals by model, each line in order", () => {
    const s = summarise([
      { id: "1", model: OPUS, input: 1, output: 1, cacheRead: 1, cacheWrite: 1, line: "slice 10" },
      { id: "2", model: HAIKU, input: 2, output: 2, cacheRead: 2, cacheWrite: 2, line: "slice 2" },
      { id: "3", model: OPUS, input: 3, output: 3, cacheRead: 3, cacheWrite: 3, line: "orchestration" },
      { id: "4", model: HAIKU, input: 4, output: 4, cacheRead: 4, cacheWrite: 4, line: "planning" },
    ]);
    expect(s.lines.map((l) => l.line)).toEqual(["planning", "orchestration", "slice 2", "slice 10"]);
    expect(s.total).toEqual({
      messages: 4,
      models: {
        [OPUS]: { input: 4, output: 4, cacheRead: 4, cacheWrite: 4 },
        [HAIKU]: { input: 6, output: 6, cacheRead: 6, cacheWrite: 6 },
      },
    });
  });
});

describe("cost.mjs report and ledger", () => {
  let root, main, projects, env;
  const folderOf = (worktree) => join(projects, projectFolder(join(main, ".loops", worktree)));
  const put = (path, text) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  };
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [join(HERE, "cost.mjs"), ...args], { encoding: "utf8", env });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    return r.stdout;
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "cost-"));
    main = join(root, "main.repo");
    projects = join(root, "projects");
    mkdirSync(main, { recursive: true });
    env = { ...process.env, RISA_MAIN: main, RISA_CLAUDE_PROJECTS: projects };
    const orch = folderOf("demo");
    // The orchestrator's session and its --continue copy, with a malformed line.
    put(join(orch, "s1.jsonl"), jsonl(user("start", "prd/demo"), reply("o1", { input: 10 }), "{oops"));
    put(
      join(orch, "s2.jsonl"),
      jsonl(user("again", "prd/demo"), reply("o1", { input: 10 }), reply("o2", { input: 5 })),
    );
    // Its subagents: slice 1 by description, slice 2 by prompt, a helper by neither.
    const subs = join(orch, "s1", "subagents");
    put(
      join(subs, "agent-a.jsonl"),
      jsonl(user("brief"), reply("a1", { output: 100 }), reply("a1", { output: 120 })),
    );
    put(join(subs, "agent-a.meta.json"), JSON.stringify({ description: "demo slice 1" }));
    put(
      join(subs, "agent-b.jsonl"),
      jsonl(user(`work in ${main}/.loops/demo-2`), reply("b1", { model: HAIKU, read: 50 })),
    );
    put(join(subs, "agent-b.meta.json"), JSON.stringify({ description: "build it" }));
    put(join(subs, "agent-c.jsonl"), jsonl(user("look around"), reply("c1", { write: 40 })));
    put(join(subs, "agent-c.meta.json"), JSON.stringify({ description: "explore" }));
    // The planner's worktree.
    put(join(folderOf("plan-demo"), "p.jsonl"), jsonl(user("plan", "plan/demo"), reply("p1", { input: 7 })));
    // Another topic whose name is demo-<n>: not demo's slice 3.
    put(join(folderOf("demo-3"), "x.jsonl"), jsonl(user("other", "prd/demo-3"), reply("x1")));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const expected = {
    planning: { [OPUS]: { input: 7, output: 2, cacheRead: 3, cacheWrite: 4 } },
    orchestration: { [OPUS]: { input: 16, output: 6, cacheRead: 9, cacheWrite: 48 } },
    "slice 1": { [OPUS]: { input: 1, output: 120, cacheRead: 3, cacheWrite: 4 } },
    "slice 2": { [HAIKU]: { input: 1, output: 2, cacheRead: 50, cacheWrite: 4 } },
  };
  const byLine = (report) => Object.fromEntries(report.lines.map((l) => [l.line, l.models]));

  it("report --json gives each line's and the total's counts", () => {
    const report = JSON.parse(cli("report", "demo", "--json"));
    expect(byLine(report)).toEqual(expected);
    expect(report.total).toEqual({
      messages: 6,
      models: {
        [OPUS]: { input: 24, output: 128, cacheRead: 15, cacheWrite: 56 },
        [HAIKU]: { input: 1, output: 2, cacheRead: 50, cacheWrite: 4 },
      },
    });
    expect(report.malformed).toBe(1);
    expect(cli("report", "demo")).toMatch(
      /^demo \(6 messages\)\n[\s\S]*slice 2\s+claude-haiku-5-5\s+1\s+2\s+50\s+4/,
    );
  });

  it("with no topic, prints one total line per topic", () => {
    expect(cli("report").trim().split("\n")).toEqual([
      expect.stringMatching(/^demo: 6 messages; claude-haiku-5-5 input 1, /),
      expect.stringMatching(
        /^demo-3: 1 messages; claude-opus-5-5 input 1, output 2, cache read 3, cache write 4$/,
      ),
    ]);
  });

  it("after ledger and the transcripts deleted, report gives the same numbers", () => {
    const before = JSON.parse(cli("report", "demo", "--json"));
    expect(cli("ledger", "demo")).toMatch(/6 messages/);
    expect(existsSync(join(main, ".loops/.cost/demo.json"))).toBe(true);
    for (const w of ["demo", "plan-demo"]) rmSync(folderOf(w), { recursive: true });
    const after = JSON.parse(cli("report", "demo", "--json"));
    expect(byLine(after)).toEqual(byLine(before));
    expect(after.total).toEqual(before.total);
    // A ledger run again with nothing on disk keeps every row.
    cli("ledger", "demo");
    expect(JSON.parse(cli("report", "demo", "--json")).total).toEqual(before.total);
  });
});
