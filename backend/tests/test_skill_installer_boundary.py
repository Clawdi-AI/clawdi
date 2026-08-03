from __future__ import annotations

import json

import httpx
import pytest

from app.services import skill_installer


@pytest.mark.asyncio
async def test_github_contents_boundary_normalizes_official_entries() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/repos/owner/repo/contents/skills/example"
        return httpx.Response(
            200,
            json=[
                {
                    "type": "file",
                    "path": "skills/example/SKILL.md",
                    "download_url": (
                        "https://raw.githubusercontent.com/owner/repo/main/skills/example/SKILL.md"
                    ),
                    "sha": "provider-field-is-ignored",
                }
            ],
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        files = await skill_installer._list_github_dir(
            client,
            "owner/repo",
            "skills/example",
            "main",
        )

    assert files == [
        skill_installer._GitHubFile(
            path="skills/example/SKILL.md",
            download_url="https://raw.githubusercontent.com/owner/repo/main/skills/example/SKILL.md",
        )
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        {"type": "file", "path": "SKILL.md"},
        [{"type": "symlink", "path": "SKILL.md", "download_url": None}],
        [{"type": "file", "path": 42, "download_url": None}],
    ],
)
async def test_github_contents_boundary_rejects_malformed_responses(payload: object) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=json.dumps(payload).encode("utf-8"))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(skill_installer.SkillSourceError, match="invalid response"):
            await skill_installer._list_github_dir(client, "owner/repo", "skills/example", "main")


@pytest.mark.asyncio
async def test_github_contents_boundary_rejects_untrusted_download_url() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=[
                {
                    "type": "file",
                    "path": "skills/example/SKILL.md",
                    "download_url": "https://attacker.invalid/SKILL.md",
                }
            ],
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(skill_installer.SkillSourceError, match="unsafe download URL"):
            await skill_installer._list_github_dir(client, "owner/repo", "skills/example", "main")


@pytest.mark.asyncio
async def test_github_contents_boundary_does_not_treat_provider_failure_as_absence() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"message": "provider-internal-detail"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(skill_installer.SkillSourceError) as exc_info:
            await skill_installer._list_github_dir(client, "owner/repo", "skills/example", "main")

    assert "provider-internal-detail" not in str(exc_info.value)
