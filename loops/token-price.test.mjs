// token-price.mjs on fixture transcripts in a throwaway projects folder: every
// reply, model and token count here is made up.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRICES, format, parseArgs, priceOf, readUses, tally } from "./token-price.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const SINCE = Date.parse("2026-11-01");
const CUTOFF = Date.parse("2026-11-10");
const NOW = Date.parse("2026-11-20");
const M = 1_000_000;

/** A transcript line: an assistant reply with this usage. */
const reply = (id, timestamp, model, usage) =>
  JSON.stringify({ type: "assistant", timestamp, requestId: `req-${id}`, message: { id, model, usage } });

let dir;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "token-price-"));
  const project = join(dir, "-fictional-project");
  mkdirSync(join(project, "s1", "subagents"), { recursive: true });
  writeFileSync(
    join(project, "s1.jsonl"),
    [
      JSON.stringify({ type: "user", timestamp: "2026-11-02T00:00:00Z", message: { content: "hi" } }),
      // before: 1M of each kind on Opus 5.5, the write split 5-minute and 1-hour
      reply("m1", "2026-11-02T10:00:00Z", "claude-opus-5-5", {
        input_tokens: M,
        output_tokens: M,
        cache_creation_input_tokens: 2 * M,
        cache_creation: { ephemeral_5m_input_tokens: M, ephemeral_1h_input_tokens: M },
        cache_read_input_tokens: M,
      }),
      // the same reply again (a second content block): counted once
      reply("m1", "2026-11-02T10:00:01Z", "claude-opus-5-5", {
        input_tokens: M,
        output_tokens: M,
        cache_creation_input_tokens: 2 * M,
        cache_creation: { ephemeral_5m_input_tokens: M, ephemeral_1h_input_tokens: M },
        cache_read_input_tokens: M,
      }),
      // just before the cutoff: before
      reply("m2", "2026-11-09T23:59:59Z", "claude-haiku-4-5-20251001", { input_tokens: M }),
      // before --since: left out
      reply("m0", "2026-10-30T00:00:00Z", "claude-opus-5-5", { input_tokens: 50 * M }),
      "not json",
      reply("syn", "2026-11-03T00:00:00Z", "<synthetic>", { input_tokens: M }),
    ].join("\n"),
  );
  writeFileSync(
    join(project, "s1", "subagents", "agent-1.jsonl"),
    [
      // at the cutoff: after; an unsplit write prices as 5-minute
      reply("m3", "2026-11-10T00:00:00Z", "claude-sonnet-5-5", {
        input_tokens: M,
        output_tokens: 2 * M,
        cache_creation_input_tokens: M,
        cache_read_input_tokens: 4 * M,
      }),
      reply("m4", "2026-11-12T00:00:00Z", "claude-unknown-9", { input_tokens: 3 * M }),
    ].join("\n"),
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("token-price", () => {
  it("prices a dated id by its family and leaves an unknown one unpriced", () => {
    expect(priceOf("claude-haiku-4-5-20251001")).toBe(PRICES["claude-haiku-4-5"]);
    expect(priceOf("claude-opus-5-5")).toBe(PRICES["claude-opus-5-5"]);
    expect(priceOf("claude-unknown-9")).toBeNull();
  });

  it("a cache write costs more than the same tokens read, on every model", () => {
    for (const p of Object.values(PRICES)) {
      expect(p.write5m).toBeGreaterThan(p.read);
      expect(p.write1h).toBeGreaterThan(p.write5m);
    }
    const uses = readUses(dir, { since: SINCE }).filter((u) => u.model === "claude-opus-5-5");
    const opus = tally(uses, { cutoff: CUTOFF }).before.models["claude-opus-5-5"];
    expect(opus.tokens.cacheWrite).toBeGreaterThan(opus.tokens.cacheRead);
    expect(opus.cost.cacheWrite / opus.tokens.cacheWrite).toBeGreaterThan(
      opus.cost.cacheRead / opus.tokens.cacheRead,
    );
  });

  it("splits at the cutoff and totals match the table's prices by kind", () => {
    const uses = readUses(dir, { since: SINCE });
    expect(uses).toHaveLength(4);
    const t = tally(uses, { cutoff: CUTOFF });
    const opus = PRICES["claude-opus-5-5"];
    const haiku = PRICES["claude-haiku-4-5"];
    const sonnet = PRICES["claude-sonnet-5-5"];

    expect(t.before.replies).toBe(2);
    expect(Object.keys(t.before.models).sort()).toEqual(["claude-haiku-4-5-20251001", "claude-opus-5-5"]);
    expect(t.before.cost.input).toBeCloseTo(opus.input + haiku.input);
    expect(t.before.cost.output).toBeCloseTo(opus.output);
    expect(t.before.cost.cacheWrite).toBeCloseTo(opus.write5m + opus.write1h);
    expect(t.before.cost.cacheRead).toBeCloseTo(opus.read);
    expect(t.before.tokens).toEqual({ input: 2 * M, output: M, cacheWrite: 2 * M, cacheRead: M });

    expect(t.after.replies).toBe(2);
    expect(t.after.cost.input).toBeCloseTo(sonnet.input);
    expect(t.after.cost.output).toBeCloseTo(2 * sonnet.output);
    expect(t.after.cost.cacheWrite).toBeCloseTo(sonnet.write5m);
    expect(t.after.cost.cacheRead).toBeCloseTo(4 * sonnet.read);
    expect(t.after.models["claude-unknown-9"]).toMatchObject({ priced: false, cost: { input: 0 } });
    expect(t.after.tokens.input).toBe(4 * M);

    const text = format(t, { since: SINCE, cutoff: CUTOFF, now: NOW });
    expect(text).toMatch(/^before \(2026-11-01 to 2026-11-10, 9\.0 days, 2 replies\)/m);
    expect(text).toContain("claude-unknown-9 (unpriced)");
    expect(text).toMatch(/share of cost/);
  });

  it("parses its arguments and runs as a script", () => {
    expect(() => parseArgs(["--since", "2026-11-10", "--cutoff", "2026-11-01"])).toThrow(/after/);
    expect(() => parseArgs(["--bogus", "x"])).toThrow(/unknown argument/);
    expect(
      parseArgs(["--since", "2026-11-01", "--cutoff", "2026-11-10"], { RISA_CLAUDE_PROJECTS: dir }).dir,
    ).toBe(dir);
    const r = spawnSync(
      process.execPath,
      [join(HERE, "token-price.mjs"), "--since", "2026-11-01", "--cutoff", "2026-11-10", "--dir", dir],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/claude-opus-5-5/);
    expect(r.stdout).toMatch(/change per day/);
  });
});
