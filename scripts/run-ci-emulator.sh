#!/usr/bin/env bash
#
# run-ci-emulator.sh — dispatch the debug-emulator CI workflow against a branch
# and block until it completes, surfacing the run URL and exit code.
#
# Usage:
#   bash scripts/run-ci-emulator.sh                 # uses current branch
#   bash scripts/run-ci-emulator.sh <branch>        # uses the specified branch
#
# Behavior (see validation-contract.md VAL-CI-027 / VAL-CI-028):
#   1. Push <branch> to origin so the workflow can resolve the ref.
#   2. Dispatch `.github/workflows/debug-emulator.yml` against <branch> via
#      `gh workflow run`.
#   3. Locate the freshly-dispatched run ID, print its URL, then block on
#      `gh run watch` so stdout streams job status.
#   4. Exit 0 on `conclusion=success`, non-zero otherwise — i.e. the script
#      exit code mirrors the CI run conclusion.
#
# Requirements:
#   - `git` with push access to `origin`.
#   - `gh` authenticated against this repo with `repo` scope.
#
set -euo pipefail

WORKFLOW_FILE="debug-emulator.yml"

branch="${1:-$(git rev-parse --abbrev-ref HEAD)}"

if [[ -z "${branch}" || "${branch}" == "HEAD" ]]; then
  echo "error: could not determine branch (detached HEAD?). Pass a branch name as the first argument." >&2
  exit 2
fi

echo "[run-ci-emulator] Using branch: ${branch}"

# 1) Push the branch so the workflow ref exists on origin.
echo "[run-ci-emulator] Pushing ${branch} to origin..."
git push origin "${branch}"

# Record the dispatch time so we can reliably pick up the new run below.
dispatched_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# 2) Dispatch the debug-emulator workflow against the branch.
echo "[run-ci-emulator] Dispatching ${WORKFLOW_FILE} against ref=${branch}..."
gh workflow run "${WORKFLOW_FILE}" --ref "${branch}"

# 3) Locate the newly dispatched run. gh sometimes takes a moment to register it.
run_id=""
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  sleep 3
  run_id="$(
    gh run list \
      --workflow "${WORKFLOW_FILE}" \
      --branch "${branch}" \
      --event workflow_dispatch \
      --limit 1 \
      --created ">=${dispatched_at}" \
      --json databaseId \
      --jq '.[0].databaseId // empty'
  )"
  if [[ -n "${run_id}" ]]; then
    break
  fi
  echo "[run-ci-emulator] Waiting for run to appear (attempt ${attempt})..."
done

if [[ -z "${run_id}" ]]; then
  echo "error: could not find dispatched workflow run for ${WORKFLOW_FILE} on ${branch}" >&2
  exit 3
fi

run_url="$(gh run view "${run_id}" --json url --jq '.url')"
echo "[run-ci-emulator] Run URL: ${run_url}"

# 4) Block on the run; `gh run watch --exit-status` propagates the conclusion
#    as the command's exit code so this script mirrors it.
set +e
gh run watch "${run_id}" --exit-status
watch_status=$?
set -e

final_conclusion="$(gh run view "${run_id}" --json conclusion --jq '.conclusion // "unknown"')"
echo "[run-ci-emulator] Conclusion: ${final_conclusion}"
echo "[run-ci-emulator] Run URL: ${run_url}"

exit "${watch_status}"
