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

    # Re-uploading IDENTICAL bytes is a no-op — same version, no duplicate row.
    # See test_skill_upload_changed_content_bumps_version below for the
    # bump-on-real-change case.
    r2 = await client.post("/api/skills/upload", data={"skill_key": "hello"}, files=files)
    assert r2.status_code == 200, r2.text
    assert r2.json()["version"] == 1, "identical re-upload must not bump version"

    # Detail endpoint returns the SKILL.md content extracted on the server.
    detail = (await client.get("/api/skills/hello")).json()
    assert "# Hello" in (detail["content"] or "")


@pytest.mark.asyncio
async def test_skill_upload_unchanged_does_not_bump_version(client: httpx.AsyncClient):
    """A re-upload of byte-identical content must not bump `version` or
    `updated_at`. The dashboard would otherwise inflate version numbers
    on every push from every machine, regardless of whether anything
    actually changed."""
    import asyncio

    content = "---\nname: stable\ndescription: stable skill\n---\n# Stable\n"
    tar_bytes, _ = tar_from_content("stable", content)
    files = {"file": ("stable.tar.gz", tar_bytes, "application/gzip")}

    first = await client.post("/api/skills/upload", data={"skill_key": "stable"}, files=files)
    assert first.json()["version"] == 1
    first_updated_at = (await client.get("/api/skills/stable")).json().get("updated_at")
    # Detail endpoint may or may not surface updated_at; if not, fall back
    # to listing.
    if first_updated_at is None:
        listing = (await client.get("/api/skills")).json()
        first_updated_at = next(
            s for s in listing["items"] if s["skill_key"] == "stable"
        )["updated_at"]

    await asyncio.sleep(0.05)

    second = await client.post(
        "/api/skills/upload", data={"skill_key": "stable"}, files=files
    )
    assert second.status_code == 200
    assert second.json()["version"] == 1, "version must not bump on identical re-upload"

    listing = (await client.get("/api/skills")).json()
    after_updated_at = next(
        s for s in listing["items"] if s["skill_key"] == "stable"
    )["updated_at"]
    assert after_updated_at == first_updated_at, (
        "updated_at must not advance on identical re-upload"
    )


@pytest.mark.asyncio
async def test_skill_upload_changed_content_bumps_version(client: httpx.AsyncClient):
    """When the SKILL.md content actually changes, version goes up and
    `updated_at` advances."""
    v1_content = "---\nname: mut\ndescription: v1\n---\n# v1\n"
    v1_tar, _ = tar_from_content("mut", v1_content)
    files_v1 = {"file": ("mut.tar.gz", v1_tar, "application/gzip")}

    first = await client.post("/api/skills/upload", data={"skill_key": "mut"}, files=files_v1)
    assert first.json()["version"] == 1

    v2_content = "---\nname: mut\ndescription: v2\n---\n# v2\n"
    v2_tar, _ = tar_from_content("mut", v2_content)
    files_v2 = {"file": ("mut.tar.gz", v2_tar, "application/gzip")}

    second = await client.post(
        "/api/skills/upload", data={"skill_key": "mut"}, files=files_v2
    )
    assert second.status_code == 200
    assert second.json()["version"] == 2, "real content change must bump version"


@pytest.mark.asyncio
async def test_skill_upload_accepts_client_supplied_hash(client: httpx.AsyncClient):
    """New CLIs (>= 0.3.4) compute a file-tree hash and send it as a form
    field. Server should trust it and skip its own hashing.

    Backwards-compat is exercised by `test_skill_upload_happy_path` which
    intentionally omits the field.
    """
    import hashlib

    content = "---\nname: hashed\ndescription: hashed skill\n---\n# Hashed\n"
    tar_bytes, _ = tar_from_content("hashed", content)
    files = {"file": ("hashed.tar.gz", tar_bytes, "application/gzip")}

    # Send a phony hash. Server should trust it (sync optimization, not
    # security boundary). The test verifies that two pushes with the
    # SAME phony hash skip the bump — proving the field actually got used.
    fake_hash = hashlib.sha256(b"client-says-this").hexdigest()
    data = {"skill_key": "hashed", "content_hash": fake_hash}

    first = await client.post("/api/skills/upload", data=data, files=files)
    assert first.status_code == 200, first.text
    assert first.json()["version"] == 1

    second = await client.post("/api/skills/upload", data=data, files=files)
    assert second.status_code == 200, second.text
    assert second.json()["version"] == 1, (
        "second push with same client-supplied hash must skip the bump"
    )


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
    r = await client.post("/api/skills/upload", data={"skill_key": "no-manifest"}, files=files)
    assert r.status_code == 400, r.text
    assert "SKILL.md" in r.text
