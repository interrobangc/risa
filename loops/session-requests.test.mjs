// Named backlog sessions on request (session-requests.mjs): the store, the pure
// decision and the command, against temporary folders. All text is fictional.
import { spawnSync } from "node:child_process";
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
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ROTATING_GRACE_MS } from "./dispatch-pick.mjs";
import { START_GRACE_MS } from "./keep-alive.mjs";
import { MAX_TEXT, raiseSeq, readSeq } from "./notices.mjs";
import {
  KEEP_SETTLED_MS,
  backlogRemoteOf,
  createRequest,
  pendingPart,
  readRequests,
  requestDecision,
  requestNotice,
  settleRequest,
  validName,
} from "./session-requests.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const NOW = Date.parse("2026-11-22T12:00:00Z");
let root, dir;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "session-requests-")));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  dir = join(root, "requests");
  rmSync(dir, { recursive: true, force: true });
});

const req = (id, name, extra = {}) => ({
  id,
  kind: "backlog",
  name,
  session: `backlog-${name}`,
  remote: `backlog - ${name}`,
  model: "opus",
  brief: null,
  from: null,
  requestedAt: new Date(NOW - 60_000).toISOString(),
  state: "pending",
  ...extra,
});
const live = (name, extra = {}) => ({ name, kind: "backlog", live: true, ...extra });
const decide = (facts) => requestDecision({ processes: [], now: NOW, ...facts });

describe("names and process lines", () => {
  it("takes lowercase words and dashes only", () => {
    for (const n of ["reminders", "sort-the-labels", "b2"]) expect(validName(n)).toBe(true);
    for (const n of ["", "Caps", "a b", "-a", "a-", "a--b", "a_b", "a/b", "x".repeat(41)])
      expect(validName(n)).toBe(false);
  });

  it("reads a claude process's backlog Remote Control name", () => {
    expect(backlogRemoteOf("claude --remote-control backlog You are")).toBe("backlog");
    expect(backlogRemoteOf("claude --remote-control backlog - tasks You are")).toBe("backlog-tasks");
    expect(backlogRemoteOf("claude --remote-control=backlog-tasks You are")).toBe("backlog-tasks");
    expect(backlogRemoteOf("claude --remote-control prd-a You are")).toBeNull();
    expect(backlogRemoteOf("vim --remote-control backlog")).toBeNull();
    expect(backlogRemoteOf("claude You could pass `--remote-control backlog`")).toBeNull();
  });

  it("reads a captain's Remote Control name as the main backlog session's", () => {
    expect(backlogRemoteOf("claude --model opus --remote-control Picard You are")).toBe("backlog");
    expect(backlogRemoteOf("claude --remote-control=Kirk")).toBe("backlog");
    expect(backlogRemoteOf("claude --remote-control Picardy You are")).toBeNull();
    expect(backlogRemoteOf("vim --remote-control Picard")).toBeNull();
  });
});

describe("the store", () => {
  it("files requests with fresh ids, copying the brief in", () => {
    const brief = join(root, "brief.md");
    writeFileSync(brief, "Fictional brief.\n");
    const a = createRequest(dir, { name: "one", brief, from: "backlog", now: NOW });
    const b = createRequest(dir, { name: "two", now: NOW });
    expect([a.id, b.id]).toEqual(["r1", "r2"]);
    expect(a).toMatchObject({
      session: "backlog-one",
      remote: "backlog - one",
      model: "opus",
      from: "backlog",
      state: "pending",
    });
    expect(a.brief).not.toBe(brief);
    expect(readFileSync(a.brief, "utf8")).toBe("Fictional brief.\n");
    expect(readRequests(dir).map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("refuses a bad name or model", () => {
    expect(() => createRequest(dir, { name: "Bad Name" })).toThrow(/lowercase/);
    expect(() => createRequest(dir, { name: "ok", model: "a b" })).toThrow(/not a model/);
  });

  it("drops a request and its brief a day after it settled, and never reuses its id", () => {
    const brief = join(root, "brief.md");
    writeFileSync(brief, "Fictional brief.\n");
    const a = createRequest(dir, { name: "one", brief, now: NOW });
    settleRequest(dir, a.id, { state: "opened", now: NOW });
    const later = NOW + KEEP_SETTLED_MS + 1000;
    const b = createRequest(dir, { name: "two", now: later });
    expect(b.id).toBe("r2");
    expect(existsSync(a.brief)).toBe(false);
    expect(readRequests(dir).map((r) => r.id)).toEqual(["r2"]);
  });

  it("keeps the mark at the higher id when a lower raise lands last", () => {
    // Two requests filed together: r2's raise finishes first, then r1's lands
    // late (the check-then-rename used to leave .seq at 1 here, and r2 reused).
    const a = createRequest(dir, { name: "one", now: NOW });
    const b = createRequest(dir, { name: "two", now: NOW });
    expect([a.id, b.id]).toEqual(["r1", "r2"]);
    raiseSeq(dir, 1);
    expect(readSeq(dir)).toBe(2);
    for (const r of [a, b]) settleRequest(dir, r.id, { state: "opened", now: NOW });
    expect(createRequest(dir, { name: "three", now: NOW + KEEP_SETTLED_MS + 1000 }).id).toBe("r3");
    expect(readRequests(dir).map((r) => r.id)).toEqual(["r3"]);
  });

  it("carries an old .seq file over", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".seq"), "7\n");
    expect(createRequest(dir, { name: "after-the-old-mark", now: NOW }).id).toBe("r8");
    expect(existsSync(join(dir, ".seq"))).toBe(false);
    expect(readSeq(dir)).toBe(8);
  });

  // Worker threads held at one barrier (Atomics, no sleeps), then all running
  // `task` together: (module, data) => result, data being one of `inputs`.
  const atBarrier = async (/** @type {string} */ task, /** @type {unknown[]} */ inputs) => {
    const go = new Int32Array(new SharedArrayBuffer(4));
    const modules = {
      requests: new URL("./session-requests.mjs", import.meta.url).href,
      notices: new URL("./notices.mjs", import.meta.url).href,
    };
    const code = `
      const { parentPort, workerData } = require("node:worker_threads");
      Promise.all([import(workerData.modules.requests), import(workerData.modules.notices)]).then(([requests, notices]) => {
        parentPort.postMessage("ready");
        Atomics.wait(workerData.go, 0, 0);
        parentPort.postMessage({ result: (${task})({ ...requests, ...notices }, workerData.data) });
      });
    `;
    const workers = inputs.map((data) => new Worker(code, { eval: true, workerData: { modules, go, data } }));
    try {
      const ready = workers.map((w) => new Promise((resolve) => w.once("message", resolve)));
      const results = workers.map(
        (w) =>
          new Promise((resolve, reject) => {
            w.on("error", reject);
            w.on("message", (m) => m?.result !== undefined && resolve(m.result));
          }),
      );
      await Promise.all(ready);
      Atomics.store(go, 0, 1);
      Atomics.notify(go, 0);
      return await Promise.all(results);
    } finally {
      await Promise.all(workers.map((w) => w.terminate()));
    }
  };

  it("never reuses an id or lowers the mark when requests are filed at once", async () => {
    const WORKERS = 8;
    const EACH = 5;
    const inputs = Array.from({ length: WORKERS }, (_, n) => ({ dir, n, each: EACH, now: NOW }));
    const ids = (
      await atBarrier(
        `({ createRequest }, { dir, n, each, now }) =>
          Array.from({ length: each }, (_, i) => createRequest(dir, { name: "w" + n + "-" + i, now }).id)`,
        inputs,
      )
    ).flat();
    const total = WORKERS * EACH;
    expect(new Set(ids).size).toBe(total);
    expect(readSeq(dir)).toBe(total);
    for (const r of readRequests(dir)) settleRequest(dir, r.id, { state: "opened", now: NOW });
    expect(createRequest(dir, { name: "later", now: NOW + KEEP_SETTLED_MS + 1000 }).id).toBe(`r${total + 1}`);
  });

  it("keeps the highest mark when raises in every order run at once", async () => {
    // Each worker raises the same marks in its own order, so lower raises land
    // after higher ones on every thread.
    mkdirSync(dir, { recursive: true });
    const marks = Array.from({ length: 20 }, (_, i) => i + 1);
    const orders = [
      marks,
      [...marks].reverse(),
      ...[3, 7, 11, 13, 17, 19].map((k) => marks.map((_, i) => ((i * k) % 20) + 1)),
    ];
    await atBarrier(
      `({ raiseSeq }, { dir, order }) => { for (const n of order) raiseSeq(dir, n); return true; }`,
      orders.map((order) => ({ dir, order })),
    );
    expect(readSeq(dir)).toBe(20);
    expect(createRequest(dir, { name: "next", now: NOW }).id).toBe("r21");
  });

  it("status lists only the pending ones", () => {
    expect(pendingPart(dir)).toBe("");
    const a = createRequest(dir, { name: "one", now: NOW });
    createRequest(dir, { name: "two", now: NOW });
    settleRequest(dir, a.id, { state: "refused", why: "fictional", now: NOW });
    const part = pendingPart(dir);
    expect(part).toContain("SESSION REQUESTS: 1 pending");
    expect(part).toContain("backlog - two");
    expect(part).not.toContain("backlog - one");
  });
});

describe("the decision", () => {
  it("takes the oldest pending request", () => {
    const d = decide({ requests: [req("r1", "old"), req("r2", "new")] });
    expect(d).toMatchObject({ action: "open", request: { id: "r1" } });
  });

  it("skips settled requests: an opened or refused one is never taken again", () => {
    const requests = [
      req("r1", "a", { state: "opened", doneAt: new Date(NOW - 3_600_000).toISOString() }),
      req("r2", "b", { state: "refused", doneAt: new Date(NOW).toISOString() }),
    ];
    expect(decide({ requests }).action).toBe("none");
    expect(decide({ requests: [...requests, req("r3", "c")] })).toMatchObject({ request: { id: "r3" } });
  });

  it("paused, or an unreadable process list, takes nothing", () => {
    const requests = [req("r1", "a")];
    expect(decide({ requests, paused: true })).toEqual({ action: "none", why: "the dispatcher is paused" });
    expect(decide({ requests, processes: null }).action).toBe("none");
  });

  it("refuses a live name: recorded, rotating, by hand, or just opened", () => {
    const requests = [req("r2", "a")];
    const refused = { action: "refuse", why: "`backlog - a` is already live" };
    expect(decide({ requests, sessions: [live("backlog-a")] })).toMatchObject(refused);
    expect(
      decide({
        requests,
        sessions: [live("backlog-a", { live: false, rotating: true, rotatingAt: NOW - 1000 })],
      }),
    ).toMatchObject(refused);
    expect(decide({ requests, processes: ["claude --remote-control backlog - a Hi"] })).toMatchObject(
      refused,
    );
    const opened = req("r1", "a", { state: "opened", doneAt: new Date(NOW - 1000).toISOString() });
    expect(decide({ requests: [opened, ...requests] })).toMatchObject(refused);
  });

  it("a name is free again once its session ended, its rotation expired or its start grace passed", () => {
    const requests = [req("r2", "a")];
    expect(decide({ requests, sessions: [live("backlog-a", { live: false })] }).action).toBe("open");
    expect(
      decide({
        requests,
        sessions: [
          live("backlog-a", { live: false, rotating: true, rotatingAt: NOW - ROTATING_GRACE_MS - 1 }),
        ],
      }).action,
    ).toBe("open");
    const opened = req("r1", "a", {
      state: "opened",
      doneAt: new Date(NOW - START_GRACE_MS - 1).toISOString(),
    });
    expect(decide({ requests: [opened, ...requests] }).action).toBe("open");
  });

  it("the limit counts every live backlog-kind session, default and by hand included", () => {
    const requests = [req("r1", "new")];
    const facts = {
      requests,
      max: 3,
      sessions: [live("backlog"), live("backlog-x"), { name: "prd-a", kind: "prd", live: true }],
    };
    expect(decide(facts).action).toBe("open");
    const full = decide({ ...facts, processes: ["claude --remote-control backlog - byhand Hi"] });
    expect(full).toMatchObject({ action: "refuse", why: "3 backlog sessions are live, the limit is 3" });
  });

  it("counts a record and its own process once, and a second process under one name twice", () => {
    const requests = [req("r1", "new")];
    const sessions = [live("backlog")];
    const one = ["claude --remote-control backlog Hi"];
    expect(decide({ requests, sessions, processes: one, max: 2 }).action).toBe("open");
    expect(decide({ requests, sessions, processes: [...one, ...one], max: 2 }).action).toBe("refuse");
  });

  it("tells a captain-named main session from backlog-<name> ones: its record and process count once", () => {
    const requests = [req("r1", "new")];
    const captain = ["claude --remote-control Riker Hi"];
    // Its process alone holds backlog, so it counts toward the limit, not as a request's name.
    expect(decide({ requests, processes: captain, max: 1 })).toMatchObject({
      action: "refuse",
      why: "1 backlog sessions are live, the limit is 1",
    });
    expect(decide({ requests, sessions: [live("backlog")], processes: captain, max: 2 }).action).toBe("open");
    // It never holds a backlog-<name>: a request beside it opens.
    expect(decide({ requests: [req("r2", "riker")], processes: captain, max: 3 }).action).toBe("open");
  });

  it("a session still starting counts toward the limit", () => {
    const d = decide({ requests: [req("r1", "new")], starting: ["backlog"], max: 1 });
    expect(d).toMatchObject({ action: "refuse", why: "1 backlog sessions are live, the limit is 1" });
  });

  it("words the notice both ways", () => {
    expect(requestNotice(req("r1", "a", { from: "backlog" }), { opened: true })).toBe(
      "request r1 (for backlog): opened `backlog - a`",
    );
    expect(requestNotice(req("r1", "a"), { opened: false, why: "fictional" })).toBe(
      "request r1: `backlog - a` not opened: fictional",
    );
  });

  it("keeps a notice with long names and a long error within the board, with its id and outcome", () => {
    const name = "x".repeat(40);
    const from = `backlog-${"y".repeat(40)}`;
    const why = `its tab didn't open (${"fictional opener error ".repeat(12)})`;
    const refused = requestNotice(req("r12", name, { from }), { opened: false, why });
    expect(refused.length).toBeLessThanOrEqual(MAX_TEXT);
    expect(refused).toMatch(
      /^request r12 \(for backlog-y+…?\): `backlog - x+…?` not opened: its tab didn't open/,
    );
    expect(refused).toMatch(/…$/);
    const opened = requestNotice(req("r12", name, { from }), { opened: true });
    expect(opened.length).toBeLessThanOrEqual(MAX_TEXT);
    expect(opened).toMatch(/^request r12 \(for backlog-y+…?\): opened `backlog - x+…?`$/);
    // Even a requester's name past the board alone leaves the id and the outcome.
    const huge = requestNotice(req("r12", name, { from: "z".repeat(400) }), {
      opened: false,
      why: "\n".repeat(3) + why,
    });
    expect(huge.length).toBeLessThanOrEqual(MAX_TEXT);
    expect(huge).toMatch(/^request r12 \(for z+…\): `backlog - x+…?` not opened: its tab/);
  });
});

describe("the command", () => {
  const cli = (...args) =>
    spawnSync("node", [join(HERE, "session-requests.mjs"), ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        RISA_REQUESTS_DIR: dir,
        RISA_SESSIONS_DIR: join(root, "no-sessions"),
      },
    });

  it("files a good name, prints its id, and lists it as JSON", () => {
    const r = cli("request", "backlog", "reminders", "--model", "sonnet");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("r1");
    const [listed] = JSON.parse(cli("requests", "--json").stdout);
    expect(listed).toMatchObject({
      id: "r1",
      session: "backlog-reminders",
      model: "sonnet",
      state: "pending",
    });
    expect(cli("requests").stdout).toContain("r1  pending  backlog - reminders");
  });

  it("files a brief", () => {
    const brief = join(root, "cli-brief.md");
    writeFileSync(brief, "Fictional brief.\n");
    expect(cli("request", "backlog", "one", "--brief", brief).status).toBe(0);
    expect(readFileSync(readRequests(dir)[0].brief, "utf8")).toBe("Fictional brief.\n");
  });

  it("refuses a bad name, an unreadable or empty brief, another kind and bad options, filing nothing", () => {
    const empty = join(root, "empty.md");
    writeFileSync(empty, "  \n");
    mkdirSync(dir, { recursive: true });
    for (const args of [
      ["request", "backlog", "Bad Name"],
      ["request", "backlog", "ok", "--brief", join(root, "missing.md")],
      ["request", "backlog", "ok", "--brief", empty],
      ["request", "hotfix", "ok"],
      ["request", "backlog", "ok", "--nope", "x"],
      ["request", "backlog"],
      ["nonsense"],
    ]) {
      const r = cli(...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr).toContain("pnpm prd:");
    }
    expect(readRequests(dir)).toEqual([]);
  });

  it("lists a settled request's failed notice", () => {
    const r = createRequest(dir, { name: "quiet", now: Date.now() });
    settleRequest(dir, r.id, { state: "opened", noticeFailed: "a fictional board error" });
    expect(cli("requests").stdout).toContain(
      `${r.id}  opened  backlog - quiet  from -, ${r.requestedAt} (its notice failed: a fictional board error)`,
    );
  });

  it("says nothing is pending", () => {
    expect(cli("requests").stdout.trim()).toBe("No session requests.");
  });
});
