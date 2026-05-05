from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class SkillInstallRequest(BaseModel):
    # `repo` and `path` flow into `fetch_skill_from_github` and the
    # GitHub API URL path. Constraining to safe characters blocks
    # newline / control-char log-injection. Length caps mirror
    # GitHub's limits.
    repo: str = Field(pattern=r"^[A-Za-z0-9._\-]{1,100}/[A-Za-z0-9._\-]{1,100}$")
    # Pydantic's regex engine doesn't support lookahead, so the
    # `..` traversal guard lives in a field validator below.
    path: str | None = Field(default=None, pattern=r"^[A-Za-z0-9._\-/]{0,200}$")

    @field_validator("path")
    @classmethod
    def _no_traversal(cls, v: str | None) -> str | None:
        # Reject any segment that's exactly `..`. A bare `..` segment
        # (e.g. `path = "..", "../foo", "foo/..", "a/../b"`) would let
        # a marketplace install reach beyond the repo via the GitHub
        # API URL path. Single dots are allowed because legitimate
        # skill paths use `.config/skills` and similar.
        if v is None:
            return v
        if any(seg == ".." for seg in v.split("/")):
            raise ValueError("path must not contain `..` segments")
        return v


class SkillSummaryResponse(BaseModel):
    id: str
    skill_key: str
    name: str
    description: str | None
    version: int
    source: str
    source_repo: str | None
    agent_types: list[str] | None
    file_count: int | None
    content_hash: str
    is_active: bool
    created_at: datetime
    updated_at: datetime
    content: str | None = None
    # Scope + machine surface so the dashboard can render a
    # per-machine grouped list, target the scope-explicit URLs
    # (delete / re-upload) without a separate fetch, and show
    # which machine owns the skill. `machine_name` is null for
    # skills in the user's Personal scope (no env-bound origin).
    scope_id: str | None = None
    scope_name: str | None = None
    machine_name: str | None = None
    environment_id: str | None = None


class SkillDetailResponse(BaseModel):
    id: str
    skill_key: str
    name: str
    description: str | None
    version: int
    source: str
    source_repo: str | None
    file_count: int | None
    content: str | None
    agent_types: list[str] | None
    created_at: datetime
    # Source-of-truth hash the dashboard editor uses for optimistic-
    # display purposes (compare to last-known to detect external
    # writes mid-edit).
    content_hash: str = ""
    updated_at: datetime | None = None
    # Scope + machine context for the detail page. Lets the editor
    # build the `/api/scopes/{scope_id}/skills/upload` URL for save
    # without an extra round-trip, and lets the page caption say
    # "on my-mac" so multi-machine users can tell which copy
    # they're looking at.
    scope_id: str | None = None
    scope_name: str | None = None
    machine_name: str | None = None
    environment_id: str | None = None


class SkillUploadResponse(BaseModel):
    skill_key: str
    name: str
    version: int
    file_count: int
    # Echo the resulting content_hash so `clawdi serve` daemons
    # can chain the next push with `If-Match: <this hash>` without
    # an extra round-trip. Empty (legacy) is fine for old callers
    # that don't read it.
    content_hash: str = ""


class SkillContentUpdateRequest(BaseModel):
    # Raw SKILL.md text (frontmatter + body). The server tars it
    # into a single-file archive and runs the same upload pipeline
    # as a daemon push, so dashboard edits and CLI pushes converge
    # on the same row + storage object.
    content: str = Field(min_length=1, max_length=200 * 1024)
    # Optional last-known hash. Phase-1 dashboard editor leaves this
    # blank (last-write-wins). Phase-2 can pass the hash captured
    # when the editor opened to detect "someone else edited" and
    # surface a soft-merge prompt.
    content_hash: str | None = Field(
        default=None,
        min_length=64,
        max_length=64,
        pattern=r"^[a-f0-9]{64}$",
    )


class SkillDeleteResponse(BaseModel):
    status: Literal["deleted"]


class SkillInstallResponse(BaseModel):
    skill_key: str
    name: str
    description: str | None
    version: int
    file_count: int
    repo: str
