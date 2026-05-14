#!/usr/bin/env bash
# Runnable no-Docker smoke for project sharing and agent workspace paths.
#
# This script executes tests that map to the live demo in:
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

section "Project sharing + agent workspace demo smoke"
echo "Repository: $ROOT"
echo "Story: project owner shares -> recipient accepts -> agent uses project -> vault provenance -> revoke cleanup"

section "Backend role paths"
(
  cd "$ROOT/backend"
  uv run pytest \
    tests/test_project_agent_role_paths.py \
    tests/test_me_routes.py \
    tests/test_share_redeem_routes.py \
    tests/test_sharing_create_link.py \
    tests/test_sharing_invitations.py \
    tests/test_sharing_list_revoke.py \
    tests/test_agent_project_bindings_routes.py \
    tests/test_project_visibility_shared.py \
    tests/test_vault.py \
    tests/test_skills.py \
    -q
)

section "CLI user and agent contracts"
(
  cd "$ROOT/packages/cli"
  bun test \
    tests/commands/agent-projects.test.ts \
    tests/commands/auth.test.ts \
    tests/commands/project-list.test.ts \
    tests/commands/project-members.test.ts \
    tests/commands/project-show.test.ts \
    tests/commands/vault-resolve.test.ts
)

section "Demo smoke passed"
echo "Use docs/scenarios/project-sharing-agent-bindings-demo.md as the human-facing walkthrough."
