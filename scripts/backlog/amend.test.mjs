import { describe, expect, it } from "vitest";
import { WINDOW_MS, amendedMessage, idList, parseMessage, shouldAmend, writeMessage } from "./amend.mjs";

const NOW = 1_800_000_000_000;
/** Every guard holds. @type {import("./amend.mjs").AmendFacts} */
const OK = {
  trailer: true,
  singleParent: true,
  onlyBacklogFiles: true,
  rewritten: false,
  commitTime: NOW - 60_000,
  now: NOW,
  containedElsewhere: false,
  moved: false,
  referenced: false,
};

describe("shouldAmend", () => {
  it("amends when every guard holds", () => {
    expect(shouldAmend(OK)).toBe("amend");
  });

  it.each([
    ["no trailer", { trailer: false }],
    ["HEAD older than 10 minutes", { commitTime: NOW - 11 * 60_000 }],
    ["HEAD exactly 10 minutes old", { commitTime: NOW - WINDOW_MS }],
    ["HEAD in the future", { commitTime: NOW + 60_000 }],
    ["HEAD contained by another local branch", { containedElsewhere: true }],
    ["HEAD contained by a remote-tracking ref", { containedElsewhere: true }],
    ["HEAD moved since the read", { moved: true }],
    ["a merge commit", { singleParent: false }],
    ["HEAD changes other files", { onlyBacklogFiles: false }],
    ["HEAD rewritten by hand", { rewritten: true }],
    ["an item's commit names HEAD", { referenced: true }],
  ])("makes a new commit: %s", (_why, change) => {
    expect(shouldAmend({ ...OK, ...change })).toBe("new");
  });

  it("makes a new commit when a fact is missing", () => {
    for (const key of Object.keys(OK)) {
      const facts = { ...OK };
      delete facts[key];
      expect(shouldAmend(facts), key).toBe("new");
    }
  });
});

describe("messages", () => {
  const first = { tool: "note", ids: ["B-1"], text: "B-1: note", lines: ["By: prd/x"] };
  const second = {
    tool: "set",
    ids: ["B-2", "B-1"],
    text: "B-2, B-1: set prd=y",
    lines: ["By: dev keeper", "Statuses from git: B-5 ready → landed."],
  };

  it("shortens id lists past three", () => {
    expect(idList(["B-1"])).toBe("B-1");
    expect(idList(["B-1", "B-2", "B-3"])).toBe("B-1, B-2, B-3");
    expect(idList(["B-1", "B-2", "B-3", "B-4", "B-5"])).toBe("B-1, B-2, B-3 +2");
  });

  it("a single write ends with the tool's trailers", () => {
    expect(writeMessage(first)).toBe(
      "chore(backlog): B-1: note\n\nBy: prd/x\n\nBacklog-Tool: note\nBacklog-Ids: B-1",
    );
    expect(writeMessage({ tool: "refresh", ids: [], text: "refresh", lines: ["By: x"] })).toBe(
      "chore(backlog): refresh\n\nBy: x\n\nBacklog-Tool: refresh",
    );
  });

  it("reads back only the tool's commits as backlog commits", () => {
    expect(parseMessage(writeMessage(first))).toMatchObject({
      backlog: true,
      tools: ["note"],
      ids: ["B-1"],
      blocks: ["B-1: note\nBy: prd/x"],
    });
    expect(parseMessage("chore(backlog): by hand\n\nedited it").backlog).toBe(false);
    expect(parseMessage("feat(x): y\n\nBacklog-Tool: note").backlog).toBe(false);
    expect(parseMessage("chore(backlog): x\n\nBacklog-Tool: note\nSigned-off-by: me").backlog).toBe(false);
  });

  it("folds writes together: every id in the subject, each write's lines in the body", () => {
    const two = amendedMessage(writeMessage(first), second);
    expect(two).toBe(
      [
        "chore(backlog): B-1, B-2: note, set",
        "",
        "B-1: note",
        "By: prd/x",
        "",
        "B-2, B-1: set prd=y",
        "By: dev keeper",
        "Statuses from git: B-5 ready → landed.",
        "",
        "Backlog-Tool: note",
        "Backlog-Tool: set",
        "Backlog-Ids: B-1, B-2",
      ].join("\n"),
    );
    const three = amendedMessage(two, {
      tool: "note",
      ids: ["B-3", "B-4"],
      text: "B-3, B-4: note",
      lines: ["By: z"],
    });
    expect(three.split("\n")[0]).toBe("chore(backlog): B-1, B-2, B-3 +1: note, set");
    expect(parseMessage(three)).toMatchObject({
      tools: ["note", "set", "note"],
      ids: ["B-1", "B-2", "B-3", "B-4"],
    });
    expect(parseMessage(three).blocks).toHaveLength(3);
  });
});
