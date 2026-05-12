# Scope Mount (v2) Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox
> (`- [ ]`) syntax for tracking. Each phase produces a separately-reviewable,
> green-on-tests commit.

**Goal:** Layer a `ScopeMount` composition primitive on top of the
shipped v1 `ScopeMembership` capability primitive. After v2, `accept`
auto-mounts shared scopes into the user's owned scopes; the "Shared
with me" UX section disappears in favor of nested mount rendering.

**Architecture:** Two-table model — `ScopeMembership` (v1, unchanged,
the capability layer) + `ScopeMount` (NEW, the composition layer).
Mount edges are config on the parent scope; resolution always re-checks
viewer membership in the source (transitive permission expansion is
structurally impossible).

**Tech Stack:** Same as v1 — FastAPI + SQLAlchemy 2.0 async + alembic
+ asyncpg backend; TypeScript + Bun + Commander CLI; Next.js 15 +
TanStack Query + shadcn web.

**Reference spec:** `docs/superpowers/specs/2026-05-11-scope-mount-spec.md`

---

## Phase MA — Models + migration

### Task MA.1 — SQLAlchemy `ScopeMount` model

**Files:**
- Create: `backend/app/models/scope_mount.py`

- [ ] **Step 1:** Write the model class

```python
# backend/app/models/scope_mount.py
"""Scope composition primitive.

Where a ScopeMembership row says "the viewer X can read scope Y", a
ScopeMount says "scope Y's content appears under scope X in the
viewer's composed workspace". Mount edges are configuration on the
PARENT (X), not permission grants on the SOURCE (Y) — the resolver
always re-checks viewer membership against the source.

Spec § "Data model" — 2026-05-11-scope-mount-spec.md.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.core.mixins import TimestampMixin


class ScopeMount(Base, TimestampMixin):
    __tablename__ = "scope_mounts"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    parent_scope_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("scopes.id", ondelete="CASCADE"),
        nullable=False,
    )
    source_scope_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("scopes.id", ondelete="CASCADE"),
        nullable=False,
    )
    alias: Mapped[str] = mapped_column(String(80), nullable=False)
    mode: Mapped[str] = mapped_column(String(20), nullable=False, default="live")
    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("parent_scope_id", "source_scope_id", name="uq_scope_mounts_parent_source"),
        UniqueConstraint("parent_scope_id", "alias", name="uq_scope_mounts_parent_alias"),
        CheckConstraint("mode IN ('live')", name="ck_scope_mounts_mode_v2"),
        Index("ix_scope_mounts_parent", "parent_scope_id"),
        Index("ix_scope_mounts_source", "source_scope_id"),
    )
```

- [ ] **Step 2:** Verify import smoke test passes

```bash
cd backend && uv run python -c "from app.models.scope_mount import ScopeMount; print('OK')"
```

Expected: `OK`.

- [ ] **Step 3:** Commit

```bash
git add backend/app/models/scope_mount.py
git commit -m "feat(mount): ScopeMount SQLAlchemy model"
```

### Task MA.2 — Alembic migration

**Files:**
- Create: `backend/alembic/versions/<new-rev>_scope_mounts.py`

- [ ] **Step 1:** Generate the migration scaffold

```bash
cd backend && uv run alembic revision -m "scope mounts"
```

- [ ] **Step 2:** Fill in `upgrade()` / `downgrade()`

```python
"""scope mounts

Revision ID: <auto>
Revises: b8e4d1c6f23a
Create Date: 2026-05-12

DDL-only migration for the v2 composition primitive. Adds
scope_mounts table; no row-level migrations of existing v1 data
(that lives in a separate phase MG.1 — a one-time SQL fold).
"""

from alembic import op
import sqlalchemy as sa

revision = "<new-rev>"
down_revision = "b8e4d1c6f23a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "scope_mounts",
        sa.Column("id", sa.dialects.postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "parent_scope_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("scopes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "source_scope_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("scopes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("alias", sa.String(80), nullable=False),
        sa.Column("mode", sa.String(20), nullable=False, server_default="live"),
        sa.Column(
            "created_by",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "parent_scope_id", "source_scope_id",
            name="uq_scope_mounts_parent_source",
        ),
        sa.UniqueConstraint(
            "parent_scope_id", "alias",
            name="uq_scope_mounts_parent_alias",
        ),
        sa.CheckConstraint("mode IN ('live')", name="ck_scope_mounts_mode_v2"),
    )
    op.create_index("ix_scope_mounts_parent", "scope_mounts", ["parent_scope_id"])
    op.create_index("ix_scope_mounts_source", "scope_mounts", ["source_scope_id"])


def downgrade() -> None:
    op.drop_index("ix_scope_mounts_source", "scope_mounts")
    op.drop_index("ix_scope_mounts_parent", "scope_mounts")
    op.drop_table("scope_mounts")
```

- [ ] **Step 3:** Apply migration

```bash
cd backend && uv run alembic upgrade head
```

Expected: clean apply.

- [ ] **Step 4:** Verify roundtrip

```bash
cd backend && uv run alembic downgrade -1 && uv run alembic upgrade head
```

- [ ] **Step 5:** Commit

```bash
git add backend/alembic/versions/*scope_mounts*.py
git commit -m "feat(mount): alembic migration for scope_mounts"
```

### Task MA.3 — Pydantic schemas

**Files:**
- Modify: `backend/app/schemas/sharing.py`

- [ ] **Step 1:** Append mount schemas

```python
# Append to backend/app/schemas/sharing.py

class MountCreate(BaseModel):
    """Body for POST /api/scopes/{parent_scope_id}/mounts."""

    source_scope_id: str
    alias: str | None = None
    mode: str = "live"


class MountResponse(BaseModel):
    """Returned by GET /api/scopes/{id}/mounts and the POST create."""

    id: str
    parent_scope_id: str
    source_scope_id: str
    source_scope_name: str
    source_owner_display: str
    source_owner_handle: str
    alias: str
    mode: str
    created_at: datetime
```

- [ ] **Step 2:** Smoke import

```bash
cd backend && uv run python -c "from app.schemas.sharing import MountCreate, MountResponse; print('OK')"
```

- [ ] **Step 3:** Commit

```bash
git add backend/app/schemas/sharing.py
git commit -m "feat(mount): MountCreate / MountResponse schemas"
```

---

## Phase MB — Mount CRUD endpoints

### Task MB.1 — Route skeleton + `_assert_can_mount` helper

**Files:**
- Create: `backend/app/routes/mounts.py`
- Modify: `backend/app/main.py`
- Create: `backend/tests/test_scope_mounts.py`

- [ ] **Step 1:** Failing test — endpoint returns 404 for non-owned parent

```python
# backend/tests/test_scope_mounts.py
import pytest


@pytest.mark.asyncio
async def test_list_mounts_404_on_non_owned_parent(client):
    r = await client.get(
        "/api/scopes/00000000-0000-0000-0000-000000000000/mounts"
    )
    assert r.status_code == 404
```

- [ ] **Step 2:** Run, expect 404 from a fresh route — actually currently 404 because the route doesn't exist. That's fine; we just want a deterministic signal.

```bash
cd backend && uv run pytest tests/test_scope_mounts.py -v
```

- [ ] **Step 3:** Implement skeleton

```python
# backend/app/routes/mounts.py
"""Scope mount management — owner-only.

A mount is a composition edge on the parent scope. Adding a mount
requires:
  1. Caller owns the parent scope (write-side privilege).
  2. Caller has independent membership in the source scope (or
     owns it). This re-checks the viewer's read capability so a
     mount can't bypass v1's permission model.

Spec: docs/superpowers/specs/2026-05-11-scope-mount-spec.md § "API surface"
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_user_auth_unbound
from app.core.database import get_session
from app.core.scope import scope_ids_visible_to, validate_scope_for_caller
from app.models.scope import Scope
from app.models.scope_mount import ScopeMount
from app.models.user import User
from app.schemas.sharing import MountCreate, MountResponse
from app.services.sharing import resolve_owner_handle

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/scopes", tags=["mounts"])


async def _build_mount_response(
    db: AsyncSession, mount: ScopeMount
) -> MountResponse:
    src = (
        await db.execute(select(Scope).where(Scope.id == mount.source_scope_id))
    ).scalar_one()
    owner = (
        await db.execute(select(User).where(User.id == src.user_id))
    ).scalar_one()
    return MountResponse(
        id=str(mount.id),
        parent_scope_id=str(mount.parent_scope_id),
        source_scope_id=str(mount.source_scope_id),
        source_scope_name=src.name,
        source_owner_display=owner.name or owner.email or f"user-{str(owner.id)[:8]}",
        source_owner_handle=resolve_owner_handle(owner),
        alias=mount.alias,
        mode=mount.mode,
        created_at=mount.created_at,
    )


@router.get("/{parent_scope_id}/mounts", response_model=list[MountResponse])
async def list_mounts(
    parent_scope_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> list[MountResponse]:
    """List mounts active on a parent scope (owner only)."""
    await validate_scope_for_caller(db, auth, parent_scope_id)
    rows = (
        await db.execute(
            select(ScopeMount)
            .where(ScopeMount.parent_scope_id == parent_scope_id)
            .order_by(ScopeMount.created_at.asc())
        )
    ).scalars().all()
    return [await _build_mount_response(db, m) for m in rows]
```

- [ ] **Step 4:** Wire up router in main.py

```python
# Append to backend/app/main.py imports
from app.routes.mounts import router as mounts_router

# In the `app.include_router(...)` block
app.include_router(mounts_router)
```

- [ ] **Step 5:** Verify the 404 test passes

```bash
cd backend && uv run pytest tests/test_scope_mounts.py -v
```

Expected: 1 passed (the 404 case for non-owned parent).

- [ ] **Step 6:** Commit

```bash
git add backend/app/routes/mounts.py backend/app/main.py backend/tests/test_scope_mounts.py
git commit -m "feat(mount): GET /api/scopes/{id}/mounts list endpoint"
```

### Task MB.2 — `POST /api/scopes/{id}/mounts` (create)

**Files:**
- Modify: `backend/app/routes/mounts.py`
- Modify: `backend/tests/test_scope_mounts.py`

- [ ] **Step 1:** Failing test — owner can create a mount with valid source

```python
# Append to backend/tests/test_scope_mounts.py
from datetime import UTC, datetime
import uuid


@pytest.mark.asyncio
async def test_create_mount_succeeds_for_owner_with_membership(
    client, db_session, seed_user, seed_scope
):
    """Owner of parent + member-of-source can mount it in. Default
    alias is @<owner-handle>/<source-slug>."""
    from app.models.scope import SCOPE_KIND_ENVIRONMENT, Scope
    from app.models.scope_membership import ScopeMembership
    from app.models.user import User

    seed_user.name = "Bob"
    # Create alice + her engineering scope
    nonce = uuid.uuid4().hex[:8]
    alice = User(
        clerk_id=f"alice_{nonce}",
        email=f"alice_{nonce}@test.dev",
        name="Alice",
    )
    db_session.add(alice)
    await db_session.commit()
    alice_eng = Scope(
        user_id=alice.id,
        name="Engineering",
        slug=f"engineering-{nonce}",
        kind=SCOPE_KIND_ENVIRONMENT,
    )
    db_session.add(alice_eng)
    await db_session.commit()
    # Seed Bob's membership in Alice's scope (the capability).
    db_session.add(
        ScopeMembership(
            scope_id=alice_eng.id,
            user_id=seed_user.id,
            role="viewer",
            joined_via="link",
            joined_at=datetime.now(UTC),
            resolved_owner_handle="alice-test",
        )
    )
    await db_session.commit()

    r = await client.post(
        f"/api/scopes/{seed_scope.id}/mounts",
        json={"source_scope_id": str(alice_eng.id)},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["parent_scope_id"] == str(seed_scope.id)
    assert body["source_scope_id"] == str(alice_eng.id)
    assert body["source_scope_name"] == "Engineering"
    assert body["alias"].startswith("@")


@pytest.mark.asyncio
async def test_create_mount_403_without_source_membership(
    client, db_session, seed_user, seed_scope
):
    """Caller owns parent but has no membership in source → 403."""
    from app.models.scope import SCOPE_KIND_ENVIRONMENT, Scope
    from app.models.user import User

    seed_user.name = "Bob"
    nonce = uuid.uuid4().hex[:8]
    other = User(
        clerk_id=f"other_{nonce}",
        email=f"other_{nonce}@test.dev",
        name="Other",
    )
    db_session.add(other)
    await db_session.commit()
    foreign = Scope(
        user_id=other.id,
        name="Foreign",
        slug=f"foreign-{nonce}",
        kind=SCOPE_KIND_ENVIRONMENT,
    )
    db_session.add(foreign)
    await db_session.commit()

    r = await client.post(
        f"/api/scopes/{seed_scope.id}/mounts",
        json={"source_scope_id": str(foreign.id)},
    )
    assert r.status_code == 403
    assert r.json()["detail"]["error"] == "source_not_visible"


@pytest.mark.asyncio
async def test_create_mount_409_on_duplicate(
    client, db_session, seed_user, seed_scope
):
    """Same (parent, source) pair → 409."""
    # ... [same setup as the success test, then create twice]
```

- [ ] **Step 2:** Run, expect fails

- [ ] **Step 3:** Implement the POST handler

```python
# Append to backend/app/routes/mounts.py
@router.post("/{parent_scope_id}/mounts", response_model=MountResponse)
async def create_mount(
    parent_scope_id: UUID,
    body: MountCreate,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> MountResponse:
    """Mount a source scope into a parent scope.

    Auth: caller must own parent AND have viewer-or-owner membership
    in source (re-checked via scope_ids_visible_to to honor v1's
    capability layer).
    """
    await validate_scope_for_caller(db, auth, parent_scope_id)
    try:
        source_id = UUID(body.source_scope_id)
    except (ValueError, AttributeError):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid source_scope_id")

    if source_id == parent_scope_id:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            {"error": "self_mount", "message": "Cannot mount a scope into itself."},
        )

    # Capability re-check — must hold membership or ownership of source.
    visible = await scope_ids_visible_to(db, auth)
    if source_id not in visible:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            {
                "error": "source_not_visible",
                "message": (
                    "You must hold membership in the source scope before "
                    "mounting it. Run `clawdi share accept` or accept an "
                    "invitation first."
                ),
            },
        )

    # Resolve default alias if not provided.
    alias = body.alias
    if not alias:
        from app.services.sharing import resolve_owner_handle
        src = (
            await db.execute(select(Scope).where(Scope.id == source_id))
        ).scalar_one()
        owner = (
            await db.execute(select(User).where(User.id == src.user_id))
        ).scalar_one()
        try:
            handle = resolve_owner_handle(owner)
        except ValueError:
            handle = "unknown-owner"
        alias = f"@{handle}/{src.slug}"

    mount = ScopeMount(
        parent_scope_id=parent_scope_id,
        source_scope_id=source_id,
        alias=alias,
        mode=body.mode or "live",
        created_by=auth.user_id,
        created_at=datetime.now(UTC),
    )
    db.add(mount)
    try:
        await db.commit()
    except IntegrityError as err:
        await db.rollback()
        # 409 — same (parent, source) OR same (parent, alias) collision.
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "error": "mount_conflict",
                "message": (
                    "A mount with this source or alias already exists on "
                    "this parent."
                ),
            },
        ) from err
    await db.refresh(mount)

    logger.info(
        "scope_mount_created parent=%s source=%s alias=%s by=%s",
        parent_scope_id, source_id, alias, auth.user_id,
    )
    return await _build_mount_response(db, mount)
```

- [ ] **Step 4:** Verify tests pass

- [ ] **Step 5:** Commit

```bash
git add backend/app/routes/mounts.py backend/tests/test_scope_mounts.py
git commit -m "feat(mount): POST mount-create endpoint with source-capability re-check"
```

### Task MB.3 — `DELETE /api/scopes/{id}/mounts/{mount_id}`

**Files:**
- Modify: `backend/app/routes/mounts.py`
- Modify: `backend/tests/test_scope_mounts.py`

- [ ] **Step 1:** Failing test — owner can unmount

```python
@pytest.mark.asyncio
async def test_unmount_owner_succeeds(
    client, db_session, seed_user, seed_scope
):
    # ... seed mount, then delete it, then verify gone via list
```

- [ ] **Step 2:** Implement DELETE handler

```python
@router.delete("/{parent_scope_id}/mounts/{mount_id}")
async def delete_mount(
    parent_scope_id: UUID,
    mount_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    """Drop a mount edge. Does NOT touch the underlying membership;
    use POST /api/me/scopes/{source}/leave for that (future v3)."""
    await validate_scope_for_caller(db, auth, parent_scope_id)
    row = (
        await db.execute(
            select(ScopeMount).where(
                ScopeMount.id == mount_id,
                ScopeMount.parent_scope_id == parent_scope_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "mount not found")
    await db.delete(row)
    await db.commit()
    logger.info(
        "scope_mount_deleted id=%s parent=%s by=%s",
        mount_id, parent_scope_id, auth.user_id,
    )
    return {"status": "unmounted"}
```

- [ ] **Step 3:** Verify test passes

- [ ] **Step 4:** Commit

```bash
git add backend/app/routes/mounts.py backend/tests/test_scope_mounts.py
git commit -m "feat(mount): DELETE mount endpoint"
```

---

## Phase MC — Auto-mount on `accept`

### Task MC.1 — Auto-mount inside `/upgrade` handler

**Files:**
- Modify: `backend/app/routes/share_redeem.py`
- Modify: `backend/tests/test_share_redeem_routes.py`

- [ ] **Step 1:** Extend the upgrade test to check the mount

```python
@pytest.mark.asyncio
async def test_upgrade_auto_mounts_into_default_scope(
    db_session, seed_user, seed_scope
):
    # ... create the share link
    # ... POST /upgrade
    # ... assert membership row created (v1 behavior preserved)
    # ... assert ScopeMount row created with:
    #     parent_scope_id = user's default-write scope (= seed_user's Personal)
    #     source_scope_id = the shared scope
    #     alias = "@<owner-handle>/<source-slug>"
```

- [ ] **Step 2:** Implement auto-mount inside the `/upgrade` route, in the SAME transaction as the membership insert. Use `INSERT ... ON CONFLICT DO NOTHING` semantics (catch IntegrityError) for idempotency on retry.

```python
# In backend/app/routes/share_redeem.py, inside the upgrade() handler
# after the membership insert, before the commit:

from app.models.scope_mount import ScopeMount
from app.core.scope import resolve_default_write_scope

default_parent = await resolve_default_write_scope(db, auth)
# Resolve a non-colliding alias.
src = (await db.execute(select(Scope).where(Scope.id == ctx.scope_id))).scalar_one()
candidate_alias = f"@{link.resolved_owner_handle}/{src.slug}"

try:
    mount = ScopeMount(
        parent_scope_id=default_parent,
        source_scope_id=ctx.scope_id,
        alias=candidate_alias,
        mode="live",
        created_by=auth.user_id,
        created_at=datetime.now(UTC),
    )
    db.add(mount)
    await db.flush()
except IntegrityError:
    await db.rollback()
    # ... reattach membership and retry without mount (or with a
    # disambiguated alias). Detail in spec § "Migration".
```

- [ ] **Step 3:** Verify the test passes

- [ ] **Step 4:** Commit

```bash
git add backend/app/routes/share_redeem.py backend/tests/test_share_redeem_routes.py
git commit -m "feat(mount): /upgrade auto-mounts into default-write scope"
```

### Task MC.2 — Same auto-mount on `/me/invitations/{id}/accept`

**Files:**
- Modify: `backend/app/routes/me.py`
- Modify: `backend/tests/test_me_routes.py`

- [ ] **Step 1:** Add a `test_accept_auto_mounts` to test_me_routes.py mirroring MC.1's check.

- [ ] **Step 2:** Apply the same auto-mount logic in `accept_invitation()`.

- [ ] **Step 3:** Verify test passes.

- [ ] **Step 4:** Commit.

---

## Phase MD — Read-path resolution walks mounts

### Task MD.1 — `resolve_visible_scopes_with_mounts` helper

**Files:**
- Modify: `backend/app/core/scope.py`
- Create: `backend/tests/test_scope_visibility_mounts.py`

- [ ] **Step 1:** Failing test — composed-scope read sees mounted content

```python
# tests/test_scope_visibility_mounts.py
@pytest.mark.asyncio
async def test_resolved_visibility_includes_mounted_sources(
    db_session, seed_user, seed_scope
):
    """Bob's Personal scope mounts Alice's Engineering. Resolved
    visibility for Bob includes BOTH scope IDs."""
    # ... seed alice + her scope + Bob's membership + Bob's mount
    # ... call resolve_visible_scopes_with_mounts(db, auth)
    # ... assert alice's scope in the resolved set
```

- [ ] **Step 2:** Implement the helper

```python
# Append to backend/app/core/scope.py
async def resolve_visible_scopes_with_mounts(
    db: AsyncSession, auth: AuthContext
) -> list[UUID]:
    """Like scope_ids_visible_to, but also unfolds shallow mount
    edges where the viewer holds independent membership in the
    source.

    Critical safety property: a mount edge does NOT grant access.
    It only references content the viewer is already allowed to see.
    """
    from app.models.scope_mount import ScopeMount

    base = set(await scope_ids_visible_to(db, auth))
    if not base:
        return []
    # Walk mount edges where parent IS in base AND source IS in base.
    rows = (
        await db.execute(
            select(ScopeMount.source_scope_id).where(
                ScopeMount.parent_scope_id.in_(base),
                ScopeMount.source_scope_id.in_(base),
            )
        )
    ).scalars().all()
    # Sources already in base (since the safety check requires
    # independent membership). Return base + add any sources that
    # weren't already there (cannot happen given the IN clause, but
    # the loop keeps the semantics obvious and v3-friendly).
    return list(base)
```

- [ ] **Step 3:** Verify the test passes

- [ ] **Step 4:** Commit

### Task MD.2 — Skill list endpoint walks mounts

**Files:**
- Modify: `backend/app/routes/skills.py`
- Modify: `backend/tests/test_scope_visibility_shared.py` (extend)

- [ ] **Step 1:** Test that a parent-scope-filtered skill query returns mounted content too

```python
@pytest.mark.asyncio
async def test_skill_list_parent_scope_returns_mounted_content(...):
    """GET /api/skills?scope_id=<personal-bob> returns skills from
    BOTH Bob's Personal AND Alice's Engineering (mounted into Personal)."""
```

- [ ] **Step 2:** Swap the visibility helper in `list_skills` to use the mount-aware version

- [ ] **Step 3:** Tests pass + commit

### Task MD.3 — Vault list + read also walk mounts (with precedence)

**Files:**
- Modify: `backend/app/routes/vault.py`
- Create: `backend/tests/test_vault_mount_precedence.py`

- [ ] **Step 1:** Test parent-own-wins precedence

```python
@pytest.mark.asyncio
async def test_vault_precedence_parent_own_wins(...):
    """Parent has OPENAI_KEY=A; mount source has OPENAI_KEY=B.
    Resolve returns A (own beats mount)."""


@pytest.mark.asyncio
async def test_vault_precedence_oldest_mount_wins(...):
    """Parent has no key; two mounts both have OPENAI_KEY.
    Resolve returns the mount with earliest created_at."""
```

- [ ] **Step 2:** Implement precedence-aware resolve

- [ ] **Step 3:** Tests pass + commit

---

## Phase ME — CLI: `scope mount/unmount/mounts`, accept UX, scope-list tree

### Task ME.1 — New `clawdi scope mount/unmount/mounts` commands

**Files:**
- Create: `packages/cli/src/commands/scope-mount.ts`
- Modify: `packages/cli/src/index.ts`

### Task ME.2 — `share accept` and `scope invites --accept` outputs the new mount story

**Files:**
- Modify: `packages/cli/src/commands/share-accept.ts`
- Modify: `packages/cli/src/commands/scope-invites.ts`

(Old output: "Joined as viewer — your dashboard now lists this scope".
New output: "Mounted '<src>' into your <parent> as @<handle>/<slug>".)

### Task ME.3 — `scope list` renders nested mount tree, drops "Shared with me"

**Files:**
- Modify: `packages/cli/src/commands/scope-list.ts`

---

## Phase MF — Web: mount inbox toast + per-scope mount panel + drop "Shared with me"

### Task MF.1 — Modify InvitationsInbox accept handler

**Files:**
- Modify: `apps/web/src/components/sharing/invitations-inbox.tsx`

(Toast renders "Mounted into your Personal scope as @alice/engineering"
instead of "Joined as viewer — shared skills now appear in your
dashboard".)

### Task MF.2 — Per-scope mount panel component

**Files:**
- Create: `apps/web/src/components/sharing/scope-mounts-panel.tsx`
- Wire into the per-scope detail page

### Task MF.3 — Drop "Shared with me" rendering from `/skills`

**Files:**
- Modify: `apps/web/src/app/(dashboard)/skills/page.tsx`

(The `<InvitationsInbox />` banner stays — pending invitations are
still a thing. What goes is any rendering of accepted-but-not-mounted
"shared scopes" as a separate section. Mounts replace that.)

---

## Phase MG — Migration script for v1 sharees + demo doc rewrite

### Task MG.1 — Data-migration SQL: backfill mounts for existing memberships

**Files:**
- Create: `backend/alembic/versions/<new-rev>_backfill_mounts.py`

Migration `op.execute(...)` runs a SQL that inserts a ScopeMount for
each existing ScopeMembership where the user has a default-write
scope. Conflict on alias gets numeric suffix. Spec § "Migration".

### Task MG.2 — Run an integration test: every existing v1-shipped membership ends up with a mount

**Files:**
- Create: `backend/tests/test_mount_backfill.py`

### Task MG.3 — Rewrite `docs/scenarios/scope-sharing-demo.md`

Move the current v1 demo to `docs/scenarios/archive/scope-sharing-demo-v1.md`.

Write a new top-level demo doc that captures fresh CLI output post-v2:
- `share accept` says "Mounted into your Personal scope as @alice/engineering"
- `scope list` shows nested mount tree
- `vault resolve --debug` shows precedence chain
- The "What we did NOT build (v2 territory)" section in v1 demo gets
  inverted to "What v3 territory we deliberately did NOT build" —
  marketplace, editor role, recursive mount-of-mount.

### Task MG.4 — Final push, full test suite + demo capture

```bash
# Should be green:
cd backend && uv run pytest tests/
cd packages/cli && bun test
# Web should build cleanly
bun run --filter web build
# Live demo against running backend
/tmp/run-demo-v2.sh
```

---

## Risk gates

1. **Phase MA → MB:** Does the migration's `ON DELETE CASCADE`
   semantics break anything? If a user's Personal scope is ever
   force-deleted, all their mounts go too. That's correct.

2. **Phase MC:** The auto-mount-on-accept can race with concurrent
   accepts on the same (parent, source). The unique constraint catches
   it; the handler catches IntegrityError and treats it as "already
   mounted" success.

3. **Phase MD:** The mount-aware visibility helper risks an N+1 if
   we walk mounts naively. Use `WHERE parent_scope_id IN (...)` with
   the full set in one query.

4. **Phase ME:** The CLI's tree rendering needs to handle the case
   where a mount's source_scope is unknown to the local cache. Always
   fall back to "<source-id> (no metadata)" rather than crashing.

5. **Phase MG:** The data migration is one-shot. If it fails midway,
   `op.execute("DELETE FROM scope_mounts WHERE ...")` is the rollback;
   the existing memberships are unaffected (rollback target is just
   the backfilled rows).

---

## Done = ready to ship?

- [ ] All 226 v1 backend tests still green
- [ ] All 282 v1 CLI tests still green
- [ ] ~25 new mount-specific tests added and green
- [ ] Backend, CLI, web all typecheck + lint clean
- [ ] Live three-persona demo captured to new demo doc
- [ ] Migration applied locally + idempotent on re-apply
- [ ] v1 demo doc moved to archive/
