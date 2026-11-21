// Codex's verdict, from PR states captured from real Codex reviews on GitHub
// (codex-review.fixtures/, cut down to what the verdict reads).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isCodex, verdict, verdictLine } from "./codex-review.mjs";

const CLI = new URL("./codex-review.mjs", import.meta.url).pathname;
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./codex-review.fixtures/${name}.json`, import.meta.url), "utf8"));

describe("codex-review verdict", () => {
  it("is waiting when Codex hasn't touched the PR", () => {
    const v = verdict(fixture("waiting"));
    expect(v).toMatchObject({ state: "waiting", findings: [], reviewedSha: null });
    expect(verdictLine(v)).toBe(`codex: waiting for a review of ${v.headSha.slice(0, 7)}`);
  });

  it("is clean when Codex's summary names the head and no thread of its own is open", () => {
    const pr = fixture("clean");
    const v = verdict(pr);
    expect(v).toMatchObject({
      state: "clean",
      findings: [],
      reviewedSha: pr.headRefOid,
      headSha: pr.headRefOid,
    });
  });

  it("accepts the full GraphQL response as well as the pullRequest node", () => {
    const pr = fixture("clean");
    expect(verdict({ data: { repository: { pullRequest: pr } } }).state).toBe("clean");
  });

  it("knows Codex's login with and without [bot]", () => {
    expect(isCodex("chatgpt-codex-connector")).toBe(true);
    expect(isCodex("chatgpt-codex-connector[bot]")).toBe(true);
    expect(isCodex("someone-else")).toBe(false);
  });

  it("prints JSON, a line or text from the command line", () => {
    const file = new URL("./codex-review.fixtures/clean.json", import.meta.url).pathname;
    expect(JSON.parse(execFileSync("node", [CLI, file], { encoding: "utf8" })).state).toBe("clean");
    expect(execFileSync("node", [CLI, file, "--line"], { encoding: "utf8" })).toBe(
      "codex: clean on fceef73\n",
    );
  });
});
