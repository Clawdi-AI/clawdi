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
async def test_skill_upload_happy_path(client: httpx.AsyncClient, scope_id: str):
    content = "---\nname: hello\ndescription: greet the user\n---\n# Hello\n"
    tar_bytes, _ = tar_from_content("hello", content)

    files = {"file": ("hello.tar.gz", tar_bytes, "application/gzip")}
    r = await client.post(
        f"/api/scopes/{scope_id}/skills/upload", data={"skill_key": "hello"}, files=files
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
        f"/api/scopes/{scope_id}/skills/upload", data={"skill_key": "hello"}, files=files
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["version"] == 1, "identical re-upload must not bump version"

    # Detail endpoint returns the SKILL.md content extracted on the server.
    detail = (await client.get("/api/skills/hello")).json()
    assert "# Hello" in (detail["content"] or "")


@pytest.mark.asyncio
async def test_dashboard_edit_with_stale_content_hash_returns_412(
    client: httpx.AsyncClient, scope_id: str
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
        f"/api/scopes/{scope_id}/skills/upload",
        data={"skill_key": "editme"},
        files={"file": ("editme.tar.gz", tar_bytes, "application/gzip")},
    )
    assert seed.status_code == 200, seed.text
    current_hash = seed.json()["content_hash"]
    assert current_hash, "seed upload must echo a content_hash for the test"

    # Stale `content_hash` (anything not the current row hash) -> 412.
    stale = "0" * 64
    r = await client.put(
        f"/api/scopes/{scope_id}/skills/editme/content",
        json={
            "content": "---\nname: editme\ndescription: edited\n---\n# Edited\n",
            "content_hash": stale,
        },
    )
    assert r.status_code == 412, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "stale_content"
    assert detail["current_content_hash"] == current_hash

    # And the row was NOT updated.
    detail_get = await client.get(f"/api/scopes/{scope_id}/skills/editme")
    assert "# Original" in detail_get.json().get("content", "")

    # Sending the CURRENT hash succeeds. Schema requires 64-char
    # lowercase hex; the seeded hash satisfies that.
    ok = await client.put(
        f"/api/scopes/{scope_id}/skills/editme/content",
        json={
            "content": "---\nname: editme\ndescription: edited\n---\n# Edited\n",
            "content_hash": current_hash,
        },
    )
    assert ok.status_code == 200, ok.text
    after = await client.get(f"/api/scopes/{scope_id}/skills/editme")
    assert "# Edited" in after.json().get("content", "")


@pytest.mark.asyncio
async def test_dashboard_edit_without_content_hash_is_last_write_wins(
    client: httpx.AsyncClient, scope_id: str
):
    """The `content_hash` field is optional. Phase-1 dashboard editor
    leaves it blank for last-write-wins. Verify the omitted-hash path
    still applies the edit even when the row exists."""
    seed_content = "---\nname: lww\ndescription: original\n---\n# Original\n"
    tar_bytes, _ = tar_from_content("lww", seed_content)
    await client.post(
        f"/api/scopes/{scope_id}/skills/upload",
        data={"skill_key": "lww"},
        files={"file": ("lww.tar.gz", tar_bytes, "application/gzip")},
    )

    r = await client.put(
        f"/api/scopes/{scope_id}/skills/lww/content",
        json={
            "content": "---\nname: lww\ndescription: edited\n---\n# Edited\n",
        },
    )
    assert r.status_code == 200, r.text
    after = await client.get(f"/api/scopes/{scope_id}/skills/lww")
    assert "# Edited" in after.json().get("content", "")


@pytest.mark.asyncio
async def test_skill_upload_unchanged_does_not_bump_version(
    client: httpx.AsyncClient, scope_id: str
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
        f"/api/scopes/{scope_id}/skills/upload", data={"skill_key": "stable"}, files=files
    )
    assert first.json()["version"] == 1
    first_updated_at = (await client.get("/api/skills/stable")).json().get("updated_at")
    # Detail endpoint may or may not surface updated_at; if not, fall back
    # to listing.
    if first_updated_at is None:
        listing = (await client.get("/api/skills")).json()
        first_updated_at = next(s for s in listing["items"] if s["skill_key"] == "stable")[
            "updated_at"
        ]

    await asyncio.sleep(0.05)

    second = await client.post(
        f"/api/scopes/{scope_id}/skills/upload", data={"skill_key": "stable"}, files=files
    )
    assert second.status_code == 200
    assert second.json()["version"] == 1, "version must not bump on identical re-upload"

    listing = (await client.get("/api/skills")).json()
    after_updated_at = next(s for s in listing["items"] if s["skill_key"] == "stable")["updated_at"]
    assert after_updated_at == first_updated_at, (
        "updated_at must not advance on identical re-upload"
    )


@pytest.mark.asyncio
async def test_skill_upload_changed_content_bumps_version(client: httpx.AsyncClient, scope_id: str):
    """When the SKILL.md content actually changes, version goes up and
    `updated_at` advances."""
    v1_content = "---\nname: mut\ndescription: v1\n---\n# v1\n"
    v1_tar, _ = tar_from_content("mut", v1_content)
    files_v1 = {"file": ("mut.tar.gz", v1_tar, "application/gzip")}

    first = await client.post(
        f"/api/scopes/{scope_id}/skills/upload", data={"skill_key": "mut"}, files=files_v1
    )
    assert first.json()["version"] == 1

    v2_content = "---\nname: mut\ndescription: v2\n---\n# v2\n"
    v2_tar, _ = tar_from_content("mut", v2_content)
    files_v2 = {"file": ("mut.tar.gz", v2_tar, "application/gzip")}

    second = await client.post(
        f"/api/scopes/{scope_id}/skills/upload", data={"skill_key": "mut"}, files=files_v2
    )
    assert second.status_code == 200
    assert second.json()["version"] == 2, "real content change must bump version"


@pytest.mark.asyncio
async def test_skill_upload_accepts_client_supplied_hash(client: httpx.AsyncClient, scope_id: str):
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

    first = await client.post(f"/api/scopes/{scope_id}/skills/upload", data=data, files=files)
    assert first.status_code == 200, first.text
    assert first.json()["version"] == 1

    second = await client.post(f"/api/scopes/{scope_id}/skills/upload", data=data, files=files)
    assert second.status_code == 200, second.text
    assert second.json()["version"] == 1, (
        "second push with same client-supplied hash must skip the bump"
    )


@pytest.mark.asyncio
async def test_skill_upload_rejects_path_traversal(client: httpx.AsyncClient, scope_id: str):
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
        f"/api/scopes/{scope_id}/skills/upload", data={"skill_key": "evil"}, files=files
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
async def test_skill_upload_rejects_archive_rooted_at_wrong_path(
    client: httpx.AsyncClient, scope_id: str
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
        f"/api/scopes/{scope_id}/skills/upload",
        data={"skill_key": "category/foo"},
        files=files,
    )
    assert r.status_code == 400, r.text
    assert "archive root" in r.text.lower()


@pytest.mark.asyncio
async def test_skill_upload_rejects_reserved_routing_suffix(
    client: httpx.AsyncClient, scope_id: str
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
            f"/api/scopes/{scope_id}/skills/upload",
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
        f"/api/scopes/{scope_id}/skills/upload",
        data={"skill_key": "download"},
        files=files,
    )
    assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_skill_upload_rejects_overlength_nested_key(client: httpx.AsyncClient, scope_id: str):
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
        f"/api/scopes/{scope_id}/skills/upload",
        data={"skill_key": long_key},
        files=files,
    )
    assert r.status_code == 422, r.text


@pytest.mark.asyncio
async def test_skill_upload_accepts_hermes_nested_key(client: httpx.AsyncClient, scope_id: str):
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
        f"/api/scopes/{scope_id}/skills/upload",
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
            f"/api/scopes/{scope_id}/skills/upload",
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
    every reconcile re-pulled the same bytes and SSE echo
    suppression failed.

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
async def test_nested_skill_round_trips_through_scoped_routes(
    client: httpx.AsyncClient, scope_id: str
):
    """Round-36 P2 regression: scoped GET / download / DELETE routes
    must capture slash-bearing skill_keys (Hermes layout). Pre-fix
    the `{skill_key}` path param refused to match a URL containing
    `/`, so a Hermes nested skill could be uploaded but not opened
    / downloaded / deleted via the scoped routes — bricked by the
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

    # Upload via the scoped form-data route.
    r_upload = await client.post(
        f"/api/scopes/{scope_id}/skills/upload",
        data={"skill_key": nested_key},
        files=files,
    )
    assert r_upload.status_code == 200, r_upload.text

    # GET detail with nested key (literal `/` in URL path).
    r_get = await client.get(f"/api/scopes/{scope_id}/skills/{nested_key}")
    assert r_get.status_code == 200, r_get.text
    assert r_get.json()["skill_key"] == nested_key

    # GET download — most-specific subroute. The reorder is the
    # whole point of this test: the bare GET must NOT have eaten
    # the URL `/api/scopes/{sid}/skills/category/foo/download` as
    # `skill_key="category/foo/download"`.
    r_download = await client.get(f"/api/scopes/{scope_id}/skills/{nested_key}/download")
    assert r_download.status_code == 200, r_download.text
    assert r_download.headers["content-type"].startswith("application/gzip")

    # PUT content — also a more-specific subroute; ordering matters
    # the same way it does for download.
    new_md = "---\nname: nested\ndescription: edited via scoped PUT\n---\n# Nested v2\n"
    r_put = await client.put(
        f"/api/scopes/{scope_id}/skills/{nested_key}/content",
        json={"content": new_md},
    )
    assert r_put.status_code == 200, r_put.text

    # DELETE last — verifies the deletion route also accepts nested
    # keys so an uninstall via the scoped DELETE actually removes
    # the row.
    r_delete = await client.delete(f"/api/scopes/{scope_id}/skills/{nested_key}")
    assert r_delete.status_code == 200, r_delete.text
    r_get_after = await client.get(f"/api/scopes/{scope_id}/skills/{nested_key}")
    assert r_get_after.status_code == 404, r_get_after.text


@pytest.mark.asyncio
async def test_skill_upload_requires_skill_md(client: httpx.AsyncClient, scope_id: str):
    """A valid tar with no SKILL.md is rejected — we need the frontmatter."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        payload = b"not a skill manifest"
        info = tarfile.TarInfo(name="no-manifest/README.md")
        info.size = len(payload)
        tf.addfile(info, io.BytesIO(payload))

    files = {"file": ("nomanifest.tar.gz", buf.getvalue(), "application/gzip")}
    r = await client.post(
        f"/api/scopes/{scope_id}/skills/upload", data={"skill_key": "no-manifest"}, files=files
    )
    assert r.status_code == 400, r.text
    assert "SKILL.md" in r.text


@pytest.mark.asyncio
async def test_list_skills_etag_binds_revision_and_scope(
    client: httpx.AsyncClient, db_session, seed_user, scope_id: str
):
    """Round-32 P2 regression: the conditional GET ETag on
    `/api/skills` must bind both `skills_revision` AND `scope_id`.
    Reusing an old scope's ETag against a new scope at the same
    revision MUST NOT short-circuit with 304 — the new scope can
    have a totally different listing at the same revision counter
    (counter is account-wide, listing is scope-scoped). Pre-fix
    the daemon would silently miss the new scope's existing skills
    until some unrelated cloud change bumped the revision."""
    from tests.conftest import create_env_with_scope

    # Land a skill in scope A so the list isn't empty.
    content = "---\nname: alpha\ndescription: in scope A\n---\n# Hello\n"
    tar_bytes, _ = tar_from_content("alpha", content)
    files = {"file": ("alpha.tar.gz", tar_bytes, "application/gzip")}
    r = await client.post(
        f"/api/scopes/{scope_id}/skills/upload", data={"skill_key": "alpha"}, files=files
    )
    assert r.status_code == 200, r.text

    # Capture scope A's listing ETag.
    list_a = await client.get(f"/api/skills?scope_id={scope_id}")
    assert list_a.status_code == 200, list_a.text
    etag_a = list_a.headers.get("ETag")
    assert etag_a is not None
    # ETag carries `<revision>:<scope_id>`. Sanity-check both
    # components are present so a regression to plain
    # `<revision>` would fail the test.
    assert ":" in etag_a.strip('"'), f"expected revision:scope tag, got {etag_a}"
    assert scope_id in etag_a, f"scope_id missing from ETag {etag_a}"

    # Replaying the same ETag against the same scope returns 304.
    r304 = await client.get(f"/api/skills?scope_id={scope_id}", headers={"If-None-Match": etag_a})
    assert r304.status_code == 304, r304.text

    # Now register a SECOND scope and land a skill there. Crucially,
    # the second upload bumps the user-wide skills_revision (pre-fix
    # behaviour would let a SAME-revision scope swap silently 304).
    # We test the stronger property anyway: the daemon's cached
    # ETag from scope A must NOT cause a 304 against scope B even
    # if B happened to be at the same revision.
    env_b = await create_env_with_scope(
        db_session,
        user_id=seed_user.id,
        machine_id="machine-b",
        machine_name="Mac B",
        agent_type="codex",
    )
    scope_b = str(env_b.default_scope_id)
    content_b = "---\nname: beta\ndescription: in scope B\n---\n# Beta\n"
    tar_bytes_b, _ = tar_from_content("beta", content_b)
    files_b = {"file": ("beta.tar.gz", tar_bytes_b, "application/gzip")}
    r_b = await client.post(
        f"/api/scopes/{scope_b}/skills/upload", data={"skill_key": "beta"}, files=files_b
    )
    assert r_b.status_code == 200, r_b.text

    # Replaying scope A's ETag against scope B MUST NOT 304 —
    # different representation. Also cover the same-revision
    # boundary explicitly: the upload above bumped revision, so
    # forge an If-None-Match with scope A's tag rewritten to
    # the new revision (still wrong scope) and confirm we get 200.
    list_b = await client.get(f"/api/skills?scope_id={scope_b}", headers={"If-None-Match": etag_a})
    assert list_b.status_code == 200, list_b.text
    assert any(item["skill_key"] == "beta" for item in list_b.json()["items"])

    # Defense-in-depth: rewrite the revision component to current
    # so caller has a same-revision-different-scope ETag — the
    # exact race the round-32 finding describes. Must still 200.
    new_etag = list_b.headers["ETag"]
    new_revision = new_etag.strip('"').split(":")[0]
    forged = f'"{new_revision}:{scope_id}"'
    r_forged = await client.get(
        f"/api/skills?scope_id={scope_b}", headers={"If-None-Match": forged}
    )
    assert r_forged.status_code == 200, r_forged.text


@pytest.mark.asyncio
async def test_scope_explicit_upload_targets_named_scope(
    client: httpx.AsyncClient, db_session, seed_user
):
    """Phase-2 route: POST /api/scopes/{scope_id}/skills/upload
    lands the upload in the URL-named scope, not the caller-
    resolved default. Verifies the route shim works AND that
    cross-scope writes don't bleed (a skill uploaded to env A's
    scope must not appear in env B's scope's list)."""
    from tests.conftest import create_env_with_scope

    env_a = await create_env_with_scope(
        db_session, user_id=seed_user.id, machine_id="a", machine_name="MachineA"
    )
    env_b = await create_env_with_scope(
        db_session, user_id=seed_user.id, machine_id="b", machine_name="MachineB"
    )

    content = "---\nname: scoped\ndescription: x\n---\n# Scoped\n"
    tar_bytes, _ = tar_from_content("scoped", content)
    files = {"file": ("scoped.tar.gz", tar_bytes, "application/gzip")}

    # Upload to env_a's scope explicitly via phase-2 route.
    r = await client.post(
        f"/api/scopes/{env_a.default_scope_id}/skills/upload",
        data={"skill_key": "scoped"},
        files=files,
    )
    assert r.status_code == 200, r.text

    # Phase-2 read on env_a's scope: skill is there.
    detail_a = await client.get(f"/api/scopes/{env_a.default_scope_id}/skills/scoped")
    assert detail_a.status_code == 200, detail_a.text
    assert detail_a.json()["skill_key"] == "scoped"

    # Phase-2 read on env_b's scope: NOT there. This is the
    # isolation invariant — same skill_key in different scopes
    # don't see each other.
    detail_b = await client.get(f"/api/scopes/{env_b.default_scope_id}/skills/scoped")
    assert detail_b.status_code == 404, detail_b.text


@pytest.mark.asyncio
async def test_scope_explicit_upload_rejects_other_users_scope(
    client: httpx.AsyncClient, db_session, seed_user
):
    """Targeting a scope you don't own returns 404 — never leak
    another tenant's scope existence via 403."""
    from app.models.scope import SCOPE_KIND_PERSONAL, Scope
    from app.models.user import User as UserModel

    other = UserModel(clerk_id="other_scope_test", email="other2@clawdi.local", name="Other")
    db_session.add(other)
    await db_session.flush()
    other_scope = Scope(
        user_id=other.id, name="Personal", slug="personal", kind=SCOPE_KIND_PERSONAL
    )
    db_session.add(other_scope)
    await db_session.commit()

    try:
        content = "---\nname: x\n---\n"
        tar_bytes, _ = tar_from_content("x", content)
        files = {"file": ("x.tar.gz", tar_bytes, "application/gzip")}
        r = await client.post(
            f"/api/scopes/{other_scope.id}/skills/upload",
            data={"skill_key": "x"},
            files=files,
        )
        assert r.status_code == 404, r.text
    finally:
        await db_session.delete(other)
        await db_session.commit()


@pytest.mark.asyncio
async def test_skill_reupload_after_delete_reactivates_row(
    client: httpx.AsyncClient, scope_id: str
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
        f"/api/scopes/{scope_id}/skills/upload",
        data={"skill_key": "revive"},
        files=files,
    )
    assert r.status_code == 200, r.text

    # 2) soft-delete via the scope-explicit route.
    r_del = await client.delete(f"/api/scopes/{scope_id}/skills/revive")
    assert r_del.status_code == 200, r_del.text

    # Listing must now hide it.
    listing = (await client.get("/api/skills")).json()["items"]
    assert not any(s["skill_key"] == "revive" for s in listing), (
        "soft-deleted skill must not appear in /api/skills"
    )

    # 3) re-upload the exact same bytes. The route's
    # short-circuit guard branch `existing.content_hash ==
    # content_hash` MUST also require `existing.is_active` —
    # otherwise the response 200s without reactivating.
    r_re = await client.post(
        f"/api/scopes/{scope_id}/skills/upload",
        data={"skill_key": "revive"},
        files=files,
    )
    assert r_re.status_code == 200, r_re.text

    listing2 = (await client.get("/api/skills")).json()["items"]
    revived = [s for s in listing2 if s["skill_key"] == "revive"]
    assert len(revived) == 1, (
        f"re-uploading identical bytes after delete must reactivate the row, got listing={listing2}"
    )


@pytest.mark.asyncio
async def test_legacy_upload_resolves_default_scope_with_deprecation_header(
    client: httpx.AsyncClient, scope_id: str
):
    """Round-r6 back-compat: pre-PR-66 CLI binaries call the
    legacy `POST /api/skills/upload` route. Round-3 originally
    410'd it for safety, but every user has a deterministic
    default scope after the migration (`resolve_default_write_scope`
    never returns None). Asymmetric with DELETE: a wrong-scope
    upload creates a stray row that's recoverable in 30s; a
    wrong-scope DELETE is permanent loss. So upload soft-
    deprecates and continues to function — old CLIs keep
    pushing skills.

    Pinned by: legacy upload returns 200 with the skill landed
    in the resolved default scope (same as `scope_id` here for
    the single-env test fixture), and the response carries the
    Deprecation / Sunset headers so newer clients can warn.
    """
    content = "---\nname: legacy-up\ndescription: bc shim test\n---\n# x\n"
    tar_bytes, _ = tar_from_content("legacy-up", content)
    files = {"file": ("legacy-up.tgz", tar_bytes, "application/gzip")}

    r = await client.post(
        "/api/skills/upload",
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

    # Confirm the row landed in the test fixture's scope (the
    # only env-scope present, so resolve_default_write_scope
    # picks it deterministically).
    detail = await client.get("/api/skills/legacy-up")
    assert detail.status_code == 200
    assert detail.json()["scope_id"] == scope_id


@pytest.mark.asyncio
async def test_legacy_delete_still_410s(client: httpx.AsyncClient, scope_id: str):
    """Round-r6: round-3's 410-on-DELETE design preserved.
    DELETE remains hard-410 (not soft-deprecated like upload)
    because a wrong-scope delete is permanent data loss — the
    asymmetry that justifies the back-compat split. Clients
    must use the scope-explicit `DELETE /api/scopes/{sid}/
    skills/{key}` so they pick which row to delete on multi-
    scope accounts.
    """
    # Upload via the new route to make sure there's a row to
    # potentially-delete; the 410 must fire BEFORE we look up
    # any row.
    content = "---\nname: legacy-del\ndescription: bc shim test\n---\n# x\n"
    tar_bytes, _ = tar_from_content("legacy-del", content)
    await client.post(
        f"/api/scopes/{scope_id}/skills/upload",
        data={"skill_key": "legacy-del"},
        files={"file": ("legacy-del.tgz", tar_bytes, "application/gzip")},
    )

    r = await client.delete("/api/skills/legacy-del")
    assert r.status_code == 410, r.text
    assert r.json()["detail"]["code"] == "scope_explicit_route_required"

    # Row is still there — 410 must not have triggered any
    # write side-effect.
    listing = (await client.get("/api/skills")).json()["items"]
    assert any(s["skill_key"] == "legacy-del" for s in listing)
