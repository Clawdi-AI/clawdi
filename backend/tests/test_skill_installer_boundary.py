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


@pytest.mark.asyncio
@pytest.mark.parametrize("skill_dir", ["", "skills/example"])
async def test_github_import_preserves_root_document_and_support_files(monkeypatch, skill_dir):
    import io
    import tarfile

    document = (
        b"---\r\nname: example\r\ndescription: valid\r\n"
        b"metadata: {version: '1.0'}\r\nx-runtime: {enabled: true}\r\n---"
    )
    files = {"SKILL.md": document, "references/notes.md": b"Reference bytes"}

    async def resolve(_repo, _path):
        return skill_dir, "main"

    def handler(request):
        if request.url.host == "api.github.com":
            return httpx.Response(
                200,
                json=[
                    {
                        "type": "file",
                        "path": f"{skill_dir}/{path}" if skill_dir else path,
                        "download_url": (
                            "https://raw.githubusercontent.com/owner/example/main/"
                            f"{skill_dir + '/' if skill_dir else ''}{path}"
                        ),
                    }
                    for path in files
                ],
            )
        return httpx.Response(
            200,
            content=next(value for path, value in files.items() if request.url.path.endswith(path)),
        )

    original_client = httpx.AsyncClient
    monkeypatch.setattr(skill_installer, "_resolve_skill_path", resolve)
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: original_client(transport=httpx.MockTransport(handler), **kwargs),
    )
    package = await skill_installer.fetch_skill_from_github("owner/example")
    assert package.name == "example" and package.file_count == 2
    with tarfile.open(fileobj=io.BytesIO(package.tar_bytes), mode="r:gz") as archive:
        assert archive.getnames() == ["example/SKILL.md", "example/references/notes.md"]
        for path, expected in files.items():
            source = archive.extractfile(f"example/{path}")
            assert source is not None and source.read() == expected
