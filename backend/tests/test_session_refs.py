"""Session related-refs extraction tests.

Coverage:
- `extract_related_refs` unit behavior
- `/upload` route populates `related_refs` server-side
- List + detail responses surface the field
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime

import httpx
import pytest

from app.services.session_refs import extract_related_refs


def test_related_refs_extracts_prs_repos_branches():
    refs = extract_related_refs(
        [
            {
                "role": "user",
                "content": (
                    "see https://github.com/ghostty-org/ghostty/pull/4123 "
                    "and gh repo clone owner/repo"
                ),
            },
            {
                "role": "assistant",
                "content": "running `git checkout fix/auth-migration`",
            },
        ]
    )
    assert refs["prs"] == ["ghostty-org/ghostty#4123"]
    # PR URL also matches the bare-repo extractor — both ghostty-org/ghostty
    # and owner/repo land in repos.
    assert "ghostty-org/ghostty" in refs["repos"]
    assert "owner/repo" in refs["repos"]
    assert refs["branches"] == ["fix/auth-migration"]


def test_related_refs_skips_shas_and_special_branch_aliases():
    """A SHA-shaped argument to `git checkout` is checking out a commit,
    not a meaningful branch name — we shouldn't surface it in the sidebar.
    Same for the HEAD aliases."""
    refs = extract_related_refs(
        [
            {"role": "user", "content": "git checkout abc1234 then git checkout HEAD~2"},
        ]
    )
    assert "branches" not in refs


def test_related_refs_returns_empty_dict_when_nothing_found():
    """No surrounding `{"prs": [], ...}` keys for an empty result — the
    caller stores NULL in that case to distinguish "ran extractor, found
    nothing" from "never ran extractor", and `None` is what gets persisted.
    """
    refs = extract_related_refs([{"role": "user", "content": "just a chat"}])
    assert refs == {}


# --- Wire-format / integration tests below ---------------------------------


async def _register_env(client: httpx.AsyncClient) -> str:
    r = await client.post(
        "/v1/environments",
        json={
            "machine_id": "refs-machine",
            "machine_name": "Refs Mac",
            "agent_type": "claude-code",
            "agent_version": "0.1.0",
            "os": "darwin",
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


async def _push_and_upload(
    client: httpx.AsyncClient,
    *,
    local_session_id: str,
    messages: list[dict],
) -> str:
    env_id = await _register_env(client)
    body_bytes = json.dumps(messages).encode("utf-8")
    payload_session = {
        "environment_id": env_id,
        "local_session_id": local_session_id,
        "started_at": datetime.now(UTC).isoformat(),
        "message_count": len(messages),
        "content_hash": hashlib.sha256(body_bytes).hexdigest(),
    }

    r = await client.post("/v1/sessions/batch", json={"sessions": [payload_session]})
    assert r.status_code == 200, r.text

    await client.post(
        f"/v1/sessions/{local_session_id}/upload",
        files={"file": (f"{local_session_id}.json", body_bytes, "application/json")},
    )

    listing = (await client.get(f"/v1/sessions?q={local_session_id}")).json()
    return next(s["id"] for s in listing["items"] if s["local_session_id"] == local_session_id)


@pytest.mark.asyncio
async def test_upload_populates_related_refs(client: httpx.AsyncClient):
    """End-to-end: pushing real messages with PR + branch refs makes
    the detail endpoint return populated `related_refs`."""
    messages = [
        {"role": "user", "content": "review https://github.com/foo/bar/pull/7"},
        {"role": "assistant", "content": "looks good, `git checkout review/pr-7`"},
        {"role": "user", "content": "what else?"},
        {"role": "assistant", "content": "all done"},
    ]
    sid = await _push_and_upload(client, local_session_id="sess-refs-real", messages=messages)

    detail = (await client.get(f"/v1/sessions/{sid}")).json()
    assert detail["related_refs"]["prs"] == ["foo/bar#7"]
    assert detail["related_refs"]["branches"] == ["review/pr-7"]


@pytest.mark.asyncio
async def test_upload_with_no_refs_leaves_related_refs_null(client: httpx.AsyncClient):
    """A vanilla conversation with no URLs / git commands should produce
    NULL `related_refs`. Distinguishes "ran extractor, found nothing"
    from "extractor never ran" downstream — only the latter is NULL."""
    messages = [
        {"role": "user", "content": "what's the weather?"},
        {"role": "assistant", "content": "sunny"},
    ]
    sid = await _push_and_upload(client, local_session_id="sess-no-refs", messages=messages)
    detail = (await client.get(f"/v1/sessions/{sid}")).json()
    assert detail["related_refs"] is None
