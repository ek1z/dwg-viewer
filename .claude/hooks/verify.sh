#!/usr/bin/env bash
#
# Stop hook: when the working tree has uncommitted changes, run the project's
# type-check gate so a turn doesn't end on red code.
#
# Loop-safe: if this hook already forced a continuation (stop_hook_active),
# it bails out immediately so it can't spin. It also no-ops when the tree is
# clean, so committed/idle turns pay nothing.
#
# Adapt: this repo has no lint; `pnpm -r typecheck` is the gate (astro check in
# apps/web, tsc --noEmit in the libs). Add `pnpm -r test` below if you want the
# unit suite gated too. If `-r` over the whole workspace drags, scope it to
# changed packages, e.g. `pnpm --filter "...[origin/main]" typecheck`.
set -euo pipefail

input="$(cat)"

# Don't re-trigger ourselves: if Claude is continuing *because* of this Stop
# hook, let it finish.
if printf '%s' "$input" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

# Run from the repo root regardless of where the hook was invoked.
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

# Clean tree → nothing to verify.
if [ -z "$(git status --porcelain)" ]; then
  exit 0
fi

if ! out="$(pnpm -r typecheck 2>&1)"; then
  {
    echo "verify.sh: \`pnpm -r typecheck\` failed — fix before finishing."
    echo
    echo "$out"
  } >&2
  # Exit 2 feeds stderr back to Claude and blocks the stop.
  exit 2
fi

exit 0
