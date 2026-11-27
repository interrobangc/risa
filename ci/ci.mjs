#!/usr/bin/env node
// prd ci: ask GitHub for a CI run of a branch, and read its verdict.
//
//   prd ci run <tier> [--ref <branch>] [--files <file>…] [--wait [min]]
//       pushes the commit to ci/<tier>/<branch>, the only thing that starts the
//       workflow. A ref already at the commit reuses its live run, or is deleted
//       and pushed again (a push of the same commit starts nothing). With --wait
//       (default 30 min) it blocks until the verdict: exit 0 green, 1 brake, 2 file,
//       3 flake, 4 infra, 5 unknown, 6 time, 75 at the timeout. The ref is deleted only
//       after a final verdict; at a timeout it stays for `prd tidy`.
//       --files narrows the run to those test files: a throwaway commit on top of
//       the target adds the list, on its own ref, and its verdict never counts as
//       the branch's.
//       --force-flake <check> (candidate only) is the proof of the browser rerun: a
//       throwaway commit makes that check fail once, on its own ref. Expect exit 3
//       (flake); its verdict never counts as the branch's and writes no status.
//   prd ci [<branch>]
//       the latest whole-tier verdict for the branch's tip (exits by kind).
//   prd ci blame [<branch>] [--json]
//       splits a file or brake verdict against a run on dev's tip and files dev's
//       failures: exit 0 all dev's, 2 some the branch's, 5 unknown.
//   prd ci file [<branch>] [--base <sha>] [--run <id>[,<id>]] [--no-push]
//       files the verdict's flakes (--run: those runs'); a file the branch touched
//       (against --base, else origin/dev) is the branch's and writes nothing: exit 0,
//       2 some the branch's, 5 unknown. --no-push leaves a quarantine commit on local dev.
//   prd ci gate <branch> --tier <t> --base <sha> [--fixes B-n,…] [--out <file>] [--peek]
//       the landing gate: finds a whole-tier verdict for <t> or higher on the tip (or
//       behind only docs and tooling commits; behind a dev sync, a recheck at the tier
//       dev brought, carrying the pre-sync verdict), requests the run when there is
//       none, and decides (gate.mjs). Exit 0 lands; else the verdict kind's code. --out writes
//       key=value lines for land.sh; --peek reads only: no run, no blame, no filing.
//   prd ci status <branch>…
//       each branch's latest whole-tier verdict, cached, for prd status.
//   prd ci candidate cut [<commit>] | fix <commit> | status
//       a release candidate: an rc/ branch of a fixed dev commit, its PR into staging
//       and its candidate run (candidate.mjs). Exit 6 is a refusal.
//   prd ci promote
//       merges the open candidate into staging when the newest candidate verdict on
//       its exact tip passes (promote.mjs), then deletes its rc/ and ci/ refs. Exit 6
//       is a refusal; exit 5 means the merge couldn't be confirmed.
//   prd ci release [--wait <min>] [--rerun]
//       the main gate: the release tier on the head of the open staging to main PR
//       (its finished verdict if it has one), written as the release-gate status, and
//       its second-zone failures filed (release-gate.mjs). Exit 6 is a refusal.
//   prd ci override <commit> --reason "…"
//       the user's recorded way through the main gate: a real terminal, never an agent
//       session, and the typed short commit. Writes a PR comment, the status and a notice.
//   prd ci release-test <commit>
//       proves the release-gate write on a throwaway commit: always `error`, never a
//       pass, and refused for any commit reachable from staging or main.
//
// An infra verdict is rerun once (--failed). A whole-tier run's final verdict is
// written as the commit status <name>-ci/<tier> (the project's name); a narrowed run gets none.
//
// A cancelled run, a run with no verdict and an unreachable GitHub read as
// unknown, never green. Env: RISA_CI_POLL (seconds between polls, 15).
//
// Where each part lives (open just the one you change; this file is the CLI,
// main's dispatch, and the names other modules import from it):
//   ci-io.mjs       EXIT, exitFor, the Io, Run, Board and Cache types, realIo
//   ci-runs.mjs     requesting and waiting for a run, reading verdicts, commit
//                   statuses, finding a commit's verdict (latestVerdict, ci <branch>)
//   ci-commits.mjs  the throwaway commits of --files and --force-flake
//   ci-blame.mjs    ci blame (the pure rules: blame.mjs)
//   ci-gate.mjs     ci gate (the pure rules: gate.mjs)
//   ci-file.mjs     ci file and ci zone-file
//   ci-status.mjs   ci status
//   ci-args.mjs     the arguments of run, blame and file, and gate
//   candidate.mjs, promote.mjs, release-gate.mjs   ci candidate, promote,
//                   release, override and release-test
import { toolCmd } from "../loops/config.mjs";
import { pathToFileURL } from "node:url";

import { parseGateArgs, parseReadArgs, parseRunArgs, resolve } from "./ci-args.mjs";
import { blame } from "./ci-blame.mjs";
import { forcedFlakeCommit, narrowedCommit } from "./ci-commits.mjs";
import { fileFlakes, fileSecondZone, fileZoneVerdict } from "./ci-file.mjs";
import { gate } from "./ci-gate.mjs";
import { EXIT, WORKFLOW_NAME, exitFor, realIo } from "./ci-io.mjs";
import {
  deleteRef,
  findTipVerdict,
  findVerdict,
  latestVerdict,
  readVerdict,
  remoteSha,
  requestRun,
  verdictLines,
} from "./ci-runs.mjs";
import { ciStatus } from "./ci-status.mjs";
import { runCandidate } from "./candidate.mjs";
import { runPromote } from "./promote.mjs";
import { runOverride, runRelease, runReleaseTest } from "./release-gate.mjs";

/**
 * @typedef {import("./ci-io.mjs").Result} Result
 * @typedef {import("./ci-io.mjs").Run} Run
 * @typedef {import("./ci-io.mjs").Board} Board
 * @typedef {import("./ci-io.mjs").Cache} Cache
 * @typedef {import("./ci-io.mjs").Io} Io
 */

// What other modules and the tests import from here.
export {
  EXIT,
  WORKFLOW_NAME,
  blame,
  ciStatus,
  deleteRef,
  exitFor,
  fileFlakes,
  fileSecondZone,
  fileZoneVerdict,
  findTipVerdict,
  forcedFlakeCommit,
  gate,
  latestVerdict,
  narrowedCommit,
  parseRunArgs,
  readVerdict,
  realIo,
  remoteSha,
  requestRun,
  verdictLines,
};

export async function main(/** @type {string[]} */ argv, io = realIo()) {
  try {
    if (argv[0] === "run") {
      const { tier, ref, waitMin, files, forceFlake } = parseRunArgs(argv.slice(1));
      const { branch, sha } = resolve(io, ref);
      if (forceFlake) {
        const forced = forcedFlakeCommit({ sha, check: forceFlake }, io);
        return await requestRun(
          { tier, branch: `${branch}-forced-${forced.slice(0, 8)}`, sha: forced, waitMin },
          io,
        );
      }
      if (!files.length) return await requestRun({ tier, branch, sha, waitMin }, io);
      const narrowed = narrowedCommit({ tier, sha, files }, io);
      return await requestRun(
        { tier, branch: `${branch}-narrowed-${narrowed.slice(0, 8)}`, sha: narrowed, waitMin },
        io,
      );
    }
    if (argv[0] === "candidate")
      return await runCandidate(argv.slice(1), io, {
        requestRun,
        findVerdict,
        deleteRef,
        verdictLines,
        exitFor,
      });
    if (argv[0] === "promote")
      return runPromote(argv.slice(1), io, { findTipVerdict, deleteRef, remoteSha, verdictLines });
    if (argv[0] === "release")
      return await runRelease(argv.slice(1), io, {
        findTipVerdict,
        requestRun,
        fileZoneVerdict,
        verdictLines,
        exitFor,
      });
    if (argv[0] === "override") return await runOverride(argv.slice(1), io);
    if (argv[0] === "release-test") return await runReleaseTest(argv.slice(1), io);
    if (argv[0] === "status") return ciStatus(argv.slice(1), io);
    if (argv[0] === "zone-file") {
      const { ref, runId } = parseReadArgs("file", argv.slice(1));
      return fileSecondZone({ sha: resolve(io, ref).sha, runId }, io);
    }
    if (argv[0] === "blame" || argv[0] === "file") {
      const { ref, json, base, runId, noPush } = parseReadArgs(argv[0], argv.slice(1));
      const { branch, sha } = resolve(io, ref);
      return argv[0] === "blame"
        ? await blame({ branch, sha, json }, io)
        : fileFlakes({ branch, sha, base, runId, noPush }, io);
    }
    if (argv[0] === "gate") {
      const { ref, ...request } = parseGateArgs(argv.slice(1));
      return await gate({ ...resolve(io, ref), ...request }, io);
    }
    if (argv.length > 1 || argv[0]?.startsWith("-"))
      throw new Error(
        `usage: ${toolCmd.prd} ci [<branch>] | ci run <tier> [--ref <branch>] [--files <file>…] [--force-flake <check>] [--wait [min]] | ci blame [<branch>] [--json] | ci file [<branch>] [--base <sha>] [--run <id>[,<id>]] [--no-push] | ci gate <branch> --tier <t> --base <sha> [--fixes B-n,…] [--out <file>] [--peek] | ci status <branch>… | ci candidate cut [<commit>] [--wait [min]] | ci candidate fix <commit> [--wait [min]] | ci candidate status | ci promote | ci release [--wait <min>] [--rerun] | ci override <commit> --reason "…" | ci release-test <commit> | ci zone-file [<branch>] [--run <id>]`,
      );
    return latestVerdict({ sha: resolve(io, argv[0] ?? null).sha }, io);
  } catch (e) {
    console.error(`ci: ${/** @type {Error} */ (e).message}`);
    return EXIT.usage;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exit(await main(process.argv.slice(2)));
