#!/usr/bin/env bash
# Rebuild the `preview` integration branch: origin/main + every branch you
# pass, merged in order, force-pushed to `preview`. Coolify tracks `preview`
# (REPO_REF), so pushing it redeploys the combined build.
#
# The branch is THROWAWAY by design — never review it, never merge it,
# force-pushes are expected. PR branches stay pure; testing-together
# happens here instead of pushing one PR's commits onto another's branch.
#
#   ./deploy/preview/integrate.sh cloud-ui-redesign memory-xtrace-debug
#
# Uses a temporary git worktree so your checkout, index, and untracked
# files are never touched.
set -euo pipefail

branches=("$@")
if [ ${#branches[@]} -eq 0 ]; then
	echo "usage: $0 <branch> [branch…]" >&2
	exit 1
fi

git fetch origin main "${branches[@]}"

tmp=$(mktemp -d)
git worktree add "$tmp" --detach origin/main >/dev/null
trap 'git worktree remove --force "$tmp" >/dev/null 2>&1 || true' EXIT

(
	cd "$tmp"
	for b in "${branches[@]}"; do
		if ! git merge --no-edit "origin/$b" >/dev/null; then
			echo "Merge conflict while merging origin/$b — resolve between the PR branches first." >&2
			exit 1
		fi
	done
	git push --force origin HEAD:refs/heads/preview
)

echo "preview = main + ${branches[*]} — Coolify deploy will follow the push."
