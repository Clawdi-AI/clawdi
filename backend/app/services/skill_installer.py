"""Install skills from GitHub repositories as tar.gz archives."""

from __future__ import annotations

import io
import logging
import tarfile
from dataclasses import dataclass

import httpx

from app.services.tar_utils import (
    MAX_DECOMPRESSED_BYTES,
    MAX_FILES,
    MAX_SKILL_TAR_BYTES,
    TarValidationError,
    parse_frontmatter,
    tar_from_content,
    validate_tar,
)

logger = logging.getLogger(__name__)

GITHUB_RAW = "https://raw.githubusercontent.com"
GITHUB_API = "https://api.github.com"


@dataclass
class SkillPackage:
    name: str
    description: str
    tar_bytes: bytes
    file_count: int
    repo: str


async def fetch_skill_from_github(repo: str, path: str | None = None) -> SkillPackage:
    """Fetch a skill directory from GitHub and package as tar.gz.

    Tries to download the full directory. Falls back to a single SKILL.md
    if the GitHub Contents API doesn't find a directory.
    """
    # Resolve the skill directory path and branch
    skill_dir, branch = await _resolve_skill_path(repo, path)

    async with httpx.AsyncClient(
        follow_redirects=True,
        timeout=httpx.Timeout(30.0, connect=10.0),
    ) as client:
        # Try to list directory contents via GitHub API
        files = await _list_github_dir(client, repo, skill_dir, branch)

        if files:
            tar_bytes, file_count, skill_md_content = await _download_and_tar(
                client, repo, branch, skill_dir, files
            )
        else:
            # Fallback: just the SKILL.md as a single-file archive
            skill_md_content = await _fetch_single_skill_md(client, repo, branch, skill_dir)
            if not skill_md_content:
                raise ValueError(f"No SKILL.md found in {repo}" + (f"/{path}" if path else ""))
            skill_key = path or repo.split("/")[-1]
            tar_bytes, file_count = tar_from_content(skill_key, skill_md_content)

    # Apply the same sanity checks we enforce on direct tar uploads. Keeps
    # the marketplace install path from producing bigger / more numerous /
    # traversal-carrying archives than we'd accept from a client.
    try:
        validate_tar(tar_bytes)
    except TarValidationError as e:
        raise ValueError(f"Built archive failed validation: {e}") from e

    # The streaming-download walk caps at MAX_DECOMPRESSED_BYTES
    # (200 MB) — fine as an upper bound on the source repo, but
    # the resulting tar.gz is what we actually store and serve.
    # Direct upload routes apply MAX_SKILL_TAR_BYTES (25 MB) to
    # the on-the-wire tar; mirror that here so a marketplace
    # install can't sneak past via a different code path.
    if len(tar_bytes) > MAX_SKILL_TAR_BYTES:
        raise ValueError(f"Built skill archive exceeds {MAX_SKILL_TAR_BYTES // (1024 * 1024)}MB")

    fm = parse_frontmatter(skill_md_content or "")
    name = fm.get("name", path or repo.split("/")[-1])
    description = fm.get("description", "")

    return SkillPackage(
        name=name,
        description=description,
        tar_bytes=tar_bytes,
        file_count=file_count,
        repo=repo,
    )


async def _resolve_skill_path(repo: str, path: str | None) -> tuple[str, str]:
    """Resolve the skill directory path and branch."""
    search_paths: list[str] = []
    if path:
        search_paths.extend(
            [
                f"skills/{path}",
                path,
                f".claude/skills/{path}",
            ]
        )
    else:
        search_paths.append("")

    branches = ["main", "master"]

    async with httpx.AsyncClient(follow_redirects=True, timeout=10.0) as client:
        for sp in search_paths:
            for branch in branches:
                skill_md_path = f"{sp}/SKILL.md" if sp else "SKILL.md"
                url = f"{GITHUB_RAW}/{repo}/refs/heads/{branch}/{skill_md_path}"
                resp = await client.head(url)
                if resp.status_code == 200:
                    return sp, branch

    raise ValueError(f"No SKILL.md found in {repo}" + (f"/{path}" if path else ""))


async def _list_github_dir(
    client: httpx.AsyncClient,
    repo: str,
    dir_path: str,
    branch: str,
    *,
    budget: int = MAX_FILES,
) -> list[dict]:
    """List files in a GitHub directory recursively via Contents API.

    `budget` is the remaining file count we'll accept before
    aborting. Without it, a malicious repo with a deeply nested
    directory tree (or a fork-bomb-shaped layout) could force us
    to issue thousands of GitHub API calls and accumulate
    arbitrarily many `download_url`s before the cap in
    `_download_and_tar` finally kicks in. We thread the running
    count through the recursion and bail the moment we'd cross
    `MAX_FILES`.
    """
    if not dir_path:
        return []

    url = f"{GITHUB_API}/repos/{repo}/contents/{dir_path}?ref={branch}"
    resp = await client.get(url)
    if resp.status_code != 200:
        return []

    data = resp.json()
    if not isinstance(data, list):
        return []

    files: list[dict] = []
    for item in data:
        if len(files) >= budget:
            raise ValueError(f"Skill repo has too many files (>{MAX_FILES})")
        if item["type"] == "file":
            files.append(
                {
                    "path": item["path"],
                    "download_url": item["download_url"],
                    "size": item.get("size", 0),
                }
            )
        elif item["type"] == "dir":
            remaining = budget - len(files)
            if remaining <= 0:
                raise ValueError(f"Skill repo has too many files (>{MAX_FILES})")
            sub_files = await _list_github_dir(client, repo, item["path"], branch, budget=remaining)
            files.extend(sub_files)

    return files


async def _download_and_tar(
    client: httpx.AsyncClient,
    repo: str,
    branch: str,
    skill_dir: str,
    files: list[dict],
) -> tuple[bytes, int, str | None]:
    """Download all files and create a tar.gz. Returns (tar_bytes, count, skill_md_content)."""
    buf = io.BytesIO()
    file_count = 0
    skill_md_content: str | None = None
    prefix_len = len(skill_dir) + 1 if skill_dir else 0  # strip leading dir from GitHub paths

    total_size = 0

    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for f in files:
            if file_count >= MAX_FILES:
                raise ValueError(f"Skill repo has too many files (>{MAX_FILES})")

            # Stream the download so a malicious repo serving a multi-GB blob
            # can't buffer it into memory before we reject it. We stop reading
            # the moment cumulative size would exceed the cap.
            chunks: list[bytes] = []
            file_size = 0
            try:
                async with client.stream("GET", f["download_url"]) as resp:
                    if resp.status_code != 200:
                        logger.warning(f"Failed to download {f['path']}: {resp.status_code}")
                        continue
                    async for chunk in resp.aiter_bytes():
                        file_size += len(chunk)
                        if total_size + file_size > MAX_DECOMPRESSED_BYTES:
                            raise ValueError(
                                f"Skill repo exceeds {MAX_DECOMPRESSED_BYTES // (1024 * 1024)}MB"
                            )
                        chunks.append(chunk)
            except ValueError:
                raise

            content = b"".join(chunks)
            total_size += file_size

            # Relative path within the skill directory
            rel_path = f["path"][prefix_len:] if prefix_len else f["path"]
            # Guard against traversal coming back from the GitHub Contents API —
            # we control the input, but validate anyway so the invariant lives
            # at the boundary where the untrusted bytes arrive, not just in
            # validate_tar() after the fact.
            if rel_path.startswith("/") or ".." in rel_path.split("/"):
                raise ValueError(f"Unsafe path in repo: {rel_path}")

            # Archive path: skill_key/relative_path
            skill_key = skill_dir.split("/")[-1] if "/" in skill_dir else skill_dir
            arc_name = f"{skill_key}/{rel_path}"

            info = tarfile.TarInfo(name=arc_name)
            info.size = len(content)
            tf.addfile(info, io.BytesIO(content))
            file_count += 1

            if rel_path == "SKILL.md":
                skill_md_content = content.decode("utf-8")

    return buf.getvalue(), file_count, skill_md_content


async def _fetch_single_skill_md(
    client: httpx.AsyncClient,
    repo: str,
    branch: str,
    skill_dir: str,
) -> str | None:
    """Fetch just the SKILL.md file content."""
    path = f"{skill_dir}/SKILL.md" if skill_dir else "SKILL.md"
    url = f"{GITHUB_RAW}/{repo}/refs/heads/{branch}/{path}"
    resp = await client.get(url)
    if resp.status_code == 200:
        return resp.text
    return None
