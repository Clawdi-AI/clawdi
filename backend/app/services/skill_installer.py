"""Install skills from GitHub repositories (skills.sh format)."""

import re
from dataclasses import dataclass

import httpx


@dataclass
class SkillContent:
    name: str
    description: str
    content: str
    repo: str


# Paths to search for SKILL.md in a repo
SKILL_PATHS = [
    "{path}/SKILL.md",
    "{path}/skills/SKILL.md",
    "SKILL.md",
]


def _parse_frontmatter(content: str) -> dict:
    """Extract YAML frontmatter from SKILL.md."""
    match = re.match(r"^---\s*\n(.*?)\n---\s*\n", content, re.DOTALL)
    if not match:
        return {}

    fm = {}
    for line in match.group(1).splitlines():
        if ":" in line:
            key, _, value = line.partition(":")
            fm[key.strip()] = value.strip()
    return fm


async def fetch_skill_from_github(repo: str, path: str | None = None) -> SkillContent:
    """Fetch SKILL.md from a GitHub repo.

    Args:
        repo: owner/repo format (e.g. "anthropics/skills")
        path: optional subdirectory within the repo (e.g. "code-review")
    """
    async with httpx.AsyncClient() as client:
        # Try multiple paths
        search_paths = []
        if path:
            search_paths.append(f"{path}/SKILL.md")
            search_paths.append(f"skills/{path}/SKILL.md")
        search_paths.append("SKILL.md")

        content = None
        for sp in search_paths:
            url = f"https://raw.githubusercontent.com/{repo}/main/{sp}"
            resp = await client.get(url)
            if resp.status_code == 200:
                content = resp.text
                break
            # Try master branch
            url = f"https://raw.githubusercontent.com/{repo}/master/{sp}"
            resp = await client.get(url)
            if resp.status_code == 200:
                content = resp.text
                break

        if not content:
            raise ValueError(f"No SKILL.md found in {repo}" + (f"/{path}" if path else ""))

    fm = _parse_frontmatter(content)
    name = fm.get("name", path or repo.split("/")[-1])
    description = fm.get("description", "")

    return SkillContent(
        name=name,
        description=description,
        content=content,
        repo=repo,
    )
