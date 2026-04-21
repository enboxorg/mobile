#!/usr/bin/env bash
# Idempotent environment setup for mission workers.
# Run at the start of each worker session. Safe to re-run.

set -euo pipefail

cd "$(dirname "$0")/.."

echo "[init] node: $(node --version)"
echo "[init] bun:  $(bun --version)"

# Install dependencies (triggers scripts/apply-patches.mjs via postinstall).
# --frozen-lockfile guarantees deterministic installs across workers.
if [ ! -d node_modules ] || [ ! -f node_modules/.mission-installed ]; then
  echo "[init] bun install --frozen-lockfile"
  bun install --frozen-lockfile
  : > node_modules/.mission-installed
else
  echo "[init] node_modules already present; skipping install"
fi

# Verify the workspace is in a sane state for workers. Non-fatal on failure
# (a feature may be mid-refactor and have a broken typecheck intentionally),
# but we print a clear signal.
set +e
bun run typecheck >/dev/null 2>&1
tc_rc=$?
set -e
echo "[init] typecheck baseline exit=$tc_rc"

echo "[init] ready"
