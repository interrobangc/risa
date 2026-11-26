#!/usr/bin/env node
// Codex's verdict on a pull request's current head, from the PR's state as
// GitHub's GraphQL API returns it (review.sh fetches it; PR_QUERY below):
//
//   waiting   no answer from Codex yet, or a review is running
//   stale     Codex last reviewed an older head (it reviews pushes by itself;
//             `@codex review` asks again)
//   findings  Codex reviewed the head and threads of its own are unresolved
//   clean     Codex reviewed the head and none of its threads is unresolved
//   out-of-credits  the head isn't reviewed and Codex's latest word on the PR
//             is its "reached your Codex usage limits" comment: no review is
//             coming until credits are added (review.sh doesn't wait for one)
//
// A clean verdict on an older head carries forward to the head (carried,
// below; it needs the repository, so only with --repo and --trunk) when all
// three hold, even while Codex is reviewing the new head by itself:
//   1. every commit since the reviewed head is a plain merge of dev: no
//      conflict resolved, nothing added, no new work by the branch;
//   2. the PR's own diff against dev is the same as the reviewed one (patch id);
//   3. the dev changes that came in touch none of the files the PR touches.
// Incoming code in another file that changes what the PR's code means is left
// to the check gate. Otherwise it is stale (or waiting) as before.
//
// Codex keeps one summary comment per PR up to date, with a machine-readable
// line `<!-- codex-review-state:v1 {"code_review":{"commit_sha":…,"status":…}} -->`
// naming the commit it is reviewing ("running") or last reviewed ("completed").
// While a review runs, the commit it last finished is read from that comment's
// edit history (userContentEdits). That line is the signal: its 👍 on the PR carries no commit and outlives the
// review it was for. Findings are inline review threads opening with a
// priority badge (`![P2 Badge](…)`). Only Codex's own threads count: a human's
// comment never blocks. Codex doesn't resolve its threads when a fix lands
// (they turn outdated). An outdated thread stops counting once Codex's state
// on the head says has_unresolved_findings: false (its summary is trusted for
// the head); any other open thread, a declined or current one, is replied to
// and resolved before the verdict is clean; replies alone don't clear it.
//
//   node codex-review.mjs [file] [--line|--text] [--repo=<dir> --trunk=<ref>]
//     the PR's JSON on stdin when no file; prints the verdict as JSON (--line:
//     one line; --text: the line and the findings, for people). With --repo
//     and --trunk (a checkout holding the PR's commits, and dev's ref there) a
//     clean verdict may carry over dev merges.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Codex's GitHub login (GraphQL's author.login; reactions add "[bot]"). */
export const CODEX_LOGIN = "chatgpt-codex-connector";

/** The GraphQL query review.sh runs ($owner, $name, $number). */
export const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number url state headRefName headRefOid
      reviews(last: 50) { nodes { id author { login } state body submittedAt url commit { oid } } }
      reviewThreads(first: 100) { nodes { id isResolved isOutdated path line originalLine
        comments(first: 50) { nodes { id author { login } body url createdAt commit { oid } originalCommit { oid } } } } }
      comments(last: 100) { nodes { id author { login } body createdAt updatedAt url
        userContentEdits(first: 100) { nodes { editedAt diff } } } }
      reactions(last: 100) { nodes { content createdAt user { login } } }
    }
  }
}`;

const STATE_LINE = /<!--\s*codex-review-state:v1\s+(\{.*?\})\s*-->/s;
const BADGE = /!\[P(\d)\s+Badge\]/i;
const OUT_OF_CREDITS = /reached your Codex usage limits/i;

/** Is this login Codex's (with or without the "[bot]" suffix)? */
export function isCodex(login) {
  return typeof login === "string" && login.replace(/\[bot\]$/, "") === CODEX_LOGIN;
}

const nodes = (conn) => conn?.nodes ?? [];

/** Accept the full GraphQL response, its `data`, or the pullRequest node. */
export function pullRequestOf(json) {
  return json?.data?.repository?.pullRequest ?? json?.repository?.pullRequest ?? json;
}

/** The priority from a finding's badge (`![P1 Badge]` → "P1"), or null. */
export function parsePriority(body) {
  const m = BADGE.exec(body ?? "");
  return m ? `P${m[1]}` : null;
}

/** A finding's title: its first line, without the badge markup or bold. */
export function findingTitle(body) {
  const first = (body ?? "").split("\n").find((l) => l.trim()) ?? "";
  return first
    .replace(/<\/?sub>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\*\*/g, "")
    .trim();
}

/** The code-review state in a summary comment's body, or null. */
function stateIn(body) {
  try {
    return JSON.parse(STATE_LINE.exec(body ?? "")?.[1] ?? "null")?.code_review ?? null;
  } catch {
    return null;
  }
}

/**
 * Codex's latest code-review state from its summary comment, or null:
 * { commit_sha, status, has_unresolved_findings, …, updatedAt, completedSha }.
 * completedSha is the commit of the last review it finished: this state's, or
 * while a review runs, the latest completed one in the comment's edit history.
 */
export function summaryState(pr) {
  const summaries = nodes(pr.comments).filter((c) => isCodex(c.author?.login) && STATE_LINE.test(c.body));
  summaries.sort((a, b) =>
    String(a.updatedAt ?? a.createdAt).localeCompare(String(b.updatedAt ?? b.createdAt)),
  );
  const last = summaries.at(-1);
  if (!last) return null;
  const code = stateIn(last.body);
  if (!code) return null;
  const edits = nodes(last.userContentEdits)
    .toSorted((a, b) => String(b.editedAt).localeCompare(String(a.editedAt)))
    .map((e) => stateIn(e.diff));
  const completed = [code, ...edits].find((c) => c?.status === "completed" && c.commit_sha);
  return {
    ...code,
    updatedAt: last.updatedAt ?? last.createdAt ?? null,
    completedSha: completed?.commit_sha ?? null,
  };
}

/**
 * The commit Codex last finished reviewing: the summary's (completedSha); with
 * no summary, its latest review's (a review with findings is a PR review).
 */
function reviewedCommit(pr, summary) {
  if (summary) return summary.completedSha;
  const reviews = nodes(pr.reviews).filter((r) => isCodex(r.author?.login) && r.commit?.oid);
  reviews.sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)));
  return reviews.at(-1)?.commit.oid ?? null;
}

/**
 * Is a Codex review running now (the summary says so, or its 👀 is on the PR)?
 * A "failed" review (out of credits, say) isn't running.
 */
function running(pr, summary) {
  if (summary?.status && !["completed", "failed"].includes(summary.status)) return true;
  return nodes(pr.reactions).some((r) => r.content === "EYES" && isCodex(r.user?.login));
}

/**
 * When Codex last said it is out of credits, if that is its latest word on the
 * PR, else null: newer than its other comments, its reviews and its 👀. Its
 * summary marks the review it couldn't run "failed" in the same moment (on PR
 * #48, a second before the limit comment), so a failed summary doesn't count.
 */
export function outOfCreditsAt(pr) {
  const codexComments = nodes(pr.comments).filter((c) => isCodex(c.author?.login));
  const at = (c) => String(c.updatedAt ?? c.createdAt ?? "");
  const limit = codexComments
    .filter((c) => OUT_OF_CREDITS.test(c.body ?? ""))
    .map(at)
    .toSorted()
    .at(-1);
  if (!limit) return null;
  const counts = (c) => !OUT_OF_CREDITS.test(c.body ?? "") && stateIn(c.body)?.status !== "failed";
  const other = [
    ...codexComments.filter(counts).map(at),
    ...nodes(pr.reviews)
      .filter((r) => isCodex(r.author?.login))
      .map((r) => String(r.submittedAt ?? "")),
    ...nodes(pr.reactions)
      .filter((r) => r.content === "EYES" && isCodex(r.user?.login))
      .map((r) => String(r.createdAt ?? "")),
  ];
  return other.some((t) => t > limit) ? null : limit;
}

/**
 * Is Codex's state on the head clean: a completed review of headRefOid with
 * has_unresolved_findings false?
 */
function headStateClean(pr) {
  const s = summaryState(pr);
  return (
    s?.status === "completed" &&
    Boolean(s.commit_sha) &&
    s.commit_sha === pr.headRefOid &&
    s.has_unresolved_findings === false
  );
}

/**
 * Codex's unresolved threads, as findings. An outdated one doesn't count when
 * Codex's state on the head is clean (headStateClean).
 */
export function openFindings(pr) {
  const trustHead = headStateClean(pr);
  return nodes(pr.reviewThreads)
    .filter((t) => !t.isResolved && isCodex(nodes(t.comments)[0]?.author?.login))
    .filter((t) => !(trustHead && t.isOutdated))
    .map((t) => {
      const first = nodes(t.comments)[0];
      return {
        path: t.path,
        line: t.line ?? t.originalLine ?? null,
        priority: parsePriority(first.body),
        body: findingTitle(first.body),
        url: first.url,
        threadId: t.id,
        outdated: Boolean(t.isOutdated),
      };
    });
}

/**
 * The verdict on the PR's current head:
 * { state, findings, headSha, reviewedSha, reviewingSha, summaryAt, number, url }.
 * reviewingSha is the commit a running review is on; summaryAt is when Codex
 * last updated its summary (review.sh --again waits for it to change).
 * findings are listed for "findings", "stale" and "out-of-credits" (still open
 * from the older review); for "clean" and "waiting" they're empty. A head
 * Codex hasn't reviewed is "out-of-credits" instead of waiting or stale when
 * its usage-limit comment is its latest word (outOfCreditsAt). While a review runs,
 * reviewedSha is the commit of the review before it. This reads the PR's state
 * only: carried (below) adds the rule that needs the repository.
 */
export function verdict(json) {
  const pr = pullRequestOf(json);
  const headSha = pr.headRefOid;
  const summary = summaryState(pr);
  const reviewedSha = reviewedCommit(pr, summary);
  const isRunning = running(pr, summary);
  const base = {
    headSha,
    reviewedSha,
    reviewingSha: isRunning ? (summary?.commit_sha ?? null) : null,
    summaryAt: summary?.updatedAt ?? null,
    number: pr.number ?? null,
    url: pr.url ?? null,
  };
  const headReviewed = !isRunning && reviewedSha && reviewedSha === headSha;
  const limitAt = headReviewed ? null : outOfCreditsAt(pr);
  if (limitAt)
    return { state: "out-of-credits", findings: openFindings(pr), outOfCreditsAt: limitAt, ...base };
  if (isRunning || !reviewedSha) return { state: "waiting", findings: [], ...base };
  const findings = openFindings(pr);
  if (reviewedSha !== headSha) return { state: "stale", findings, ...base };
  return { state: findings.length ? "findings" : "clean", findings, ...base };
}

const short = (sha) => (sha ? sha.slice(0, 7) : "none");

/**
 * Why a clean verdict on reviewedSha does not carry to headSha, or null when
 * it does (the three rules in the header). repo is a checkout that has both
 * commits; trunk is dev's ref there. Anything git can't answer is a refusal.
 */
export function carryRefusal(repo, trunk, reviewedSha, headSha) {
  const run = (args, input) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "ignore"],
      maxBuffer: 1 << 28,
    });
  const git = (...args) => run(args).trim();
  const ok = (...args) => {
    try {
      run(args);
      return true;
    } catch {
      return false;
    }
  };
  try {
    for (const rev of [reviewedSha, headSha, trunk])
      if (!ok("cat-file", "-e", `${rev}^{commit}`))
        return `${rev === trunk ? rev : short(rev)} isn't in this checkout`;
    if (!ok("merge-base", "--is-ancestor", reviewedSha, headSha))
      return `the head doesn't build on ${short(reviewedSha)}`;

    // 1. Only plain merges of dev since the review.
    const since = git("rev-list", "--parents", `${reviewedSha}..${headSha}`, "--not", trunk)
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" "));
    if (!since.length) return "no commits of the branch's own since the review";
    for (const [sha, ...parents] of since) {
      if (parents.length !== 2 || !ok("merge-base", "--is-ancestor", parents[1], trunk))
        return `${short(sha)} isn't a merge of ${trunk}`;
      let tree = null;
      try {
        tree = git("merge-tree", "--write-tree", parents[0], parents[1]).split("\n")[0];
      } catch {
        // A conflict (exit 1): the merge commit holds a resolution.
      }
      if (tree !== git("rev-parse", `${sha}^{tree}`))
        return `${short(sha)} isn't a plain merge of ${trunk} (a conflict resolved, or changes added)`;
    }

    // 2. The PR's own diff is the reviewed one.
    const baseWas = git("merge-base", trunk, reviewedSha);
    const baseNow = git("merge-base", trunk, headSha);
    const patchId = (base, tip) =>
      run(["patch-id", "--stable"], run(["diff", "--no-ext-diff", "--no-color", base, tip])).split(" ")[0];
    const idWas = patchId(baseWas, reviewedSha);
    if (!idWas) return `the PR has no diff against ${trunk}`;
    if (idWas !== patchId(baseNow, headSha)) return `the PR's diff against ${trunk} changed`;

    // 3. What came in from dev touches none of the PR's files.
    const names = (from, to) =>
      run(["diff", "--name-only", "--no-renames", "-z", from, to]).split("\0").filter(Boolean);
    const own = new Set([...names(baseWas, reviewedSha), ...names(baseNow, headSha)]);
    const shared = names(baseWas, baseNow).filter((file) => own.has(file));
    if (shared.length)
      return `${trunk} changed ${shared[0]}${shared.length > 1 ? ` and ${shared.length - 1} more` : ""}, which the PR touches`;
    return null;
  } catch {
    return "git couldn't compare the commits";
  }
}

/**
 * The verdict, with a clean one carried over dev merges: when Codex last
 * finished on an older head with none of its threads open, and carryRefusal
 * finds nothing, the state is "clean" and carriedFrom names the reviewed
 * commit, even while Codex reviews the new head. A refused stale verdict gets
 * notCarried (why). Without repo and trunk this is verdict().
 */
export function carried(json, { repo, trunk } = {}) {
  const v = verdict(json);
  if (!repo || !trunk || !["stale", "waiting", "out-of-credits"].includes(v.state)) return v;
  if (!v.reviewedSha || v.reviewedSha === v.headSha) return v;
  if (openFindings(pullRequestOf(json)).length) return v;
  const why = carryRefusal(repo, trunk, v.reviewedSha, v.headSha);
  if (why) return { ...v, notCarried: why };
  const clean = { ...v, state: "clean", findings: [], carriedFrom: v.reviewedSha };
  delete clean.outOfCreditsAt;
  return clean;
}

/** One line, for reports: "codex: clean on abc1234". */
export function verdictLine(v) {
  switch (v.state) {
    case "clean":
      return v.carriedFrom
        ? `codex: clean on ${short(v.headSha)} (carried from ${short(v.carriedFrom)}: only plain dev merges since, the PR's diff unchanged)`
        : `codex: clean on ${short(v.headSha)}`;
    case "findings":
      return `codex: ${v.findings.length} open finding${v.findings.length === 1 ? "" : "s"} on ${short(v.headSha)}`;
    case "out-of-credits":
      return `codex: out of credits, no review of ${short(v.headSha)} is coming (last reviewed ${short(v.reviewedSha)}); land with --no-review, or add credits and ask again with --again`;
    case "stale":
      return `codex: stale (last reviewed ${short(v.reviewedSha)}, head ${short(v.headSha)}${v.notCarried ? `; not carried: ${v.notCarried}` : ""}): ask again with --again`;
    default:
      return v.reviewingSha
        ? `codex: reviewing ${short(v.reviewingSha)}${v.reviewingSha === v.headSha ? "" : ` (head ${short(v.headSha)})`}`
        : `codex: waiting for a review of ${short(v.headSha)}`;
  }
}

/** The line, then one line per finding (priority, file:line, title, thread). */
export function verdictText(v) {
  const lines = [verdictLine(v)];
  for (const f of v.findings) {
    lines.push(
      `  ${f.priority ?? "P?"} ${f.path}${f.line ? `:${f.line}` : ""}${f.outdated ? " (outdated)" : ""}  ${f.body}`,
    );
    lines.push(`     ${f.url}  thread ${f.threadId}`);
  }
  return lines.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const v = carried(JSON.parse(readFileSync(file ?? 0, "utf8")), {
    repo: option("repo"),
    trunk: option("trunk"),
  });
  if (args.includes("--line")) console.log(verdictLine(v));
  else if (args.includes("--text")) console.log(verdictText(v));
  else console.log(JSON.stringify(v, null, 2));
}
