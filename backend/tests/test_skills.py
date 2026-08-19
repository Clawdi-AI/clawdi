"""Skill upload — tar validation + metadata parsing.

Skill archives come from the user's filesystem, so the tar validator is the
first line of defense against path traversal / zip-slip attacks when the
archive is later extracted on the server or CLI.
"""

from __future__ import annotations

import io
import logging
import tarfile
import uuid

import httpx
import pytest
import yaml
from sqlalchemy import select

from app.core.auth import AuthContext
from app.core.skill_sync_protocol import (
    SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V1,
    SKILL_SYNC_PROTOCOL_HEADER,
)
from app.models.skill import Skill
from app.models.user import User
from app.routes import skills as skill_routes
from app.routes.skills import _compute_file_tree_hash
from app.services.file_store import FileStore, get_file_store
from app.services.skill_installer import SkillPackage
from app.services.tar_utils import tar_from_content

pytestmark = pytest.mark.committed_db

AGENT_SKILL_SYNC_HEADERS = {
    SKILL_SYNC_PROTOCOL_HEADER: SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V1,
}


def _archive_with_files(skill_key: str, files: dict[str, bytes]) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for relative_path, content in files.items():
            info = tarfile.TarInfo(name=f"{skill_key}/{relative_path}")
            info.size = len(content)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(content))
    return output.getvalue()


@pytest.mark.asyncio
async def test_skill_upload_happy_path(client: httpx.AsyncClient, project_id: str):
    content = "---\nname: hello\ndescription: greet the user\n---\n# Hello\n"
    tar_bytes, _ = tar_from_content("hello", content)

    files = {"file": ("hello.tar.gz", tar_bytes, "application/gzip")}
    r = await client.post(
        f"/v1/projects/{project_id}/skills/upload", data={"skill_key": "hello"}, files=files
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["skill_key"] == "hello"
    assert body["name"] == "hello"
    assert body["file_count"] == 1
    assert body["version"] == 1

    # Re-uploading IDENTICAL bytes is a no-op — same version, no duplicate row.
    # See test_skill_upload_changed_content_bumps_version below for the
    # bump-on-real-change case.
    r2 = await client.post(
        f"/v1/projects/{project_id}/skills/upload", data={"skill_key": "hello"}, files=files
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["version"] == 1, "identical re-upload must not bump version"

    # Detail endpoint returns the SKILL.md content extracted on the server.
    detail = (await client.get("/v1/skills/hello")).json()
    assert "# Hello" in (detail["content"] or "")


@pytest.mark.asyncio
async def test_project_copy_move_preconditions_preserve_existing_skill(
    client: httpx.AsyncClient,
    project_id: str,
):
    skill_key = "conflict-safe-copy"
    original, _ = tar_from_content(
        skill_key,
        "---\nname: Conflict safe copy\ndescription: original\n---\n# Original\n",
    )
    created = await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": skill_key},
        files={"file": ("original.tar.gz", original, "application/gzip")},
    )
    assert created.status_code == 200, created.text
    original_hash = created.json()["content_hash"]

    replacement, _ = tar_from_content(
        skill_key,
        "---\nname: Conflict safe copy\ndescription: replacement\n---\n# Replacement\n",
    )
    conflict = await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": skill_key, "create_only": "true"},
        files={"file": ("replacement.tar.gz", replacement, "application/gzip")},
    )
    assert conflict.status_code == 409, conflict.text
    assert conflict.json()["detail"]["code"] == "skill_name_conflict"

    updated = await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": skill_key},
        files={"file": ("replacement.tar.gz", replacement, "application/gzip")},
    )
    assert updated.status_code == 200, updated.text
    replacement_hash = updated.json()["content_hash"]

    stale_delete = await client.delete(
        f"/v1/projects/{project_id}/skills/{skill_key}",
        params={"expected_content_hash": original_hash},
    )
    assert stale_delete.status_code == 412, stale_delete.text
    assert stale_delete.json()["detail"]["current_content_hash"] == replacement_hash
    current = await client.get(f"/v1/projects/{project_id}/skills/{skill_key}/download")
    assert current.status_code == 200, current.text
    assert current.content == replacement

    deleted = await client.delete(
        f"/v1/projects/{project_id}/skills/{skill_key}",
        params={"expected_content_hash": replacement_hash},
    )
    assert deleted.status_code == 200, deleted.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "content",
    [
        "---\nname: invalid\ndescription: metadata\n---\n# Body\x00\n",
        '---\nname: "invalid\\0name"\ndescription: metadata\n---\n# Body\n',
        '---\nname: invalid\ndescription: "invalid\\0description"\n---\n# Body\n',
    ],
)
async def test_skill_upload_rejects_nul_text_before_persistence(
    client: httpx.AsyncClient,
    project_id: str,
    content: str,
):
    tar_bytes, _ = tar_from_content("invalid-nul", content)

    response = await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": "invalid-nul"},
        files={"file": ("invalid-nul.tar.gz", tar_bytes, "application/gzip")},
    )

    assert response.status_code == 400, response.text
    assert response.json()["detail"] == {
        "code": "invalid_skill_text",
        "message": "SKILL.md must not contain NUL characters.",
    }
    missing = await client.get(f"/v1/projects/{project_id}/skills/invalid-nul")
    assert missing.status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize("parser_error", [RecursionError, UnicodeError])
async def test_skill_upload_treats_yaml_parser_failures_as_empty_frontmatter(
    client: httpx.AsyncClient,
    project_id: str,
    monkeypatch: pytest.MonkeyPatch,
    parser_error: type[Exception],
):
    def fail_to_parse(_raw: str):
        raise parser_error("pathological frontmatter")

    monkeypatch.setattr(yaml, "safe_load", fail_to_parse)
    tar_bytes, _ = tar_from_content(
        "parser-failure",
        "---\nname: ignored\ndescription: ignored\n---\nInstructions.\n",
    )

    response = await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": "parser-failure"},
        files={"file": ("parser-failure.tar.gz", tar_bytes, "application/gzip")},
    )

    assert response.status_code == 200, response.text
    assert response.json()["name"] == "parser-failure"


@pytest.mark.asyncio
async def test_dashboard_edit_with_stale_content_hash_returns_412(
    client: httpx.AsyncClient, project_id: str
):
    """Regression: the dashboard edit endpoint takes `content_hash` as
    the editor's last-known hash (If-Match precondition), NOT as the
    hash of the bytes being submitted. Pre-fix the value was
    forwarded into the upload pipeline as the new-content hash, so
    sending the OLD hash for a real edit either:
      - matched the existing row and short-circuited as `unchanged`,
        silently dropping the user's edit, or
      - persisted a hash that didn't match the stored bytes.
    With the fix, an outdated `content_hash` returns 412 so the
    editor can prompt for re-fetch instead of clobbering or losing
    work."""
    # Seed a skill so we have a known current hash.
    seed_content = "---\nname: editme\ndescription: original\n---\n# Original\n"
    tar_bytes, _ = tar_from_content("editme", seed_content)
    seed = await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": "editme"},
        files={"file": ("editme.tar.gz", tar_bytes, "application/gzip")},
    )
    assert seed.status_code == 200, seed.text
    current_hash = seed.json()["content_hash"]
    assert current_hash, "seed upload must echo a content_hash for the test"

    # Stale `content_hash` (anything not the current row hash) -> 412.
    stale = "0" * 64
    r = await client.put(
        f"/v1/projects/{project_id}/skills/editme/content",
        json={
            "name": "Edit me",
            "description": "edited",
            "instructions": "# Edited",
            "content_hash": stale,
        },
    )
    assert r.status_code == 412, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "stale_content"
    assert detail["current_content_hash"] == current_hash

    # And the row was NOT updated.
    detail_get = await client.get(f"/v1/projects/{project_id}/skills/editme")
    assert "# Original" in detail_get.json().get("content", "")

    # Sending the CURRENT hash succeeds. Schema requires 64-char
    # lowercase hex; the seeded hash satisfies that.
    ok = await client.put(
        f"/v1/projects/{project_id}/skills/editme/content",
        json={
            "name": "Edit me",
            "description": "edited",
            "instructions": "# Edited",
            "content_hash": current_hash,
        },
    )
    assert ok.status_code == 200, ok.text
    after = await client.get(f"/v1/projects/{project_id}/skills/editme")
    assert "# Edited" in after.json().get("content", "")


@pytest.mark.asyncio
async def test_dashboard_edit_requires_content_hash(client: httpx.AsyncClient, project_id: str):
    """Modern Web edits are conflict-safe and never silently overwrite."""
    seed_content = "---\nname: lww\ndescription: original\n---\n# Original\n"
    tar_bytes, _ = tar_from_content("lww", seed_content)
    await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": "lww"},
        files={"file": ("lww.tar.gz", tar_bytes, "application/gzip")},
    )

    r = await client.put(
        f"/v1/projects/{project_id}/skills/lww/content",
        json={
            "name": "LWW",
            "description": "edited",
            "instructions": "# Edited",
        },
    )
    assert r.status_code == 422, r.text
    after = await client.get(f"/v1/projects/{project_id}/skills/lww")
    assert "# Original" in after.json().get("content", "")


@pytest.mark.asyncio
async def test_native_create_is_project_explicit_and_conflict_safe(
    client: httpx.AsyncClient,
    project_id: str,
):
    created = await client.post(
        f"/v1/projects/{project_id}/skills",
        json={
            "name": "Review pull requests",
            "description": "Review code carefully",
            "instructions": "Check correctness, tests, and rollback safety.",
        },
    )
    assert created.status_code == 200, created.text
    assert created.json()["skill_key"] == "review-pull-requests"
    detail = await client.get(f"/v1/projects/{project_id}/skills/review-pull-requests")
    assert detail.status_code == 200, detail.text
    assert detail.json()["name"] == "Review pull requests"
    assert detail.json()["description"] == "Review code carefully"
    assert "Check correctness" in detail.json()["content"]

    duplicate = await client.post(
        f"/v1/projects/{project_id}/skills",
        json={
            "name": "Review pull requests",
            "description": "A conflicting create",
            "instructions": "This must not overwrite the first Skill.",
        },
    )
    assert duplicate.status_code == 409, duplicate.text
    assert duplicate.json()["detail"]["code"] == "skill_name_conflict"
    unchanged = await client.get(f"/v1/projects/{project_id}/skills/review-pull-requests")
    assert "Check correctness" in unchanged.json()["content"]


@pytest.mark.asyncio
async def test_edit_preserves_imported_support_files(
    client: httpx.AsyncClient,
    project_id: str,
):
    skill_key = "preserve-files"
    original_md = b"""---
name: Preserve files
description: Imported
license: Apache-2.0
compatibility:
  runtimes:
    - openclaw
    - hermes
  options:
    retries: 3
    strict: true
tags:
  - review
  - safety
---

Use the references.
"""
    archive = _archive_with_files(
        skill_key,
        {
            "SKILL.md": original_md,
            "references/notes.md": b"# Important notes\n",
            "scripts/check.sh": b"#!/bin/sh\nexit 0\n",
        },
    )
    uploaded = await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": skill_key},
        files={"file": ("preserve-files.tar.gz", archive, "application/gzip")},
    )
    assert uploaded.status_code == 200, uploaded.text

    edited = await client.put(
        f"/v1/projects/{project_id}/skills/{skill_key}/content",
        json={
            "name": "Preserve files",
            "description": None,
            "instructions": "Read references/notes.md, then run scripts/check.sh.",
            "content_hash": uploaded.json()["content_hash"],
        },
    )
    assert edited.status_code == 200, edited.text
    downloaded = await client.get(f"/v1/projects/{project_id}/skills/{skill_key}/download")
    assert downloaded.status_code == 200, downloaded.text
    with tarfile.open(fileobj=io.BytesIO(downloaded.content), mode="r:gz") as result:
        names = set(result.getnames())
        assert f"{skill_key}/references/notes.md" in names
        assert f"{skill_key}/scripts/check.sh" in names
        notes = result.extractfile(f"{skill_key}/references/notes.md")
        script = result.extractfile(f"{skill_key}/scripts/check.sh")
        skill_md = result.extractfile(f"{skill_key}/SKILL.md")
        assert notes is not None and notes.read() == b"# Important notes\n"
        assert script is not None and script.read() == b"#!/bin/sh\nexit 0\n"
        assert skill_md is not None
        rendered = skill_md.read().decode()
    raw_frontmatter, body = rendered.removeprefix("---\n").split("\n---\n", 1)
    metadata = yaml.safe_load(raw_frontmatter)
    assert metadata == {
        "name": "Preserve files",
        "license": "Apache-2.0",
        "compatibility": {
            "runtimes": ["openclaw", "hermes"],
            "options": {"retries": 3, "strict": True},
        },
        "tags": ["review", "safety"],
    }
    assert body.strip() == "Read references/notes.md, then run scripts/check.sh."


@pytest.mark.asyncio
async def test_edit_fails_closed_without_exact_root_skill_md(
    client: httpx.AsyncClient,
    project_id: str,
):
    skill_key = "missing-root-document"
    archive = _archive_with_files(
        skill_key,
        {
            "references/SKILL.md": b"---\nname: Nested only\nunknown: keep-me\n---\nNested.\n",
            "references/notes.md": b"Must remain unchanged.\n",
        },
    )
    uploaded = await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": skill_key},
        files={"file": ("missing-root-document.tar.gz", archive, "application/gzip")},
    )
    assert uploaded.status_code == 200, uploaded.text

    edited = await client.put(
        f"/v1/projects/{project_id}/skills/{skill_key}/content",
        json={
            "name": "Replacement",
            "description": None,
            "instructions": "This must not be written.",
            "content_hash": uploaded.json()["content_hash"],
        },
    )
    assert edited.status_code == 409, edited.text

    downloaded = await client.get(f"/v1/projects/{project_id}/skills/{skill_key}/download")
    assert downloaded.status_code == 200, downloaded.text
    assert downloaded.content == archive


@pytest.mark.asyncio
async def test_failed_db_commit_cannot_change_committed_skill_object_identity(
    client: httpx.AsyncClient,
    db_session,
    seed_user: User,
    project_id: str,
    monkeypatch: pytest.MonkeyPatch,
):
    skill_key = "immutable-object"
    old_archive, _ = tar_from_content(
        skill_key,
        "---\nname: Immutable object\ndescription: old\n---\n# Old\n",
    )
    seeded = await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": skill_key},
        files={"file": ("immutable-object.tar.gz", old_archive, "application/gzip")},
    )
    assert seeded.status_code == 200, seeded.text
    project_uuid = uuid.UUID(project_id)
    committed = (
        await db_session.execute(
            select(Skill).where(
                Skill.project_id == project_uuid,
                Skill.skill_key == skill_key,
                Skill.is_active,
            )
        )
    ).scalar_one()
    old_file_key = committed.file_key
    old_hash = committed.content_hash
    assert old_file_key is not None
    file_store = get_file_store()
    assert await file_store.get(old_file_key) == old_archive

    new_archive, _ = tar_from_content(
        skill_key,
        "---\nname: Immutable object\ndescription: new\n---\n# New\n",
    )
    new_hash = _compute_file_tree_hash(new_archive, skill_key)
    new_file_key = skill_routes._file_key(
        seed_user.id,
        project_uuid,
        skill_key,
        new_hash,
    )
    assert new_file_key != old_file_key
    real_commit = db_session.commit
    commit_count = 0

    async def fail_final_commit() -> None:
        nonlocal commit_count
        commit_count += 1
        if commit_count == 2:
            await db_session.rollback()
            raise RuntimeError("injected commit failure")
        await real_commit()

    monkeypatch.setattr(db_session, "commit", fail_final_commit)
    with pytest.raises(RuntimeError, match="injected commit failure"):
        await skill_routes._do_upload_skill(
            db=db_session,
            auth=AuthContext(user=seed_user),
            project_id=project_uuid,
            skill_key=skill_key,
            data=new_archive,
            content_hash=None,
        )

    row = (
        await db_session.execute(
            select(Skill).where(
                Skill.project_id == project_uuid,
                Skill.skill_key == skill_key,
                Skill.is_active,
            )
        )
    ).scalar_one()
    assert row.content_hash == old_hash
    assert row.file_key == old_file_key
    assert await file_store.get(old_file_key) == old_archive
    assert await file_store.exists(new_file_key) is True
    await file_store.delete(new_file_key)


@pytest.mark.asyncio
async def test_skill_upload_unchanged_does_not_bump_version(
    client: httpx.AsyncClient, project_id: str
):
    """A re-upload of byte-identical content must not bump `version` or
    `updated_at`. The dashboard would otherwise inflate version numbers
    on every push from every machine, regardless of whether anything
    actually changed."""
    import asyncio

    content = "---\nname: stable\ndescription: stable skill\n---\n# Stable\n"
    tar_bytes, _ = tar_from_content("stable", content)
    files = {"file": ("stable.tar.gz", tar_bytes, "application/gzip")}

    first = await client.post(
        f"/v1/projects/{project_id}/skills/upload", data={"skill_key": "stable"}, files=files
    )
    assert first.json()["version"] == 1
    first_updated_at = (await client.get("/v1/skills/stable")).json().get("updated_at")
    # Detail endpoint may or may not surface updated_at; if not, fall back
    # to listing.
    if first_updated_at is None:
        listing = (await client.get("/v1/skills")).json()
        first_updated_at = next(s for s in listing["items"] if s["skill_key"] == "stable")[
            "updated_at"
        ]

    await asyncio.sleep(0.05)

    second = await client.post(
        f"/v1/projects/{project_id}/skills/upload", data={"skill_key": "stable"}, files=files
    )
    assert second.status_code == 200
    assert second.json()["version"] == 1, "version must not bump on identical re-upload"

    listing = (await client.get("/v1/skills")).json()
    after_updated_at = next(s for s in listing["items"] if s["skill_key"] == "stable")["updated_at"]
    assert after_updated_at == first_updated_at, (
        "updated_at must not advance on identical re-upload"
    )


@pytest.mark.asyncio
async def test_skill_upload_changed_content_bumps_version(
    client: httpx.AsyncClient, project_id: str
):
    """When the SKILL.md content actually changes, version goes up and
    `updated_at` advances."""
    v1_content = "---\nname: mut\ndescription: v1\n---\n# v1\n"
    v1_tar, _ = tar_from_content("mut", v1_content)
    files_v1 = {"file": ("mut.tar.gz", v1_tar, "application/gzip")}

    first = await client.post(
        f"/v1/projects/{project_id}/skills/upload", data={"skill_key": "mut"}, files=files_v1
    )
    assert first.json()["version"] == 1

    v2_content = "---\nname: mut\ndescription: v2\n---\n# v2\n"
    v2_tar, _ = tar_from_content("mut", v2_content)
    files_v2 = {"file": ("mut.tar.gz", v2_tar, "application/gzip")}

    second = await client.post(
        f"/v1/projects/{project_id}/skills/upload", data={"skill_key": "mut"}, files=files_v2
    )
    assert second.status_code == 200
    assert second.json()["version"] == 2, "real content change must bump version"


@pytest.mark.asyncio
async def test_skill_upload_verifies_client_supplied_hash(
    client: httpx.AsyncClient, project_id: str
):
    """The server verifies rather than trusting a caller-supplied tree hash."""
    import hashlib

    content = "---\nname: hashed\ndescription: hashed skill\n---\n# Hashed\n"
    tar_bytes, _ = tar_from_content("hashed", content)
    files = {"file": ("hashed.tar.gz", tar_bytes, "application/gzip")}

    fake_hash = hashlib.sha256(b"client-says-this").hexdigest()
    data = {"skill_key": "hashed", "content_hash": fake_hash}

    mismatch = await client.post(f"/v1/projects/{project_id}/skills/upload", data=data, files=files)
    assert mismatch.status_code == 400, mismatch.text
    assert mismatch.json()["detail"]["code"] == "skill_content_hash_mismatch"

    first = await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": "hashed"},
        files=files,
    )
    assert first.status_code == 200, first.text
    computed_hash = first.json()["content_hash"]
    second = await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": "hashed", "content_hash": computed_hash},
        files=files,
    )
    assert second.status_code == 200, second.text
    assert second.json()["version"] == 1


@pytest.mark.asyncio
async def test_skill_upload_rejects_path_traversal(client: httpx.AsyncClient, project_id: str):
    """Archive with ``../evil`` must be rejected before it ever hits disk.

    The 400 response body is intentionally generic (no echo of the
    attacker-controlled tar member name) — assertion checks status
    only. The actionable detail lives in server logs.
    """
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        payload = b"bad"
        info = tarfile.TarInfo(name="../evil/SKILL.md")
        info.size = len(payload)
        tf.addfile(info, io.BytesIO(payload))

    files = {"file": ("evil.tar.gz", buf.getvalue(), "application/gzip")}
    r = await client.post(
        f"/v1/projects/{project_id}/skills/upload", data={"skill_key": "evil"}, files=files
    )
    assert r.status_code == 400, r.text
    # Positive contract: server returns the fixed validation
    # message. Without this assertion the test would pass for any
    # 400 (e.g. a missing-field error) and we'd lose coverage that
    # the tar specifically failed validate_tar.
    assert "archive validation failed" in r.text.lower()
    # Negative contract: body must NOT echo the attacker-supplied
    # member name — that would be an uncontrolled reflection vector.
    assert "../evil" not in r.text


@pytest.mark.asyncio
async def test_skill_upload_rejects_reserved_management_metadata(
    client: httpx.AsyncClient, project_id: str
):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name, payload in (
            ("example/SKILL.md", b"# Example\n"),
            ("example/.clawdi-managed.json", b"{}\n"),
        ):
            info = tarfile.TarInfo(name=name)
            info.size = len(payload)
            tf.addfile(info, io.BytesIO(payload))
    response = await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": "example"},
        files={"file": ("example.tar.gz", buf.getvalue(), "application/gzip")},
    )
    assert response.status_code == 400, response.text
    assert "archive validation failed" in response.text.lower()
    assert ".clawdi-managed" not in response.text


@pytest.mark.asyncio
async def test_marketplace_install_rejects_reserved_management_metadata(
    client: httpx.AsyncClient, project_id: str, monkeypatch: pytest.MonkeyPatch
):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name, payload in (
            ("example/SKILL.md", b"# Example\n"),
            ("example/.clawdi-managed.json", b"{}\n"),
        ):
            info = tarfile.TarInfo(name=name)
            info.size = len(payload)
            tf.addfile(info, io.BytesIO(payload))

    async def fake_fetch(_repo: str, _path: str | None = None) -> SkillPackage:
        return SkillPackage(
            name="example",
            description="example",
            tar_bytes=buf.getvalue(),
            file_count=2,
            repo="owner/repo",
        )

    monkeypatch.setattr("app.services.skill_installer.fetch_skill_from_github", fake_fetch)
    response = await client.post(
        f"/v1/projects/{project_id}/skills/install",
        json={"repo": "owner/repo", "path": "example"},
    )
    assert response.status_code == 400, response.text
    assert "archive validation failed" in response.text.lower()
    assert ".clawdi-managed" not in response.text


@pytest.mark.asyncio
async def test_skill_upload_rejects_archive_rooted_at_wrong_path(
    client: httpx.AsyncClient, project_id: str
):
    """Round-45 P2 regression: an upload with `skill_key=category/foo`
    but a tar rooted at `foo/SKILL.md` was silently accepted.
    `_compute_file_tree_hash` stripped 2 leading components → empty
    relative-path tree → wrong stored hash. The bytes were stored
    as-is and a later download/extract dropped `foo/` at the skills
    root instead of `category/foo/` — broke restore on every other
    machine.

    The validator now refuses any archive whose entries don't sit
    under `${skill_key}/`. The CLI's `tarSkillDir(dir, _, skillKey)`
    already produces correctly-prefixed archives, so this only
    catches a misbehaving client / tampered upload.
    """
    content = "---\nname: x\ndescription: y\n---\n# x\n"
    # Tar rooted at "foo" — single-component layout — but uploaded
    # with the nested key `category/foo`.
    flat_tar, _ = tar_from_content("foo", content)
    files = {"file": ("flat.tar.gz", flat_tar, "application/gzip")}
    r = await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": "category/foo"},
        files=files,
    )
    assert r.status_code == 400, r.text
    assert "archive root" in r.text.lower()


@pytest.mark.asyncio
async def test_skill_upload_rejects_reserved_routing_suffix(
    client: httpx.AsyncClient, project_id: str
):
    """Reserved-suffix guard on skill_key. Round 36's `:path`
    converter on `/{skill_key:path}` made nested keys round-trip,
    but `/skills/{skill_key:path}/download` (and `/content`,
    `/install`) declared earlier mean a key literally named
    `team/download` would be unreachable through the bare
    detail GET — Starlette would match the `/download` suffix
    route first with `skill_key='team'`. We refuse such keys at
    upload time so the routing tree stays unambiguous."""
    content = "---\nname: x\ndescription: y\n---\n# x\n"
    for evil_key in ("team/download", "alpha/beta/content", "foo/install"):
        tar_bytes, _ = tar_from_content(evil_key, content)
        files = {"file": ("x.tar.gz", tar_bytes, "application/gzip")}
        r = await client.post(
            f"/v1/projects/{project_id}/skills/upload",
            data={"skill_key": evil_key},
            files=files,
        )
        assert r.status_code == 400, (evil_key, r.status_code, r.text)
        assert "reserved suffix" in r.text.lower(), (evil_key, r.text)

    # Single-component keys that BE a reserved word are fine —
    # there's no routing collision at the one-segment level
    # (the route is `/skills/{skill_key:path}/download`, not
    # `/skills/download`).
    tar_bytes, _ = tar_from_content("download", content)
    files = {"file": ("x.tar.gz", tar_bytes, "application/gzip")}
    r = await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": "download"},
        files=files,
    )
    assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_skill_upload_rejects_overlength_nested_key(
    client: httpx.AsyncClient, project_id: str
):
    """Round-38 P2 regression: pre-fix the per-component regex
    accepted up to 4 × 200 = 800 chars, but `Skill.skill_key` is
    `String(200)`. A 400-char nested key passed FastAPI
    validation, then blew up at INSERT with a column-width
    error — accepted at validation, dead at persistence. The
    request-time `max_length=MAX_SKILL_KEY_LEN` now 422s
    before reaching the DB.
    """
    content = "---\nname: x\ndescription: y\n---\n# x\n"
    tar_bytes, _ = tar_from_content("x", content)
    files = {"file": ("x.tar.gz", tar_bytes, "application/gzip")}

    # 4 components × 100 chars each + 3 slashes = 403 chars.
    # Pattern would match (each component well-formed) but
    # exceeds the 200-char column width.
    long_key = "/".join("x" * 100 for _ in range(4))
    assert len(long_key) > 200

    r = await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": long_key},
        files=files,
    )
    assert r.status_code == 422, r.text


@pytest.mark.asyncio
async def test_skill_upload_accepts_hermes_nested_key(client: httpx.AsyncClient, project_id: str):
    """Round-35 P2 regression: Hermes layouts nest skills under
    a category dir (`~/.hermes/skills/category/foo/SKILL.md`),
    so the adapter emits `category/foo` as `skill_key`. The
    pre-fix backend pattern rejected `/` and the upload 422'd,
    silently dropping nested Hermes skills from sync. The new
    pattern allows up to 4 components separated by '/' with
    each component required to start with [A-Za-z0-9] (so
    '..' / '.foo' hidden segments still fail closed)."""
    content = "---\nname: nested\ndescription: hermes layout\n---\n# Nested\n"
    # Tar must be rooted at the SAME path as the declared
    # skill_key — the upload route validates the layout matches
    # (round-45 fix). `tar_from_content` builds entries under
    # `<arg>/SKILL.md` so passing the full nested key produces
    # `category/foo/SKILL.md` — what the daemon's `tarSkillDir`
    # also emits.
    tar_bytes, _ = tar_from_content("category/foo", content)
    files = {"file": ("nested.tar.gz", tar_bytes, "application/gzip")}
    r = await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": "category/foo"},
        files=files,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["skill_key"] == "category/foo"

    # Path traversal still rejected — `..` cannot start a
    # component (regex requires alphanum first character) and a
    # leading-slash key is empty-first-component.
    flat_tar, _ = tar_from_content("evil", content)
    flat_files = {"file": ("evil.tar.gz", flat_tar, "application/gzip")}
    for evil_key in ("../escape", "category/../escape", "/abs", ".hidden"):
        r_evil = await client.post(
            f"/v1/projects/{project_id}/skills/upload",
            data={"skill_key": evil_key},
            files=flat_files,
        )
        assert r_evil.status_code == 422, f"{evil_key} should 422, got {r_evil.status_code}"


def test_compute_file_tree_hash_strips_nested_skill_key():
    """Round-37 P2 regression: hash MUST treat the full
    `<a>/<b>/...` skill_key as the skill-dir prefix to strip,
    not just the first segment. Pre-fix the dashboard edit
    `tar_from_content("category/foo", md)` produced
    `category/foo/SKILL.md`; the hash stripped only the first
    segment ("category"), so the relative path was
    `foo/SKILL.md`. The CLI hashes paths inside the skill dir
    so its computed path is `SKILL.md`. Hashes never matched →
    every reconcile re-uploaded the same local bytes instead of converging.

    This unit test pins the algorithm: same payload, different
    skill_key (flat vs nested), different number of stripped
    segments → identical hash. If the backend ever regresses
    to hardcoded strip-1, this fails immediately."""
    import io
    import tarfile

    from app.routes.skills import _compute_file_tree_hash

    def make_tar(prefix: str, files: dict[str, bytes]) -> bytes:
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tf:
            for rel, content in files.items():
                info = tarfile.TarInfo(name=f"{prefix}/{rel}")
                info.size = len(content)
                tf.addfile(info, io.BytesIO(content))
        return buf.getvalue()

    payload = {
        "SKILL.md": b"---\nname: x\ndescription: y\n---\n# x\n",
        "references/notes.md": b"# deep",
    }

    flat_tar = make_tar("flat-skill", payload)
    nested_tar = make_tar("category/foo", payload)

    flat_hash = _compute_file_tree_hash(flat_tar, "flat-skill")
    nested_hash = _compute_file_tree_hash(nested_tar, "category/foo")
    # Same payload → same hash regardless of skill_key shape.
    assert flat_hash == nested_hash, (flat_hash, nested_hash)

    # Sanity: legacy (no skill_key) still strips one segment, so
    # nested tar hashed without skill_key produces a DIFFERENT hash
    # (paths include the `foo/` prefix). This is the pre-fix bug we
    # would re-introduce by losing the skill_key parameter.
    legacy_nested = _compute_file_tree_hash(nested_tar)
    assert legacy_nested != nested_hash, (
        "regressed: nested tar hash unchanged with/without skill_key"
    )


@pytest.mark.asyncio
async def test_nested_skill_round_trips_through_project_routes(
    client: httpx.AsyncClient, project_id: str
):
    """Round-36 P2 regression: project GET / download / DELETE routes
    must capture slash-bearing skill_keys (Hermes layout). Pre-fix
    the `{skill_key}` path param refused to match a URL containing
    `/`, so a Hermes nested skill could be uploaded but not opened
    / downloaded / deleted via the project routes — bricked by the
    ASGI router. The fix uses Starlette's `:path` converter and
    declares the bare GET AFTER `/{skill_key:path}/download` so the
    download regex is tried first (FastAPI matches in declaration
    order, not by specificity).
    """
    content = "---\nname: nested\ndescription: hermes layout\n---\n# Nested\n"
    nested_key = "category/foo"
    # Archive must be rooted at the declared key (round-45).
    tar_bytes, _ = tar_from_content(nested_key, content)
    files = {"file": ("nested.tar.gz", tar_bytes, "application/gzip")}

    # Upload via the project form-data route.
    r_upload = await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": nested_key},
        files=files,
    )
    assert r_upload.status_code == 200, r_upload.text

    # GET detail with nested key (literal `/` in URL path).
    r_get = await client.get(f"/v1/projects/{project_id}/skills/{nested_key}")
    assert r_get.status_code == 200, r_get.text
    assert r_get.json()["skill_key"] == nested_key

    # GET download — most-specific subroute. The reorder is the
    # whole point of this test: the bare GET must NOT have eaten
    # the URL `/api/projects/{sid}/skills/category/foo/download` as
    # `skill_key="category/foo/download"`.
    r_download = await client.get(f"/v1/projects/{project_id}/skills/{nested_key}/download")
    assert r_download.status_code == 200, r_download.text
    assert r_download.headers["content-type"].startswith("application/gzip")

    # PUT content — also a more-specific subroute; ordering matters
    # the same way it does for download.
    r_put = await client.put(
        f"/v1/projects/{project_id}/skills/{nested_key}/content",
        json={
            "name": "Nested",
            "description": "edited via project PUT",
            "instructions": "# Nested v2",
            "content_hash": r_upload.json()["content_hash"],
        },
    )
    assert r_put.status_code == 200, r_put.text

    # DELETE last — verifies the deletion route also accepts nested
    # keys so an uninstall via the project DELETE actually removes
    # the row.
    r_delete = await client.delete(f"/v1/projects/{project_id}/skills/{nested_key}")
    assert r_delete.status_code == 200, r_delete.text
    r_get_after = await client.get(f"/v1/projects/{project_id}/skills/{nested_key}")
    assert r_get_after.status_code == 404, r_get_after.text


@pytest.mark.asyncio
async def test_scope_skill_read_routes_remain_compat_aliases(
    client: httpx.AsyncClient, project_id: str
):
    """Prod compatibility: binaries built during the Scope -> Project
    migration still call `/api/scopes/{id}/skills/...` for reads.
    Project ids preserve the old scope id, so these should behave like
    the project-explicit read routes instead of 404ing at the router.
    """
    content = "---\nname: compat\ndescription: old scope URL\n---\n# Compat\n"
    skill_key = "compat/nested"
    tar_bytes, _ = tar_from_content(skill_key, content)
    upload = await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": skill_key},
        files={"file": ("compat-nested.tar.gz", tar_bytes, "application/gzip")},
    )
    assert upload.status_code == 200, upload.text

    detail = await client.get(f"/api/scopes/{project_id}/skills/{skill_key}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["skill_key"] == skill_key
    assert detail.json()["project_id"] == project_id

    download = await client.get(f"/api/scopes/{project_id}/skills/{skill_key}/download")
    assert download.status_code == 200, download.text
    assert download.headers["content-type"].startswith("application/gzip")


@pytest.mark.asyncio
async def test_malformed_skill_upload_logs_validation_reason(
    client: httpx.AsyncClient,
    project_id: str,
    caplog: pytest.LogCaptureFixture,
):
    caplog.set_level(logging.WARNING, logger="app.main")

    response = await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": "missing-file"},
        headers={"User-Agent": "clawdi-cli/test"},
    )

    assert response.status_code == 422
    messages = [record.getMessage() for record in caplog.records]
    assert any(
        "request_validation_failed" in message
        and "/skills/upload" in message
        and "clawdi-cli/test" in message
        and "content_type=" in message
        and "file" in message
        for message in messages
    )


@pytest.mark.asyncio
async def test_skill_upload_requires_skill_md(client: httpx.AsyncClient, project_id: str):
    """A valid tar with no SKILL.md is rejected — we need the frontmatter."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        payload = b"not a skill manifest"
        info = tarfile.TarInfo(name="no-manifest/README.md")
        info.size = len(payload)
        tf.addfile(info, io.BytesIO(payload))

    files = {"file": ("nomanifest.tar.gz", buf.getvalue(), "application/gzip")}
    r = await client.post(
        f"/v1/projects/{project_id}/skills/upload", data={"skill_key": "no-manifest"}, files=files
    )
    assert r.status_code == 400, r.text
    assert "SKILL.md" in r.text


@pytest.mark.asyncio
async def test_skill_upload_rejects_non_utf8_skill_md(
    client: httpx.AsyncClient,
    project_id: str,
):
    archive = _archive_with_files("invalid-utf8", {"SKILL.md": b"\xff\xfe"})

    response = await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": "invalid-utf8"},
        files={"file": ("invalid-utf8.tar.gz", archive, "application/gzip")},
    )

    assert response.status_code == 400, response.text
    assert response.json()["detail"] == "Archive must contain a SKILL.md"


@pytest.mark.asyncio
async def test_explicit_skills_list_hides_archived_project(
    client: httpx.AsyncClient,
    workspace_project,
):
    project_id = str(workspace_project.id)
    tar_bytes, _ = tar_from_content(
        "archived-skill",
        "---\nname: Archived skill\ndescription: hidden after archive\n---\nInstructions.\n",
    )
    uploaded = await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": "archived-skill"},
        files={"file": ("archived-skill.tar.gz", tar_bytes, "application/gzip")},
    )
    assert uploaded.status_code == 200, uploaded.text

    visible = await client.get("/v1/skills", params={"project_id": project_id})
    assert visible.status_code == 200, visible.text
    assert [item["skill_key"] for item in visible.json()["items"]] == ["archived-skill"]

    archived = await client.delete(f"/v1/projects/{project_id}")
    assert archived.status_code == 200, archived.text

    hidden = await client.get("/v1/skills", params={"project_id": project_id})
    assert hidden.status_code == 200, hidden.text
    assert hidden.json()["total"] == 0
    assert hidden.json()["items"] == []


@pytest.mark.asyncio
async def test_list_skills_etag_binds_revision_and_project(
    client: httpx.AsyncClient, workspace_project, project_id: str
):
    """Round-32 P2 regression: the conditional GET ETag on
    `/api/skills` must bind both `skills_revision` AND `project_id`.
    Reusing an old project's ETag against a new project at the same
    revision MUST NOT short-circuit with 304 — the new project can
    have a totally different listing at the same revision counter
    (counter is account-wide, listing is project-filtered). Pre-fix
    the daemon would silently miss the new project's existing skills
    until some unrelated cloud change bumped the revision."""
    # Land a skill in project A so the list isn't empty.
    content = "---\nname: alpha\ndescription: in project A\n---\n# Hello\n"
    tar_bytes, _ = tar_from_content("alpha", content)
    files = {"file": ("alpha.tar.gz", tar_bytes, "application/gzip")}
    r = await client.post(
        f"/v1/projects/{project_id}/skills/upload", data={"skill_key": "alpha"}, files=files
    )
    assert r.status_code == 200, r.text

    # Capture project A's listing ETag.
    list_a = await client.get(f"/v1/skills?project_id={project_id}")
    assert list_a.status_code == 200, list_a.text
    assert list_a.headers.get("Cache-Control") == "no-transform"
    etag_a = list_a.headers.get("ETag")
    assert etag_a is not None
    assert etag_a.startswith('"') and etag_a.endswith('"')
    # Keep the numeric revision first for CLI 0.13.13 parsing, then salt the
    # corrected ordering/metadata identity so pre-fix validators cannot mask
    # the new representation.
    etag_parts = etag_a.strip('"').split(":")
    assert etag_parts[0].isdigit()
    assert etag_parts[1] == "skills-v2"
    assert project_id in etag_a, f"project_id missing from ETag {etag_a}"

    legacy_etag = (
        '"'
        + ":".join([etag_parts[0], etag_parts[2], etag_parts[3], etag_parts[4], etag_parts[6]])
        + '"'
    )
    legacy_replay = await client.get(
        f"/v1/skills?project_id={project_id}",
        headers={"If-None-Match": legacy_etag},
    )
    assert legacy_replay.status_code == 200, legacy_replay.text
    assert legacy_replay.headers["etag"] == etag_a

    # Replaying the same ETag against the same project returns 304.
    r304 = await client.get(
        f"/v1/skills?project_id={project_id}",
        headers={"If-None-Match": etag_a},
    )
    assert r304.status_code == 304, r304.text
    assert r304.headers.get("ETag") == etag_a
    assert r304.headers.get("Cache-Control") == "no-transform"

    # If-None-Match uses weak comparison for GET. A weak validator exposed by
    # an intermediary must still match the origin's strong collection ETag.
    weak_r304 = await client.get(
        f"/v1/skills?project_id={project_id}",
        headers={"If-None-Match": f"W/{etag_a}"},
    )
    assert weak_r304.status_code == 304, weak_r304.text
    assert weak_r304.headers.get("ETag") == etag_a
    assert weak_r304.headers.get("Cache-Control") == "no-transform"

    # The hidden compatibility alias mounts this same listing contract.
    alias_list = await client.get(f"/api/skills?project_id={project_id}")
    assert alias_list.status_code == 200, alias_list.text
    assert alias_list.headers.get("ETag") == etag_a
    assert alias_list.headers.get("Cache-Control") == "no-transform"
    alias_304 = await client.get(
        f"/api/skills?project_id={project_id}",
        headers={"If-None-Match": etag_a},
    )
    assert alias_304.status_code == 304, alias_304.text
    assert alias_304.headers.get("ETag") == etag_a
    assert alias_304.headers.get("Cache-Control") == "no-transform"

    # Now register a SECOND project and land a skill there. Crucially,
    # the second upload bumps the user-wide skills_revision (pre-fix
    # behaviour would let a SAME-revision project swap silently 304).
    # We test the stronger property anyway: the daemon's cached
    # ETag from project A must NOT cause a 304 against project B even
    # if B happened to be at the same revision.
    project_b = str(workspace_project.id)
    content_b = "---\nname: beta\ndescription: in project B\n---\n# Beta\n"
    tar_bytes_b, _ = tar_from_content("beta", content_b)
    files_b = {"file": ("beta.tar.gz", tar_bytes_b, "application/gzip")}
    r_b = await client.post(
        f"/v1/projects/{project_b}/skills/upload", data={"skill_key": "beta"}, files=files_b
    )
    assert r_b.status_code == 200, r_b.text

    # Replaying project A's ETag against project B MUST NOT 304 —
    # different representation. Also cover the same-revision
    # boundary explicitly: the upload above bumped revision, so
    # forge an If-None-Match with project A's tag rewritten to
    # the new revision (still wrong project) and confirm we get 200.
    list_b = await client.get(
        f"/v1/skills?project_id={project_b}",
        headers={"If-None-Match": etag_a},
    )
    assert list_b.status_code == 200, list_b.text
    assert any(item["skill_key"] == "beta" for item in list_b.json()["items"])

    # Defense-in-depth: rewrite the revision component to current
    # so caller has a same-revision-different-project ETag — the
    # exact race the round-32 finding describes. Must still 200.
    new_etag = list_b.headers["ETag"]
    new_revision = new_etag.strip('"').split(":")[0]
    forged = f'"{new_revision}:{project_id}"'
    r_forged = await client.get(
        f"/v1/skills?project_id={project_b}", headers={"If-None-Match": forged}
    )
    assert r_forged.status_code == 200, r_forged.text


@pytest.mark.asyncio
async def test_bound_api_key_skills_etag_reads_current_db_revision(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
    project_id: str,
):
    """A bound key must not 304 from its TTL-cached auth revision snapshot."""
    from sqlalchemy import update

    from app.core.auth import AuthContext, get_auth_short_session
    from app.main import app
    from app.models.api_key import ApiKey
    from app.models.user import User

    project_uuid = uuid.UUID(project_id)
    stale_auth = AuthContext(
        user=seed_user,
        api_key=ApiKey(user_id=seed_user.id, environment_id=uuid.uuid4()),
        api_key_project_id=project_uuid,
    )

    async def _override_get_auth() -> AuthContext:
        return stale_auth

    app.dependency_overrides[get_auth_short_session] = _override_get_auth

    canonical_url = f"/v1/skills?project_id={project_id}&page=1&page_size=200"
    first = await client.get(
        canonical_url,
        headers=AGENT_SKILL_SYNC_HEADERS,
    )
    assert first.status_code == 200, first.text
    assert first.headers.get("Cache-Control") == "no-transform"
    etag = first.headers.get("ETag")
    assert etag
    assert etag.startswith('"') and etag.endswith('"')
    first_revision, etag_version, *_ = etag.strip('"').split(":")
    assert int(first_revision) == stale_auth.skills_revision
    assert etag_version == "skills-v2"

    # Released CLI 0.13.13 expects one ETag across every page in a complete
    # inventory read. Preserve that fence while preventing a page-1 validator
    # from suppressing any non-canonical representation body.
    query_variants = [
        (f"{canonical_url}&q=missing", True, 304),
        (f"/v1/skills?project_id={project_id}&page=1&page_size=25", True, 304),
        (f"/v1/skills?project_id={project_id}&page=2&page_size=200", False, 200),
    ]
    for url, etag_must_differ, replay_status in query_variants:
        changed_shape = await client.get(
            url,
            headers={**AGENT_SKILL_SYNC_HEADERS, "If-None-Match": etag},
        )
        assert changed_shape.status_code == 200, (url, changed_shape.text)
        variant_etag = changed_shape.headers.get("ETag")
        assert variant_etag is not None
        assert (variant_etag != etag) is etag_must_differ

        replay = await client.get(
            url,
            headers={**AGENT_SKILL_SYNC_HEADERS, "If-None-Match": variant_etag},
        )
        assert replay.status_code == replay_status, (url, replay.text)

    inline = await client.get(
        f"{canonical_url}&include_content=true",
        headers={**AGENT_SKILL_SYNC_HEADERS, "If-None-Match": etag},
    )
    assert inline.status_code == 200, inline.text
    assert inline.headers.get("etag") is None
    inline_replay = await client.get(
        f"{canonical_url}&include_content=true",
        headers={**AGENT_SKILL_SYNC_HEADERS, "If-None-Match": etag},
    )
    assert inline_replay.status_code == 200, inline_replay.text
    assert inline_replay.headers.get("etag") is None

    # Simulate the API-key auth cache retaining its old user snapshot while a
    # Skill mutation commits a newer revision in PostgreSQL.
    await db_session.execute(
        update(User)
        .where(User.id == seed_user.id)
        .values(skills_revision=User.skills_revision + 1)
        .execution_options(synchronize_session=False)
    )
    await db_session.commit()
    assert stale_auth.skills_revision == int(first_revision)

    changed = await client.get(
        canonical_url,
        headers={**AGENT_SKILL_SYNC_HEADERS, "If-None-Match": etag},
    )
    assert changed.status_code == 200, changed.text
    changed_etag = changed.headers["etag"]
    assert changed_etag != etag
    assert int(changed_etag.strip('"').split(":", 1)[0]) == int(first_revision) + 1


@pytest.mark.asyncio
async def test_list_skills_order_and_etag_are_stable_across_pages(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
    project_id: str,
    workspace_project,
):
    """Duplicate cross-project keys sort by project id with one page fence."""
    from app.models.skill import Skill

    project_ids = [uuid.UUID(project_id), workspace_project.id]
    rows = [
        Skill(
            id=uuid.uuid4(),
            user_id=seed_user.id,
            project_id=current_project_id,
            skill_key="same-key",
            name=f"Skill {current_project_id}",
            content_hash=str(index) * 64,
        )
        for index, current_project_id in enumerate(project_ids, start=1)
    ]
    db_session.add_all(reversed(rows))
    await db_session.commit()

    first = await client.get("/v1/skills", params={"page": 1, "page_size": 1})
    second = await client.get("/v1/skills", params={"page": 2, "page_size": 1})
    assert first.status_code == second.status_code == 200
    assert first.headers["etag"] == second.headers["etag"]
    listed_project_ids = [
        first.json()["items"][0]["project_id"],
        second.json()["items"][0]["project_id"],
    ]
    assert listed_project_ids == sorted(str(project) for project in project_ids)

    # Compatibility debt: page 2 returns its body even when sent page 1's
    # validator, and echoes the same collection ETag.
    page_two_replay = await client.get(
        "/v1/skills",
        params={"page": 2, "page_size": 1},
        headers={"If-None-Match": first.headers["etag"]},
    )
    assert page_two_replay.status_code == 200, page_two_replay.text
    assert page_two_replay.headers["etag"] == first.headers["etag"]


@pytest.mark.asyncio
async def test_list_skills_etag_covers_project_and_machine_metadata(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
    environment_project,
):
    """Metadata-only mutations must invalidate the strong list validator."""
    from app.models.project import PROJECT_KIND_WORKSPACE
    from app.models.session import AgentEnvironment
    from app.models.skill import Skill

    skill = Skill(
        user_id=seed_user.id,
        project_id=environment_project.id,
        skill_key="metadata",
        name="Metadata",
        content_hash="a" * 64,
    )
    db_session.add(skill)
    await db_session.commit()

    url = f"/v1/skills?project_id={environment_project.id}"
    first = await client.get(url)
    assert first.status_code == 200, first.text
    first_etag = first.headers["etag"]
    revision = first_etag.strip('"').split(":", 1)[0]

    environment = await db_session.get(
        AgentEnvironment,
        environment_project.origin_environment_id,
    )
    assert environment is not None
    environment.machine_name = "Renamed machine"
    environment_project.name = "Renamed project"
    await db_session.commit()

    renamed = await client.get(url, headers={"If-None-Match": first_etag})
    assert renamed.status_code == 200, renamed.text
    renamed_item = renamed.json()["items"][0]
    assert renamed_item["project_name"] == "Renamed project"
    assert renamed_item["machine_name"] == "Renamed machine"
    assert renamed.headers["etag"] != first_etag
    assert renamed.headers["etag"].strip('"').split(":", 1)[0] == revision

    renamed_etag = renamed.headers["etag"]
    environment_project.kind = PROJECT_KIND_WORKSPACE
    environment_project.origin_environment_id = None
    await db_session.commit()
    detached = await client.get(url, headers={"If-None-Match": renamed_etag})
    assert detached.status_code == 200, detached.text
    detached_item = detached.json()["items"][0]
    assert detached_item["project_kind"] == PROJECT_KIND_WORKSPACE
    assert detached_item["environment_id"] is None
    assert detached_item["machine_name"] is None
    assert detached.headers["etag"] != renamed_etag
    assert detached.headers["etag"].strip('"').split(":", 1)[0] == revision


@pytest.mark.asyncio
async def test_list_skills_releases_db_transaction_before_inline_content_fetch(
    client: httpx.AsyncClient,
    db_session,
    project_id: str,
    monkeypatch: pytest.MonkeyPatch,
):
    """Inline content fetches must not hold a DB transaction open.

    `/api/skills?include_content=true` first reads metadata from Postgres and
    then reads tarballs from the file store. If the DB transaction stays open
    during that second phase, slow S3/R2 reads show up in production as
    `idle in transaction` connection-pool pressure.
    """
    from app.routes import skills as skills_route

    content = "---\nname: inline\ndescription: transaction release\n---\n# Inline\n"
    tar_bytes, _ = tar_from_content("inline", content)
    files = {"file": ("inline.tar.gz", tar_bytes, "application/gzip")}
    upload = await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": "inline"},
        files=files,
    )
    assert upload.status_code == 200, upload.text

    class AssertingFileStore:
        def __init__(self, delegate: FileStore) -> None:
            self._delegate = delegate

        async def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
            await self._delegate.put(key, data, content_type)

        async def get(self, key: str) -> bytes:
            assert key.endswith(f"/{upload.json()['content_hash']}.tar.gz")
            assert not db_session.in_transaction()
            return tar_bytes

        async def delete(self, key: str) -> None:
            await self._delegate.delete(key)

        async def exists(self, key: str) -> bool:
            return await self._delegate.exists(key)

    monkeypatch.setattr(
        skills_route,
        "file_store",
        AssertingFileStore(skills_route.file_store),
    )

    listing = await client.get(f"/v1/skills?project_id={project_id}&include_content=true")
    assert listing.status_code == 200, listing.text
    item = next(item for item in listing.json()["items"] if item["skill_key"] == "inline")
    assert item["content"] == content
    assert listing.headers.get("etag") is None


@pytest.mark.asyncio
async def test_list_skills_inline_content_failure_is_unfenced_and_retried(
    client: httpx.AsyncClient,
    project_id: str,
    monkeypatch: pytest.MonkeyPatch,
):
    """A transient object-store failure must not become a reusable 304."""
    from app.routes import skills as skills_route

    content = "---\nname: retry-inline\ndescription: retry storage\n---\n# Retry\n"
    tar_bytes, _ = tar_from_content("retry-inline", content)
    upload = await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": "retry-inline"},
        files={"file": ("retry-inline.tar.gz", tar_bytes, "application/gzip")},
    )
    assert upload.status_code == 200, upload.text

    metadata = await client.get(f"/v1/skills?project_id={project_id}")
    assert metadata.status_code == 200, metadata.text
    metadata_etag = metadata.headers["etag"]
    real_file_store = skills_route.file_store

    class FailingFileStore:
        def __init__(self, delegate: FileStore) -> None:
            self._delegate = delegate
            self._failed = False

        async def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
            await self._delegate.put(key, data, content_type)

        async def get(self, key: str) -> bytes:
            if not self._failed:
                self._failed = True
                raise RuntimeError(f"temporary read failure for {key}")
            return await self._delegate.get(key)

        async def delete(self, key: str) -> None:
            await self._delegate.delete(key)

        async def exists(self, key: str) -> bool:
            return await self._delegate.exists(key)

    monkeypatch.setattr(skills_route, "file_store", FailingFileStore(real_file_store))
    failed = await client.get(
        f"/v1/skills?project_id={project_id}&include_content=true",
        headers={"If-None-Match": metadata_etag},
    )
    assert failed.status_code == 200, failed.text
    assert failed.headers.get("etag") is None
    assert failed.headers["cache-control"] == "no-transform"
    failed_item = next(
        item for item in failed.json()["items"] if item["skill_key"] == "retry-inline"
    )
    assert failed_item["content"] is None

    recovered = await client.get(
        f"/v1/skills?project_id={project_id}&include_content=true",
        headers={"If-None-Match": metadata_etag},
    )
    assert recovered.status_code == 200, recovered.text
    assert recovered.headers.get("etag") is None
    recovered_item = next(
        item for item in recovered.json()["items"] if item["skill_key"] == "retry-inline"
    )
    assert recovered_item["content"] == content


@pytest.mark.asyncio
async def test_project_explicit_upload_targets_named_project(
    client: httpx.AsyncClient, db_session, seed_user
):
    """Phase-2 route: POST /api/projects/{project_id}/skills/upload
    lands the upload in the URL-named project, not the caller-
    resolved default. Verifies the route shim works AND that
    cross-project writes don't bleed between Cloud-owned workspaces."""
    from app.models.project import PROJECT_KIND_WORKSPACE, Project

    project_a = Project(
        user_id=seed_user.id,
        name="Workspace A",
        slug=f"workspace-a-{uuid.uuid4().hex[:8]}",
        kind=PROJECT_KIND_WORKSPACE,
    )
    project_b = Project(
        user_id=seed_user.id,
        name="Workspace B",
        slug=f"workspace-b-{uuid.uuid4().hex[:8]}",
        kind=PROJECT_KIND_WORKSPACE,
    )
    db_session.add_all([project_a, project_b])
    await db_session.commit()

    content = "---\nname: projected\ndescription: x\n---\n# Projected\n"
    tar_bytes, _ = tar_from_content("projected", content)
    files = {"file": ("projected.tar.gz", tar_bytes, "application/gzip")}

    # Upload to workspace A explicitly via the project-scoped route.
    r = await client.post(
        f"/api/projects/{project_a.id}/skills/upload",
        data={"skill_key": "projected"},
        files=files,
    )
    assert r.status_code == 200, r.text

    detail_a = await client.get(f"/v1/projects/{project_a.id}/skills/projected")
    assert detail_a.status_code == 200, detail_a.text
    assert detail_a.json()["skill_key"] == "projected"

    # Workspace B must not see workspace A's row. This is the
    # isolation invariant — same skill_key in different projects
    # don't see each other.
    detail_b = await client.get(f"/v1/projects/{project_b.id}/skills/projected")
    assert detail_b.status_code == 404, detail_b.text


@pytest.mark.asyncio
async def test_project_explicit_upload_rejects_other_users_project(
    client: httpx.AsyncClient, db_session, seed_user
):
    """Targeting a project you don't own returns 404 — never leak
    another tenant's project existence via 403."""
    from app.models.project import PROJECT_KIND_PERSONAL, Project
    from app.models.user import User as UserModel

    other = UserModel(clerk_id="other_project_test", email="other2@clawdi.local", name="Other")
    db_session.add(other)
    await db_session.flush()
    other_project = Project(
        user_id=other.id, name="Personal", slug="personal", kind=PROJECT_KIND_PERSONAL
    )
    db_session.add(other_project)
    await db_session.commit()

    try:
        content = "---\nname: x\n---\n"
        tar_bytes, _ = tar_from_content("x", content)
        files = {"file": ("x.tar.gz", tar_bytes, "application/gzip")}
        r = await client.post(
            f"/v1/projects/{other_project.id}/skills/upload",
            data={"skill_key": "x"},
            files=files,
        )
        assert r.status_code == 404, r.text
    finally:
        await db_session.delete(other)
        await db_session.commit()


@pytest.mark.asyncio
async def test_skill_reupload_after_delete_reactivates_row(
    client: httpx.AsyncClient, project_id: str
):
    """Round-r5 P1: a soft-deleted skill row (`is_active=False`)
    must reactivate when the daemon re-uploads byte-identical
    bytes. The hash-equality short-circuit at routes/skills.py
    has a load-bearing `is_active` clause — without it, the
    function returns 200 without flipping the row back on, and
    the skill stays invisible to /api/skills forever.

    Repro: upload → DELETE → upload same bytes → assert listing
    contains it again.
    """
    content = "---\nname: revive\ndescription: roundtrip resurrection\n---\n# revive\n"
    tar_bytes, _ = tar_from_content("revive", content)
    files = {"file": ("revive.tgz", tar_bytes, "application/gzip")}

    # 1) initial upload — row created active.
    r = await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": "revive"},
        files=files,
    )
    assert r.status_code == 200, r.text

    # 2) soft-delete via the project-explicit route.
    r_del = await client.delete(f"/v1/projects/{project_id}/skills/revive")
    assert r_del.status_code == 200, r_del.text

    # Listing must now hide it.
    listing = (await client.get("/v1/skills")).json()["items"]
    assert not any(s["skill_key"] == "revive" for s in listing), (
        "soft-deleted skill must not appear in /api/skills"
    )

    # 3) re-upload the exact same bytes. The route's
    # short-circuit guard branch `existing.content_hash ==
    # content_hash` MUST also require `existing.is_active` —
    # otherwise the response 200s without reactivating.
    r_re = await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": "revive"},
        files=files,
    )
    assert r_re.status_code == 200, r_re.text

    listing2 = (await client.get("/v1/skills")).json()["items"]
    revived = [s for s in listing2 if s["skill_key"] == "revive"]
    assert len(revived) == 1, (
        f"re-uploading identical bytes after delete must reactivate the row, got listing={listing2}"
    )


@pytest.mark.asyncio
async def test_legacy_upload_resolves_default_project_with_deprecation_header(
    client: httpx.AsyncClient, project_id: str
):
    """Round-r6 back-compat: pre-PR-66 CLI binaries call the
    legacy `POST /api/skills/upload` route. Round-3 originally
    410'd it for safety, but every user has a deterministic
    default project after the migration (`resolve_default_write_project`
    never returns None). A wrong-project upload creates a stray row
    that's recoverable in 30s, while slug-only DELETE remains restricted
    to env-bound keys that identify exactly one Agent Project. Upload
    therefore soft-deprecates and continues to function so old CLIs keep
    pushing skills.

    Pinned by: legacy upload returns 200 with the skill landed
    in the resolved default project (same as `project_id` here for
    the single-env test fixture), and the response carries the
    Deprecation / Sunset headers so newer clients can warn.
    """
    content = "---\nname: legacy-up\ndescription: bc shim test\n---\n# x\n"
    tar_bytes, _ = tar_from_content("legacy-up", content)
    files = {"file": ("legacy-up.tgz", tar_bytes, "application/gzip")}

    r = await client.post(
        "/v1/skills/upload",
        data={"skill_key": "legacy-up"},
        files=files,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["skill_key"] == "legacy-up"
    assert body["version"] == 1

    # Soft-deprecation surface: clients can detect via
    # Deprecation: true and read the successor-version Link.
    assert r.headers.get("Deprecation") == "true"
    assert "Sunset" in r.headers
    assert "successor-version" in r.headers.get("Link", "")

    # Confirm the row landed in the test fixture's project (the
    # only env-project present, so resolve_default_write_project
    # picks it deterministically).
    detail = await client.get("/v1/skills/legacy-up")
    assert detail.status_code == 200
    assert detail.json()["project_id"] == project_id


@pytest.mark.asyncio
async def test_legacy_delete_still_410s_for_browser(client: httpx.AsyncClient, project_id: str):
    """Slug-only DELETE remains ambiguous for browser sessions.

    Only an env-bound API key can identify one Agent Project without guessing;
    dashboard and other user-level callers must use the project-explicit route.
    """
    # Upload via the new route to make sure there's a row to
    # potentially-delete; the 410 must fire BEFORE we look up
    # any row.
    content = "---\nname: legacy-del\ndescription: bc shim test\n---\n# x\n"
    tar_bytes, _ = tar_from_content("legacy-del", content)
    await client.post(
        f"/v1/projects/{project_id}/skills/upload",
        data={"skill_key": "legacy-del"},
        files={"file": ("legacy-del.tgz", tar_bytes, "application/gzip")},
    )

    r = await client.delete("/v1/skills/legacy-del")
    assert r.status_code == 410, r.text
    assert r.json()["detail"]["code"] == "project_explicit_route_required"

    # Row is still there — 410 must not have triggered any
    # write side-effect.
    listing = (await client.get("/v1/skills")).json()["items"]
    assert any(s["skill_key"] == "legacy-del" for s in listing)
