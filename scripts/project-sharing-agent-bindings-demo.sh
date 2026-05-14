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

section "Backend project paths"
(
  cd "$ROOT/backend"
  uv run pytest \
    tests/test_sharing_create_link.py \
    tests/test_require_share_token.py \
    tests/test_project_sharing_models_import.py \
    tests/test_agent_project_binding_model.py \
    -q
)

section "CLI user and agent contracts"
(
  cd "$ROOT/packages/cli"
  bun test \
    tests/commands/auth.test.ts \
    tests/commands/project-members.test.ts \
    tests/commands/project-show.test.ts \
    tests/commands/project-list.test.ts \
    tests/commands/vault-resolve.test.ts
)

section "Demo smoke passed"
echo "Use docs/scenarios/project-sharing-agent-bindings-demo.md as the human-facing walkthrough."
