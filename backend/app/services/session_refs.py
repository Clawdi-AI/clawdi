"""Server-side extraction of external entity references from session messages.

Regex over message content for GitHub URLs, `gh pr` invocations, and
short branch references. Best-effort: surface what we find, the
sidebar dedupes and renders.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Any

# GitHub repo PRs / issues / commits. Captures owner, repo, kind, number.
# Tolerant of trailing slashes, query strings, anchors.
_GH_PR_RE = re.compile(
    r"https?://github\.com/([\w.-]+)/([\w.-]+)/(pull|issues|commit)/(\w+)",
    re.IGNORECASE,
)

# Plain repo references via URL OR via shorthand "owner/repo" inside a
# `git clone` / `gh repo clone` invocation. The standalone "owner/repo"
# pattern is too noisy on its own — too many things look like that — so
# we only treat it as a repo when prefixed with one of those commands.
_GH_REPO_URL_RE = re.compile(
    r"https?://github\.com/([\w.-]+)/([\w.-]+?)(?:\.git)?(?=[/\s?#]|$)",
    re.IGNORECASE,
)
_GH_CLONE_RE = re.compile(
    r"(?:git\s+clone|gh\s+repo\s+clone)\s+(?:https?://github\.com/)?([\w.-]+)/([\w.-]+?)(?:\.git)?(?=[\s'\"]|$)",
    re.IGNORECASE,
)

# `git checkout`, `git switch`, `gh pr checkout` — surface the branch
# argument. Only matches a "branch-name-like" token (no spaces, no
# control chars). Skips obvious flags like `-b`, `-c`.
_GH_BRANCH_RE = re.compile(
    r"(?:git\s+(?:checkout|switch)|gh\s+pr\s+checkout)\s+(?:-[bc]\s+)?([A-Za-z0-9][\w./-]*)",
    re.IGNORECASE,
)

# Cap each ref list so a pathological session with thousands of `gh pr
# view` calls doesn't blow up the JSONB payload. The sidebar only
# renders the first few anyway.
_REF_LIST_CAP = 20

# Don't pay regex cost on absurd inputs. A long single string with no
# newlines (raw stack trace, base64 blob) won't have refs anyway; bail
# fast. 200 KB is plenty for any real conversation message.
_PER_MESSAGE_BUDGET = 200_000


def extract_related_refs(messages: Iterable[dict[str, Any]]) -> dict[str, list[str]]:
    """Extract GitHub PRs / repos / branches referenced anywhere in the messages.

    Best-effort:
    - URL-anchored matches are high-confidence.
    - `git clone X/Y` / `gh repo clone X/Y` shorthand is high-confidence.
    - `git checkout BRANCH` matches are medium-confidence (the BRANCH
      token might also be a sha / file path; we accept the noise).

    Returns a dict with stable keys; empty lists are pruned at the
    bottom so a NULL stored value vs. `{"prs": [], "repos": []}` is
    distinguishable downstream ("we tried, found nothing" vs. "we
    never ran the extractor").
    """
    prs: list[str] = []
    repos: list[str] = []
    branches: list[str] = []
    seen_prs: set[str] = set()
    seen_repos: set[str] = set()
    seen_branches: set[str] = set()

    for m in messages:
        content = m.get("content")
        if not isinstance(content, str) or not content:
            continue
        if len(content) > _PER_MESSAGE_BUDGET:
            # Probably a paste of raw output / base64 — skip rather
            # than burn regex cycles.
            continue

        for owner, repo, kind, num in _GH_PR_RE.findall(content):
            # Only PR / issue tracker URLs go in `prs`. Commit URLs add
            # noise to a per-session "what PRs did we touch" view; skip
            # them (they'd show up as `repos` via the URL extractor below).
            if kind.lower() in ("pull", "issues"):
                key = f"{owner}/{repo}#{num}"
                if key not in seen_prs and len(prs) < _REF_LIST_CAP:
                    prs.append(key)
                    seen_prs.add(key)

        for owner, repo in _GH_REPO_URL_RE.findall(content):
            key = f"{owner}/{repo}"
            if key not in seen_repos and len(repos) < _REF_LIST_CAP:
                repos.append(key)
                seen_repos.add(key)

        for owner, repo in _GH_CLONE_RE.findall(content):
            key = f"{owner}/{repo}"
            if key not in seen_repos and len(repos) < _REF_LIST_CAP:
                repos.append(key)
                seen_repos.add(key)

        for branch in _GH_BRANCH_RE.findall(content):
            if branch in seen_branches or len(branches) >= _REF_LIST_CAP:
                continue
            # Filter obvious non-branch tokens. `git checkout HEAD~3`,
            # `git checkout abc1234`-style shas, etc., aren't useful
            # context for the sidebar.
            if branch in ("HEAD", "FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD"):
                continue
            if re.fullmatch(r"[0-9a-fA-F]{7,40}", branch):  # sha-like (any case)
                continue
            branches.append(branch)
            seen_branches.add(branch)

    result: dict[str, list[str]] = {}
    if prs:
        result["prs"] = prs
    if repos:
        result["repos"] = repos
    if branches:
        result["branches"] = branches
    return result
