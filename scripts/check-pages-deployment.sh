#!/usr/bin/env bash
# Fail closed unless this exact commit passed the main push workflow and is still main.
set -euo pipefail
: "${GH_REPO:?}" "${TARGET_SHA:?}" "${TRIGGER_SHA:?}"
if [[ "$TARGET_SHA" != "$TRIGGER_SHA" ]]; then
  echo 'Checked-out main does not match the triggering commit' >&2
  exit 1
fi

passing_runs=$(gh api --paginate "repos/$GH_REPO/actions/workflows/publish-dist.yml/runs?event=push&branch=main&head_sha=$TARGET_SHA&per_page=100" \
  --jq '.workflow_runs[] | select(.event == "push" and .head_branch == "main" and .head_sha == "'"$TARGET_SHA"'" and .status == "completed" and .conclusion == "success") | .id')
if [[ -z "$passing_runs" ]]; then
  echo 'No successful Publish Dist main push run for this commit' >&2
  exit 1
fi
main_sha=$(gh api "repos/$GH_REPO/git/ref/heads/main" --jq '.object.sha')
if [[ "$main_sha" != "$TARGET_SHA" ]]; then
  echo 'Commit is no longer the head of main' >&2
  exit 1
fi
