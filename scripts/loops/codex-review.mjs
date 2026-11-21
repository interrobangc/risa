#!/usr/bin/env node
// Codex's verdict on a pull request's current head, from the PR's state as
// GitHub's GraphQL API returns it (review.sh fetches it; PR_QUERY below):
//
//   waiting   no answer from Codex yet on any head, or a review is running (👀)
//   stale     Codex last reviewed an older head (push a fix → ask again)
//   findings  Codex reviewed the head and threads of its own are unresolved
//   clean     Codex reviewed the head and none of its threads is unresolved
//
// Codex keeps one summary comment per PR up to date, with a machine-readable
// line `<!-- codex-review-state:v1 {"code_review":{"commit_sha":…,"status":…}} -->`:
// that names the commit it last reviewed. Its findings are inline review
// threads, each opening with a priority badge (`![P1 Badge](…)`). Only Codex's
// own threads count: a human's comment never blocks. A declined finding is
// replied to, then resolved; resolved threads don't block, replies alone do.
//
//   node codex-review.mjs [file] [--line|--text]   the PR's JSON on stdin when
//     no file; prints the verdict as JSON (--line: one line; --text: the line
//     and the findings, for people)
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
      comments(last: 100) { nodes { id author { login } body createdAt updatedAt url } }
      reactions(last: 100) { nodes { content createdAt user { login } } }
    }
  }
}`;

const STATE_LINE = /<!--\s*codex-review-state:v1\s+(\{.*?\})\s*-->/s;
const BADGE = /!\[P(\d)\s+Badge\]/i;

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

/** Codex's latest code-review state from its summary comment, or null. */
export function summaryState(pr) {
  const summaries = nodes(pr.comments).filter((c) => isCodex(c.author?.login) && STATE_LINE.test(c.body));
  summaries.sort((a, b) =>
    String(a.updatedAt ?? a.createdAt).localeCompare(String(b.updatedAt ?? b.createdAt)),
  );
  const last = summaries.at(-1);
  if (!last) return null;
  try {
    return JSON.parse(STATE_LINE.exec(last.body)[1]).code_review ?? null;
  } catch {
    return null;
  }
}

/** The commit Codex last finished reviewing: the summary's, else its latest review's. */
function reviewedCommit(pr, summary) {
  if (summary?.status === "completed" && summary.commit_sha) return summary.commit_sha;
  const reviews = nodes(pr.reviews).filter((r) => isCodex(r.author?.login) && r.commit?.oid);
  reviews.sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)));
  return reviews.at(-1)?.commit.oid ?? null;
}

/** Is a Codex review running now (its 👀 on the PR, or the summary says so)? */
function running(pr, summary) {
  if (summary?.status && summary.status !== "completed") return true;
  return nodes(pr.reactions).some((r) => r.content === "EYES" && isCodex(r.user?.login));
}

/** Codex's unresolved threads, as findings. */
export function openFindings(pr) {
  return nodes(pr.reviewThreads)
    .filter((t) => !t.isResolved && isCodex(nodes(t.comments)[0]?.author?.login))
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
 * { state, findings, reviewedSha, headSha, number, url }.
 * findings are listed for "findings" and "stale" (still open from the older
 * review); for "clean" and "waiting" they're empty.
 */
export function verdict(json) {
  const pr = pullRequestOf(json);
  const headSha = pr.headRefOid;
  const summary = summaryState(pr);
  const reviewedSha = reviewedCommit(pr, summary);
  const base = { headSha, reviewedSha, number: pr.number ?? null, url: pr.url ?? null };
  if (running(pr, summary) || !reviewedSha) return { state: "waiting", findings: [], ...base };
  const findings = openFindings(pr);
  if (reviewedSha !== headSha) return { state: "stale", findings, ...base };
  return { state: findings.length ? "findings" : "clean", findings, ...base };
}

const short = (sha) => (sha ? sha.slice(0, 7) : "none");

/** One line, for reports: "codex: clean on abc1234". */
export function verdictLine(v) {
  switch (v.state) {
    case "clean":
      return `codex: clean on ${short(v.headSha)}`;
    case "findings":
      return `codex: ${v.findings.length} open finding${v.findings.length === 1 ? "" : "s"} on ${short(v.headSha)}`;
    case "stale":
      return `codex: stale (last reviewed ${short(v.reviewedSha)}, head ${short(v.headSha)}): ask again`;
    default:
      return v.reviewedSha && v.reviewedSha !== v.headSha
        ? `codex: reviewing ${short(v.headSha)} (last reviewed ${short(v.reviewedSha)})`
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
  const v = verdict(JSON.parse(readFileSync(file ?? 0, "utf8")));
  if (args.includes("--line")) console.log(verdictLine(v));
  else if (args.includes("--text")) console.log(verdictText(v));
  else console.log(JSON.stringify(v, null, 2));
}
