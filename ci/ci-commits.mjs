// ci-commits.mjs: part of `ci` (ci.mjs has the map). The throwaway
// commits a run can be asked for: a narrowed run (`ci run --files`) and a proof
// run (`ci run candidate --force-flake`). Plumbing only, so the worktree, the
// index and the branch stay as they are.
import { ciTiers } from "./tier-data.mjs";

/** @typedef {import("./ci-io.mjs").Io} Io */

/**
 * The throwaway commit of a narrowed run: the target plus the file list at the
 * root. Plumbing only, so the worktree, the index and the branch stay as they are.
 * @param {{ tier: string, sha: string, files: string[] }} request
 * @param {Io} io
 */
export function narrowedCommit({ tier, sha, files }, io) {
  for (const file of files) {
    if (!/\.test\.(ts|tsx|mjs)$/.test(file)) throw new Error(`--files takes test files: ${file}`);
    if (
      ciTiers().TIERS.indexOf(ciTiers().fileTier(file)) > ciTiers().TIERS.indexOf(/** @type {any} */ (tier))
    )
      throw new Error(`${file} needs the ${ciTiers().fileTier(file)} tier`);
    if (!io.git(["cat-file", "-e", `${sha}:${file}`]).ok)
      throw new Error(`${file} is not in ${sha.slice(0, 8)}`);
  }
  return throwawayCommit(
    io,
    sha,
    ciTiers().NARROWED_FILE,
    { target: sha, files },
    `chore(ci): narrowed run of ${sha.slice(0, 8)}`,
  );
}

/** A commit on top of `sha` that adds one JSON file, at the root or one directory down. Plumbing only. */
function throwawayCommit(
  /** @type {Io} */ io,
  /** @type {string} */ sha,
  /** @type {string} */ path,
  /** @type {unknown} */ content,
  /** @type {string} */ message,
) {
  const step = (/** @type {string[]} */ args, /** @type {string=} */ input) => {
    const r = io.git(args, input);
    if (!r.ok || !r.out) throw new Error(`git ${args[0]} failed for the throwaway commit`);
    return r.out;
  };
  const blob = step(["hash-object", "-w", "--stdin"], `${JSON.stringify(content, null, 2)}\n`);
  const withEntry = (
    /** @type {string} */ treeish,
    /** @type {string} */ name,
    /** @type {string} */ entry,
  ) => {
    const kept = step(["ls-tree", treeish])
      .split("\n")
      .filter((line) => !line.endsWith(`\t${name}`));
    return step(["mktree"], `${[...kept, `${entry}\t${name}`].join("\n")}\n`);
  };
  const [dir, name] = path.includes("/") ? path.split("/") : [null, path];
  const tree = dir
    ? withEntry(
        sha,
        dir,
        `040000 tree ${withEntry(`${sha}:${dir}`, /** @type {string} */ (name), `100644 blob ${blob}`)}`,
      )
    : withEntry(sha, path, `100644 blob ${blob}`);
  return step(["commit-tree", tree, "-p", sha, "-m", message]);
}

/**
 * The throwaway commit of a proof run: the target plus the marker that makes one
 * browser check fail once (browser-job.mjs).
 * @param {{ sha: string, check: string }} request
 * @param {Io} io
 */
export function forcedFlakeCommit({ sha, check }, io) {
  if (
    !/^[a-z0-9-]+$/.test(check) ||
    !io.git(["cat-file", "-e", `${sha}:${ciTiers().browserCheckFile(check)}`]).ok
  )
    throw new Error(`--force-flake: no browser check ${check} in ${sha.slice(0, 8)}`);
  return throwawayCommit(
    io,
    sha,
    ciTiers().FORCED_FLAKE_FILE,
    { check },
    `chore(ci): proof run forcing ${check} to fail once on ${sha.slice(0, 8)}`,
  );
}
