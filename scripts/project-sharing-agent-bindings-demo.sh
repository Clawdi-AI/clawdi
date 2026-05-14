#!/usr/bin/env bash
# Runnable smoke demo for the project-sharing + agent-bindings paths.
#
# This script does not require real Clawdi accounts or local secrets. It
# executes the backend and CLI tests that map to the live demo flows in:
#
#   docs/scenarios/project-sharing-agent-bindings-demo.md
#
# Usage:
#   bash scripts/project-sharing-agent-bindings-demo.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

section() {
  printf "\n== %s ==\n" "$1"
}

section "Project sharing + agent bindings demo smoke"
echo "Repository: $ROOT"
echo "Story: share project -> accept access -> bind agent projects -> resolve vault -> manage members"

section "Backend product paths"
(
  cd "$ROOT/backend"
  uv run pytest \
    tests/test_scope_sharing_e2e.py \
    tests/test_vault_resolution_mounts.py \
    -q
)

section "CLI user and agent contracts"
(
  cd "$ROOT/packages/cli"
  bun test \
    tests/commands/auth.test.ts \
    tests/commands/inbox-and-mount-json.test.ts \
    tests/commands/scope-members.test.ts \
    tests/commands/scope-show.test.ts \
    tests/commands/vault-resolve.test.ts
)

section "Demo smoke passed"
echo "Use docs/scenarios/project-sharing-agent-bindings-demo.md as the human-facing walkthrough."
