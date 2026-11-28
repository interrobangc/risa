#!/usr/bin/env bash
# The `gh` second-repo.test.mjs puts on PATH: what land.sh asks GitHub, for a repo
# whose trunk and prefixes aren't Risa's (land-fixture.mjs's stub knows only prd/
# and dev). Every answer comes from the environment:
#
#   pr list        PR 7, only for a --head under $GH_PRD_PREFIX into --base $GH_TRUNK
#   api graphql    PR 7 open, its head $GH_HEAD_REF at $PR_HEAD, its comments
#                  $PR_COMMENTS (a JSON array; Codex's summary comment for a review)
#   run list       --commit $GH_CI_SHA: one finished run (11) on
#                  $GH_RUN_PREFIX$GH_CI_TIER/x; any other commit or branch: none
#   run download   run 11's verdict: $GH_CI_VERDICT, copied into --dir
#
# Anything else, a merge too, is an error: the RISA_PR_THROWAWAY seam stops land
# before it would merge. $GH_LOG, when set, gets one line per call.
set -euo pipefail
[[ -z ${GH_LOG:-} ]] || echo "gh $*" >> "$GH_LOG"
# flag NAME ARG… → the value after NAME among ARG…, or nothing.
flag() {
  local want=$1
  shift
  while (($#)); do
    if [[ $1 == "$want" ]]; then
      echo "${2:-}"
      return 0
    fi
    shift
  done
}
case "${1:-} ${2:-}" in
  "repo view") echo o/ledger ;;
  "pr list")
    head=$(flag --head "$@") base=$(flag --base "$@")
    if [[ $base == "$GH_TRUNK" && $head == "$GH_PRD_PREFIX"* ]]; then echo 7; fi
    ;;
  "pr view") echo https://example.test/pr/7 ;;
  "api graphql")
    printf '{"data":{"repository":{"pullRequest":{"number":7,"url":"https://example.test/pr/7","state":"OPEN","headRefName":"%s","headRefOid":"%s","reviews":{"nodes":[]},"reviewThreads":{"nodes":[]},"comments":{"nodes":%s},"reactions":{"nodes":[]}}}}}\n' \
      "$GH_HEAD_REF" "$PR_HEAD" "${PR_COMMENTS:-[]}"
    ;;
  "run list")
    commit=$(flag --commit "$@")
    if [[ -n $commit && $commit == "${GH_CI_SHA:-}" ]]; then
      printf '[{"databaseId":11,"headSha":"%s","headBranch":"%s%s/x","status":"completed","conclusion":"success","createdAt":"2026-01-01T00:00:00Z","url":"https://example.test/run/11","workflowName":"CI","attempt":1}]\n' \
        "$commit" "$GH_RUN_PREFIX" "$GH_CI_TIER"
    else
      echo "[]"
    fi
    ;;
  "run view") echo '{"status":"completed","conclusion":"success","url":"https://example.test/run/11","attempt":1}' ;;
  "run download")
    [[ ${3:-} == 11 ]] || exit 1
    cp "$GH_CI_VERDICT" "$(flag --dir "$@")/verdict.json"
    ;;
  *)
    echo "unexpected gh $*" >&2
    exit 1
    ;;
esac
