// ci-io.mjs: part of `pnpm prd ci` (ci.mjs has the map). The exit codes, the
// shared types (Io, Run, Board, Cache) and the real Io: git and gh, the notice
// board, the status cache, the backlog's locked write and the terminal. Tests
// pass their own Io, so nothing else here touches the machine.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { gh } from "../loops/host.mjs";
import { createNotice, listNotices, withdrawNotice } from "../loops/notices.mjs";

/** The workflow's name. Runs are filtered by it: `gh run list --workflow` 404s until ci.yml is on the default branch. */
export const WORKFLOW_NAME = "CI";
export const EXIT = {
  green: 0,
  brake: 1,
  file: 2,
  flake: 3,
  infra: 4,
  unknown: 5,
  time: 6,
  usage: 64,
  timeout: 75,
};
/** A verdict's exit code; a kind this version doesn't know is unknown, never green. */
export const exitFor = (/** @type {string} */ kind) =>
  kind !== "usage" && kind !== "timeout" && Object.hasOwn(EXIT, kind)
    ? EXIT[/** @type {keyof typeof EXIT} */ (kind)]
    : EXIT.unknown;
export const DEFAULT_WAIT_MIN = 30;
export const RUN_FIELDS =
  "databaseId,headSha,headBranch,status,conclusion,createdAt,url,workflowName,attempt";
const STATUS_KEEP_MS = 7 * 24 * 3600_000;

/**
 * @typedef {{ ok: boolean, out: string }} Result
 * @typedef {{ databaseId: number, headSha: string, headBranch?: string, status: string, conclusion?: string, createdAt: string, url?: string, workflowName?: string, attempt?: number }} Run
 * @typedef {{ list: () => { id: string, text: string }[], post: (text: string) => void, withdraw: (id: string) => void }} Board
 * @typedef {{ read: (name: string) => string | null, write: (name: string, text: string) => void }} Cache
 * @typedef {{ git: (args: string[], input?: string) => Result, gh: (args: string[], timeoutMs?: number) => Result, sleep: (ms: number) => Promise<void>, now: () => number, log: (line: string) => void, pollMs: number, fileFindings?: (findings: any[], push: boolean) => { filed: { key: string, id: string, created: boolean }[], removed: string[], pushed: boolean | null, missed?: string[] } | null, board?: () => Board, cache?: () => Cache, session?: () => string, terminal?: () => boolean, ask?: (question: string) => Promise<string> }} Io
 */

const command = (
  /** @type {string} */ bin,
  /** @type {string[]} */ args,
  /** @type {string=} */ input,
  timeout = 120_000,
) => {
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    input,
    timeout,
  });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
};

/** The main checkout: the backlog, the board and the status cache live there, for every worktree. */
const mainCheckout = () =>
  dirname(command("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]).out);

/** The status cache: small files under the main checkout's .loops/, old ones pruned on write. */
function statusCache() {
  const dir = join(mainCheckout(), ".loops", ".ci-status");
  return {
    read: (/** @type {string} */ name) => {
      try {
        return readFileSync(join(dir, name), "utf8");
      } catch {
        return null;
      }
    },
    write: (/** @type {string} */ name, /** @type {string} */ text) => {
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, name), text);
        for (const f of readdirSync(dir))
          if (Date.now() - statSync(join(dir, f)).mtimeMs > STATUS_KEEP_MS)
            rmSync(join(dir, f), { force: true });
      } catch {
        // A status line is never worth failing over.
      }
    },
  };
}

function noticeBoard() {
  const dir = process.env.RISA_NOTICES_DIR || join(mainCheckout(), ".loops", ".notices");
  return {
    list: () => listNotices(dir),
    post: (/** @type {string} */ text) => {
      createNotice(dir, { text, session: "ci", minutes: 24 * 60 });
    },
    withdraw: (/** @type {string} */ id) => {
      withdrawNotice(dir, id);
    },
  };
}

/** The backlog's locked write (`pnpm backlog ci-file`). */
function fileFindings(/** @type {any[]} */ findings, /** @type {boolean} */ push) {
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "backlog", "backlog.mjs");
  const r = spawnSync(process.execPath, [cli, "ci-file", ...(push ? ["--push"] : [])], {
    encoding: "utf8",
    input: JSON.stringify({ findings }),
    timeout: 120_000,
  });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    return null;
  }
}

/** One line from the terminal. */
async function askTerminal(/** @type {string} */ question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** @returns {Io} */
export const realIo = () => ({
  git: (args, input) => command("git", args, input),
  gh: (args, timeoutMs) => gh(args, { timeout: timeoutMs }),
  fileFindings,
  board: noticeBoard,
  cache: statusCache,
  session: () => process.env.RISA_SESSION_NAME ?? "",
  terminal: () => !!process.stdin.isTTY && !!process.stdout.isTTY,
  ask: askTerminal,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  log: (line) => console.log(line),
  pollMs: Number(process.env.RISA_CI_POLL || 15) * 1000,
});
