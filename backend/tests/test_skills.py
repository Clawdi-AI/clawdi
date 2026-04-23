"""Skill upload — tar validation + metadata parsing.

Skill archives come from the user's filesystem, so the tar validator is the
first line of defense against path traversal / zip-slip attacks when the
archive is later extracted on the server or CLI.
"""

from __future__ import annotations

import io
import tarfile

import httpx
import pytest

from app.services.tar_utils import tar_from_content


@pytest.mark.asyncio
async def test_skill_upload_happy_path(client: httpx.AsyncClient):
    content = "---\nname: hello\ndescription: greet the user\n---\n# Hello\n"
    tar_bytes, _ = tar_from_content("hello", content)

    files = {"file": ("hello.tar.gz", tar_bytes, "application/gzip")}
    r = await client.post("/api/skills/upload", data={"skill_key": "hello"}, files=files)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["skill_key"] == "hello"
    assert body["name"] == "hello"
    assert body["file_count"] == 1
    assert body["version"] == 1

    # Re-uploading bumps version rather than creating a duplicate row.
    r2 = await client.post("/api/skills/upload", data={"skill_key": "hello"}, files=files)
    assert r2.status_code == 200, r2.text
    assert r2.json()["version"] == 2

    # Detail endpoint returns the SKILL.md content extracted on the server.
    detail = (await client.get("/api/skills/hello")).json()
    assert "# Hello" in (detail["content"] or "")


@pytest.mark.asyncio
async def test_skill_upload_rejects_path_traversal(client: httpx.AsyncClient):
    """Archive with ``../evil`` must be rejected before it ever hits disk."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        payload = b"bad"
        info = tarfile.TarInfo(name="../evil/SKILL.md")
        info.size = len(payload)
        tf.addfile(info, io.BytesIO(payload))

    files = {"file": ("evil.tar.gz", buf.getvalue(), "application/gzip")}
    r = await client.post("/api/skills/upload", data={"skill_key": "evil"}, files=files)
    assert r.status_code == 400, r.text
    assert "traversal" in r.text.lower() or "not allowed" in r.text.lower()


@pytest.mark.asyncio
async def test_skill_upload_requires_skill_md(client: httpx.AsyncClient):
    """A valid tar with no SKILL.md is rejected — we need the frontmatter."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        payload = b"not a skill manifest"
        info = tarfile.TarInfo(name="no-manifest/README.md")
        info.size = len(payload)
        tf.addfile(info, io.BytesIO(payload))

    files = {"file": ("nomanifest.tar.gz", buf.getvalue(), "application/gzip")}
    r = await client.post(
        "/api/skills/upload", data={"skill_key": "no-manifest"}, files=files
    )
    assert r.status_code == 400, r.text
    assert "SKILL.md" in r.text
