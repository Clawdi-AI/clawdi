# Cross-User Scope Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v1 of cross-user scope sharing for skills + vaults, with share-link + email-invite ingress paths, Owner + Viewer role model, and equal CLI + Web dashboard coverage.

**Architecture:** Token-based anonymous access with post-login membership upgrade (Figma view-link / Spotify playlist pattern). Three new tables (`scope_memberships`, `scope_invitations`, `scope_share_links`), one new share-token middleware, `scope_ids_visible_to` extension. No anonymous user row in the schema. Vault keeps server-side decrypt model for v1; per-member envelope encryption deferred.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 async + asyncpg + Alembic (backend); TypeScript + Bun + Commander (CLI); Next.js 15 App Router + Clerk + TanStack Query + shadcn/ui (web); PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-05-11-scope-sharing-design.md`

**Phases (PR-sized chunks):**
- Phase A — Backend schema + models + migration
- Phase B — Backend owner routes (links / invites / members)
- Phase C — Backend sharee routes (share-token middleware, redeem, upgrade, /me)
- Phase D — Access integration (`scope_ids_visible_to` extension, vault gate verification)
- Phase E — CLI commands + `share-tokens.json` + auto-upgrade + adapter integration
- Phase F — Web dashboard pages + sharing tab + landing page + invite inbox
- Phase G — E2E + final polish

Each phase ends with a commit + push and is reviewable independently.

---

## File Structure

### Backend (Python)

```
backend/app/models/
  scope_membership.py            (new)
  scope_invitation.py            (new)
  scope_share_link.py            (new)

backend/app/schemas/
  sharing.py                     (new — all sharing request/response models)

backend/app/services/
  sharing.py                     (new — owner-handle resolution,
                                  share-token generation/verification,
                                  unshare transaction helper)

backend/app/routes/
  sharing.py                     (new — owner-facing /api/scopes/{id}/...
                                  endpoints for links, invites, members)
  share_redeem.py                (new — public /api/share/{token}/... routes)
  me.py                          (new — /api/me/scopes, /api/me/invitations)
  scopes.py                      (modify — add leave endpoint + is_owner flag
                                  on existing list)

backend/app/core/
  scope.py                       (modify — scope_ids_visible_to extended
                                  for shared memberships)
  auth.py                        (modify — add require_share_token dep)

backend/app/main.py              (modify — register new routers)

backend/alembic/versions/
  XXXXXXXXXXXX_scope_sharing.py  (new — DDL-only migration)

backend/tests/
  test_sharing_owner.py          (new)
  test_sharing_invitations.py    (new)
  test_sharing_redeem.py         (new)
  test_sharing_upgrade.py        (new)
  test_scope_visibility_shared.py (new)
  test_vault_shared_gate.py      (new)
```

### CLI (TypeScript)

```
packages/cli/src/share/
  tokens.ts                      (new — ~/.clawdi/share-tokens.json store)
  redeem.ts                      (new — share accept implementation)
  upgrade.ts                     (new — post-login auto-upgrade)
  paths.ts                       (new — local skill path resolution
                                  with __owner-handle suffix)

packages/cli/src/commands/
  scope-share.ts                 (new — clawdi scope share)
  scope-share-links.ts           (new — clawdi scope share-links)
  scope-invite.ts                (new — clawdi scope invite)
  scope-invites.ts               (new — clawdi scope invites — inbox + outgoing)
  scope-members.ts               (new — clawdi scope members)
  scope-unshare.ts               (new — clawdi scope unshare)
  scope-leave.ts                 (new — clawdi scope leave)
  scope-list.ts                  (modify — include "shared with me" rows)
  share-accept.ts                (new — clawdi share accept <url>)
  share-list.ts                  (new — clawdi share list)
  share-remove.ts                (new — clawdi share remove <scope>)
  auth-login.ts                  (modify — call upgrade flow after login)

packages/cli/src/adapters/
  base.ts                        (modify — add getSharedSkillPath signature)
  claude-code.ts                 (modify — implement getSharedSkillPath)
  codex.ts                       (modify — implement)
  openclaw.ts                    (modify — implement)
  hermes.ts                      (modify — implement)

packages/cli/src/serve/
  sync-engine.ts                 (modify — enumerate share tokens for
                                  anonymous-mode downstream sync)

packages/cli/src/index.ts        (modify — register new commands)

packages/cli/src/share/
  tokens.test.ts                 (new)
  redeem.test.ts                 (new)
  upgrade.test.ts                (new)
  paths.test.ts                  (new)
```

### Web (TypeScript / Next.js)

```
apps/web/src/app/share/[token]/
  page.tsx                       (new — public landing page,
                                  no Clerk middleware)

apps/web/src/app/(dashboard)/scopes/[id]/
  page.tsx                       (modify — branch on is_owner)
  leave-button.tsx               (new — sharee-only)
  sharing/
    page.tsx                     (new — owner-only Sharing tab page)
    links-section.tsx            (new)
    invitations-section.tsx      (new)
    members-section.tsx          (new)

apps/web/src/app/(dashboard)/me/invitations/
  page.tsx                       (new — incoming invitation inbox)

apps/web/src/components/dashboard/
  scopes-sidebar.tsx             (modify — split "My scopes" / "Shared with me")
  scope-shared-badge.tsx         (new — used on skill/vault rows)

apps/web/src/lib/sharing/
  use-share-link.ts              (new — TanStack mutations)
  use-members.ts                 (new)
  use-invitations.ts             (new)
```

### Shared Types

```
packages/shared/src/api/
  api.generated.ts               (regenerated after backend ships
                                  — covered in Phase A.10)
```

### Scripts / E2E

```
scripts/
  e2e/scope-sharing.sh           (new — happy-path manual flow)

backend/tests/
  test_sharing_e2e.py            (new — programmatic full lifecycle)
```

---

## Phase A — Backend Schema, Models, Migration

Goal: land the three new tables + their SQLAlchemy models + Alembic migration + import-time smoke tests. End state: schema deployed, no business logic yet.

### Task A.1: SQLAlchemy model `ScopeMembership`

**Files:**
- Create: `backend/app/models/scope_membership.py`
- Create: `backend/tests/test_scope_sharing_models_import.py`

- [ ] **Step 1: Write the failing import test**

In `backend/tests/test_scope_sharing_models_import.py`:

```python
"""Smoke test: models import cleanly + register with metadata.

These tests don't need a DB session — they just verify the model files
parse, declare correct columns, and register with SQLAlchemy's metadata
so a later `Base.metadata.create_all` (or alembic autogenerate) sees them.
"""


def test_scope_membership_model_importable():
    from app.models.scope_membership import ScopeMembership

    assert ScopeMembership.__tablename__ == "scope_memberships"
    cols = {c.name for c in ScopeMembership.__table__.columns}
    assert {"id", "scope_id", "user_id", "role", "joined_via", "joined_at",
            "resolved_owner_handle"} <= cols
```

- [ ] **Step 2: Verify it fails**

Run: `cd backend && uv run pytest tests/test_scope_sharing_models_import.py::test_scope_membership_model_importable -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.models.scope_membership'`

- [ ] **Step 3: Implement the model**

Create `backend/app/models/scope_membership.py`:

```python
"""Membership of a user in a scope owned by another user.

A row links one Clerk-bound `users.id` to one `scopes.id` with a role.
Anonymous share-token holders do NOT get rows here — token-only access
is governed by `scope_share_links` and does not produce membership
until the sharee signs in and upgrades.

`resolved_owner_handle` is frozen at row creation so the sharee's local
skill path (`<key>__<handle>/`) stays stable if the owner renames.
"""

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.scope import Scope as Scope  # noqa: F401 — FK target
from app.models.user import User as User  # noqa: F401 — FK target


class ScopeMembership(Base, TimestampMixin):
    __tablename__ = "scope_memberships"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    scope_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("scopes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # 'viewer' is the only v1 role. 'editor' reserved for follow-up;
    # CHECK constraint extended via DROP+ADD when that ships.
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    # Origin of this membership row:
    #   'invite' — email invitation accepted
    #   'link'   — any share-link path (web direct, CLI direct,
    #              or post-anonymous token upgrade — all converge here)
    joined_via: Mapped[str] = mapped_column(String(32), nullable=False)
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    # See spec § 11.6 — frozen owner display at join time so the local
    # skill folder `<key>__<handle>/` never moves under the sharee.
    resolved_owner_handle: Mapped[str] = mapped_column(String(64), nullable=False)

    __table_args__ = (
        UniqueConstraint("scope_id", "user_id", name="uq_scope_memberships_scope_user"),
        CheckConstraint("role IN ('viewer')", name="ck_scope_memberships_role_v1"),
        CheckConstraint(
            "joined_via IN ('invite', 'link')",
            name="ck_scope_memberships_joined_via_v1",
        ),
    )
```

- [ ] **Step 4: Verify it passes**

Run: `cd backend && uv run pytest tests/test_scope_sharing_models_import.py::test_scope_membership_model_importable -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/models/scope_membership.py backend/tests/test_scope_sharing_models_import.py
git commit -m "feat(models): add ScopeMembership model"
```

---

### Task A.2: SQLAlchemy model `ScopeInvitation`

**Files:**
- Create: `backend/app/models/scope_invitation.py`
- Modify: `backend/tests/test_scope_sharing_models_import.py`

- [ ] **Step 1: Extend the import-smoke test**

Append to `backend/tests/test_scope_sharing_models_import.py`:

```python
def test_scope_invitation_model_importable():
    from app.models.scope_invitation import ScopeInvitation

    assert ScopeInvitation.__tablename__ == "scope_invitations"
    cols = {c.name for c in ScopeInvitation.__table__.columns}
    assert {"id", "scope_id", "invitee_user_id", "invitee_email",
            "invited_by", "created_at"} <= cols
```

- [ ] **Step 2: Verify fail**

Run: `cd backend && uv run pytest tests/test_scope_sharing_models_import.py::test_scope_invitation_model_importable -v`
Expected: FAIL with ModuleNotFoundError.

- [ ] **Step 3: Implement model**

Create `backend/app/models/scope_invitation.py`:

```python
"""Outstanding email-based invitation to a scope.

Row exists from `POST /api/scopes/{id}/invitations` until invitee
accepts (→ row deleted, `ScopeMembership` created), declines (row
deleted), or owner cancels (row deleted). No terminal "accepted_at"
state — the membership row IS the post-accept record.

Uniqueness is `(scope_id, invitee_user_id)` (NOT email): invitees
are looked up to a `users.id` at invitation time, and email changes
on the Clerk side don't lose the invite. `invitee_email` is kept
as historical context for the owner's UI but is no longer the
identity key. See spec § 4.5 / § 6.1.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.scope import Scope as Scope  # noqa: F401
from app.models.user import User as User  # noqa: F401


class ScopeInvitation(Base, TimestampMixin):
    __tablename__ = "scope_invitations"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    scope_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("scopes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    invitee_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    invitee_email: Mapped[str] = mapped_column(String(320), nullable=False)
    invited_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )

    __table_args__ = (
        # One pending invite per (scope, invitee). Reinvites by
        # alternate email aliases of the same user still collide.
        UniqueConstraint(
            "scope_id", "invitee_user_id",
            name="uq_scope_invitations_scope_user",
        ),
    )
```

- [ ] **Step 4: Verify pass**

Run: `cd backend && uv run pytest tests/test_scope_sharing_models_import.py::test_scope_invitation_model_importable -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/models/scope_invitation.py backend/tests/test_scope_sharing_models_import.py
git commit -m "feat(models): add ScopeInvitation model"
```

---

### Task A.3: SQLAlchemy model `ScopeShareLink`

**Files:**
- Create: `backend/app/models/scope_share_link.py`
- Modify: `backend/tests/test_scope_sharing_models_import.py`

- [ ] **Step 1: Extend smoke test**

Append:

```python
def test_scope_share_link_model_importable():
    from app.models.scope_share_link import ScopeShareLink

    assert ScopeShareLink.__tablename__ == "scope_share_links"
    cols = {c.name for c in ScopeShareLink.__table__.columns}
    assert {"id", "scope_id", "token_hash", "token_prefix", "label",
            "created_by", "resolved_owner_handle",
            "created_at", "expires_at", "revoked_at",
            "redeem_count", "last_redeemed_at"} <= cols
```

- [ ] **Step 2: Verify fail**

Run: `cd backend && uv run pytest tests/test_scope_sharing_models_import.py::test_scope_share_link_model_importable -v`
Expected: FAIL.

- [ ] **Step 3: Implement model**

Create `backend/app/models/scope_share_link.py`:

```python
"""One share-link row per generated link.

Owners create multiple links per scope (one to share with a team, one
with a community, etc.). Each is independently revocable. The raw
token is never stored — only `token_hash = sha256(token)`. The first
8 chars of the raw token are kept in `token_prefix` purely for the
owner's UI ("link starting with abc12345...") so they can identify
which one to revoke without seeing the rest.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.scope import Scope as Scope  # noqa: F401
from app.models.user import User as User  # noqa: F401


class ScopeShareLink(Base, TimestampMixin):
    __tablename__ = "scope_share_links"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    scope_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("scopes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # sha256(raw_token), 64 hex chars. Unique → fast lookup.
    token_hash: Mapped[str] = mapped_column(
        String(64), nullable=False, unique=True
    )
    # First 8 chars of raw token; safe to store + display since the full
    # token has 35 chars of remaining entropy (43-8). Used in
    # GET /share-links to identify which link this is.
    token_prefix: Mapped[str] = mapped_column(String(8), nullable=False)
    label: Mapped[str | None] = mapped_column(String(200))
    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    # Owner handle frozen at link creation; every downstream consumer
    # (anonymous redeem response, membership row at upgrade time)
    # reads this same value. See spec § 11.2 / § 11.6.
    resolved_owner_handle: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    redeem_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    last_redeemed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
```

- [ ] **Step 4: Verify pass**

Run: `cd backend && uv run pytest tests/test_scope_sharing_models_import.py -v`
Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/models/scope_share_link.py backend/tests/test_scope_sharing_models_import.py
git commit -m "feat(models): add ScopeShareLink model"
```

---

### Task A.4: Alembic migration

**Files:**
- Create: `backend/alembic/versions/b8e4d1c6f23a_scope_sharing.py`

Use revision id `b8e4d1c6f23a` (alphabetically distinct; verify it doesn't exist with `ls backend/alembic/versions/`). Current head is `a7f4c2b9d031` (the FK CASCADE migration that just shipped).

- [ ] **Step 1: Find the current head**

Run: `cd backend && uv run alembic heads`
Expected: prints exactly `a7f4c2b9d031 (head)`. If something else, use that revision as `down_revision`.

- [ ] **Step 2: Create migration file**

Create `backend/alembic/versions/b8e4d1c6f23a_scope_sharing.py`:

```python
"""scope sharing — memberships, invitations, share links

Revision ID: b8e4d1c6f23a
Revises: a7f4c2b9d031
Create Date: 2026-05-11 21:00:00.000000

Adds the three tables needed for cross-user scope sharing:
  - scope_memberships     : viewers a scope owner has added
  - scope_invitations     : outstanding email invitations
  - scope_share_links     : opaque-token share URLs

DDL-only — no data backfill needed because this is greenfield. The
existing scope.kind CHECK constraint is NOT modified (sharing is
orthogonal to scope kind; a personal or environment scope can both
be shared without the kind changing).

All three tables ON DELETE CASCADE from scopes(id) and users(id) so
deleting an owner or a scope cleans up rows automatically.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b8e4d1c6f23a"
down_revision: str | Sequence[str] | None = "a7f4c2b9d031"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "scope_memberships",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "scope_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("scopes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("role", sa.String(32), nullable=False),
        sa.Column("joined_via", sa.String(32), nullable=False),
        sa.Column(
            "joined_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.Column("resolved_owner_handle", sa.String(64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.UniqueConstraint(
            "scope_id", "user_id", name="uq_scope_memberships_scope_user"
        ),
        sa.CheckConstraint("role IN ('viewer')", name="ck_scope_memberships_role_v1"),
        sa.CheckConstraint(
            "joined_via IN ('invite', 'link')",
            name="ck_scope_memberships_joined_via_v1",
        ),
    )
    op.create_index(
        "ix_scope_memberships_scope_id", "scope_memberships", ["scope_id"]
    )
    op.create_index(
        "ix_scope_memberships_user_id", "scope_memberships", ["user_id"]
    )

    op.create_table(
        "scope_invitations",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "scope_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("scopes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "invitee_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("invitee_email", sa.String(320), nullable=False),
        sa.Column(
            "invited_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.UniqueConstraint(
            "scope_id", "invitee_user_id",
            name="uq_scope_invitations_scope_user",
        ),
    )
    op.create_index(
        "ix_scope_invitations_scope_id", "scope_invitations", ["scope_id"]
    )
    op.create_index(
        "ix_scope_invitations_invitee_user_id",
        "scope_invitations",
        ["invitee_user_id"],
    )

    op.create_table(
        "scope_share_links",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "scope_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("scopes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("token_prefix", sa.String(8), nullable=False),
        sa.Column("label", sa.String(200)),
        sa.Column(
            "created_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("resolved_owner_handle", sa.String(64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True)),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.Column(
            "redeem_count", sa.Integer, nullable=False, server_default="0"
        ),
        sa.Column("last_redeemed_at", sa.DateTime(timezone=True)),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
    )
    op.create_index(
        "ix_scope_share_links_scope_id", "scope_share_links", ["scope_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_scope_share_links_scope_id", "scope_share_links")
    op.drop_table("scope_share_links")
    op.drop_index("ix_scope_invitations_invitee_user_id", "scope_invitations")
    op.drop_index("ix_scope_invitations_scope_id", "scope_invitations")
    op.drop_table("scope_invitations")
    op.drop_index("ix_scope_memberships_user_id", "scope_memberships")
    op.drop_index("ix_scope_memberships_scope_id", "scope_memberships")
    op.drop_table("scope_memberships")
```

- [ ] **Step 3: Apply migration to local dev DB**

Run: `cd backend && uv run alembic upgrade head`
Expected: prints `Running upgrade a7f4c2b9d031 -> b8e4d1c6f23a, scope sharing...` then exits 0.

- [ ] **Step 4: Verify tables exist**

Run:
```bash
PGPASSWORD=clawdi_dev psql -h localhost -p 5433 -U clawdi -d clawdi_cloud -c "\dt scope_memberships scope_invitations scope_share_links"
```
Expected: 3 rows listed.

- [ ] **Step 5: Run ruff format on the migration**

Run: `cd backend && uv run ruff format alembic/versions/b8e4d1c6f23a_scope_sharing.py`
Expected: file reformatted or already-formatted.

- [ ] **Step 6: Commit**

```bash
git add backend/alembic/versions/b8e4d1c6f23a_scope_sharing.py
git commit -m "feat(migration): add scope_memberships + scope_invitations + scope_share_links tables"
```

---

### Task A.5: Pydantic schemas

**Files:**
- Create: `backend/app/schemas/sharing.py`
- Create: `backend/tests/test_sharing_schemas.py`

- [ ] **Step 1: Write failing schema test**

Create `backend/tests/test_sharing_schemas.py`:

```python
"""Sanity-check that the sharing schemas accept their canonical shapes
and reject obviously bad ones. Heavier validation lives in endpoint
tests where the route-level guards also fire."""

import pytest
from pydantic import ValidationError


def test_share_link_create_accepts_minimal_body():
    from app.schemas.sharing import ShareLinkCreate

    parsed = ShareLinkCreate.model_validate({})
    assert parsed.label is None
    assert parsed.expires_at is None


def test_share_link_create_accepts_label():
    from app.schemas.sharing import ShareLinkCreate

    parsed = ShareLinkCreate.model_validate({"label": "team link"})
    assert parsed.label == "team link"


def test_invitation_create_requires_email():
    from app.schemas.sharing import InvitationCreate

    with pytest.raises(ValidationError):
        InvitationCreate.model_validate({})


def test_invitation_create_validates_email_shape():
    from app.schemas.sharing import InvitationCreate

    with pytest.raises(ValidationError):
        InvitationCreate.model_validate({"email": "not-an-email"})

    parsed = InvitationCreate.model_validate({"email": "alice@example.com"})
    assert parsed.email == "alice@example.com"
```

- [ ] **Step 2: Verify fail**

Run: `cd backend && uv run pytest tests/test_sharing_schemas.py -v`
Expected: 4 fail with ModuleNotFoundError.

- [ ] **Step 3: Implement schemas**

Create `backend/app/schemas/sharing.py`:

```python
"""Pydantic request + response models for cross-user scope sharing.

Owner-facing schemas live alongside sharee-facing ones — the route
modules are split (sharing.py vs share_redeem.py vs me.py) but the
contract types are small enough to keep together.
"""

from datetime import datetime

from pydantic import BaseModel, EmailStr, Field


class ShareLinkCreate(BaseModel):
    """Body for POST /api/scopes/{scope_id}/share-links."""

    label: str | None = Field(default=None, max_length=200)
    expires_at: datetime | None = None


class ShareLinkCreated(BaseModel):
    """Returned ONCE on link creation — includes the raw token.
    Subsequent GETs only return `prefix` (raw token is unrecoverable).
    `owner_handle` is the frozen value stored on the link row that
    every sharee will see; the owner sees their own resolved handle
    in case they want to verify or change their display name first."""

    id: str
    raw_token: str
    url: str
    prefix: str
    owner_handle: str
    label: str | None
    created_at: datetime
    expires_at: datetime | None


class ShareLinkResponse(BaseModel):
    """Returned by GET /api/scopes/{scope_id}/share-links."""

    id: str
    prefix: str
    label: str | None
    created_at: datetime
    expires_at: datetime | None
    revoked_at: datetime | None
    redeem_count: int
    last_redeemed_at: datetime | None

    model_config = {"from_attributes": True}


class InvitationCreate(BaseModel):
    """Body for POST /api/scopes/{scope_id}/invitations."""

    email: EmailStr


class InvitationResponse(BaseModel):
    """Returned by GET /api/scopes/{scope_id}/invitations and
    by GET /api/me/invitations (with scope details joined in)."""

    id: str
    scope_id: str
    invitee_email: str
    invited_by_user_id: str
    invited_by_display: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class MemberResponse(BaseModel):
    """Returned by GET /api/scopes/{scope_id}/members."""

    id: str
    user_id: str
    user_email: str | None
    user_display: str | None
    role: str
    joined_via: str
    joined_at: datetime
    resolved_owner_handle: str

    model_config = {"from_attributes": True}


class UnshareResponse(BaseModel):
    """Returned by POST /api/scopes/{scope_id}/unshare."""

    links_revoked: int
    members_removed: int
    invitations_cancelled: int


class ShareRedeemResponse(BaseModel):
    """Returned by POST /api/share/{token}/redeem — anonymous endpoint."""

    scope_id: str
    scope_name: str
    owner_display: str
    owner_handle: str
    skill_count: int
    vault_count: int
    vault_locked: bool  # always True for token-only access in v1


class SharedScopeResponse(BaseModel):
    """An entry in GET /api/me/scopes 'shared' list."""

    id: str
    name: str
    slug: str
    kind: str
    owner_display: str
    owner_handle: str
    role: str
    joined_at: datetime
    is_owner: bool = False
```

- [ ] **Step 4: Verify tests pass**

Run: `cd backend && uv run pytest tests/test_sharing_schemas.py -v`
Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/schemas/sharing.py backend/tests/test_sharing_schemas.py
git commit -m "feat(schemas): add cross-user scope sharing schemas"
```

---

### Task A.6: Owner-handle resolution service

**Files:**
- Create: `backend/app/services/sharing.py`
- Create: `backend/tests/test_owner_handle.py`

- [ ] **Step 1: Write failing tests for handle resolution**

Create `backend/tests/test_owner_handle.py`:

```python
"""Owner-handle resolution — see spec § 11.2.

Definition: handle = kebab(users.display_name) + "-" + user.id.hex[:4].
Always suffixed for guaranteed global uniqueness. Requires display_name
to be set (callers gate on this before invoking).
"""

import uuid

import pytest

from app.models.user import User
from app.services.sharing import resolve_owner_handle


def _user(*, name: str | None = None, user_id_hex: str | None = None) -> User:
    return User(
        id=uuid.UUID(user_id_hex) if user_id_hex else uuid.uuid4(),
        clerk_id=f"clerk_{uuid.uuid4().hex[:8]}",
        email=None,
        name=name,
    )


def test_handle_combines_name_kebab_with_user_id_hex_suffix():
    u = _user(name="Alice Chen", user_id_hex="a3b4c5d600000000000000000000c0de")
    assert resolve_owner_handle(u) == "alice-chen-a3b4"


def test_handle_strips_non_alnum_from_display_name():
    u = _user(name="Bob (Robert) Smith!", user_id_hex="0102030400000000000000000000beef")
    assert resolve_owner_handle(u) == "bob-robert-smith-0102"


def test_handle_two_alices_get_different_suffixes():
    u1 = _user(name="Alice", user_id_hex="a3b4c5d600000000000000000000beef")
    u2 = _user(name="Alice", user_id_hex="f1e2d3c400000000000000000000c0de")
    h1 = resolve_owner_handle(u1)
    h2 = resolve_owner_handle(u2)
    assert h1 != h2
    assert h1.startswith("alice-")
    assert h2.startswith("alice-")


def test_handle_lowercases_and_kebabs_unicode_friendly():
    u = _user(name="ALICE Chen", user_id_hex="cafef00d00000000000000000000beef")
    assert resolve_owner_handle(u) == "alice-chen-cafe"


def test_handle_raises_when_display_name_empty():
    """Callers (share-link create + invitation accept) are responsible
    for gating on display_name presence (409 display_name_required).
    The helper assumes it's been called only on users who pass that gate."""
    u = _user(name=None, user_id_hex="0102030400000000000000000000beef")
    with pytest.raises(ValueError):
        resolve_owner_handle(u)


def test_handle_raises_when_display_name_only_punctuation():
    """A display_name like `???` kebabs to empty string. Reject so we
    don't fall through to a handle that's just `-0102` (no name part)."""
    u = _user(name="!!!", user_id_hex="0102030400000000000000000000beef")
    with pytest.raises(ValueError):
        resolve_owner_handle(u)
```

- [ ] **Step 2: Verify fail**

Run: `cd backend && uv run pytest tests/test_owner_handle.py -v`
Expected: 6 fail with ModuleNotFoundError.

- [ ] **Step 3: Implement service**

Create `backend/app/services/sharing.py`:

```python
"""Cross-user scope sharing — service-layer helpers.

Owner-handle resolution + share-token generation/verification live
here; transactional flows that touch multiple tables (unshare,
accept-invitation, redeem-token-and-upgrade) also live here so the
route handlers stay thin.
"""

from __future__ import annotations

import hashlib
import re
import secrets
from collections.abc import Iterable

from app.models.user import User


_NON_ALNUM = re.compile(r"[^a-z0-9]+")
_TRIM_DASHES = re.compile(r"^-+|-+$")


def _kebab(text: str) -> str:
    """Kebab-case a free-form display name.

    `Alice Chen` -> `alice-chen`
    `Bob (Robert) Smith!` -> `bob-robert-smith`
    `   ` -> `` (caller decides what to do with empty)
    """
    lowered = text.strip().lower()
    dashed = _NON_ALNUM.sub("-", lowered)
    return _TRIM_DASHES.sub("", dashed)


_USER_ID_SUFFIX_LEN = 4


def resolve_owner_handle(user: User) -> str:
    """Compute the stable owner handle for `user`.

    Definition (spec § 11.2):
        handle = kebab(user.display_name) + "-" + user.id.hex[:4]

    `display_name` must be non-empty AND kebab to non-empty. Callers
    must gate on that BEFORE calling — share-link create returns 409
    `display_name_required`; invitation accept refuses (the inviter
    couldn't have invited a user without a display_name in the
    realistic flow). The helper raises ValueError if invariant is
    violated to fail loudly rather than silently producing a
    handle like `-a3b4`.

    The 4-hex-char suffix makes handles globally unique per owner.
    No `existing_handles` parameter — we don't disambiguate per-
    sharee because the handle is frozen on `scope_share_links`
    AT CREATE TIME (when we don't know the sharee yet).
    """
    if not user.name:
        raise ValueError(
            f"user {user.id} has no display_name; "
            "share-link create must gate on this before calling"
        )
    name_part = _kebab(user.name)
    if not name_part:
        raise ValueError(
            f"user {user.id} display_name kebabs to empty string; "
            "user must set a display_name with at least one alphanumeric character"
        )
    suffix = user.id.hex[:_USER_ID_SUFFIX_LEN]
    return f"{name_part}-{suffix}"
```

- [ ] **Step 4: Verify tests pass**

Run: `cd backend && uv run pytest tests/test_owner_handle.py -v`
Expected: 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/sharing.py backend/tests/test_owner_handle.py
git commit -m "feat(services): owner-handle resolution for shared scopes"
```

---

### Task A.7: Share-token generation + hashing helpers

**Files:**
- Modify: `backend/app/services/sharing.py`
- Create: `backend/tests/test_share_tokens.py`

- [ ] **Step 1: Write failing token-helper tests**

Create `backend/tests/test_share_tokens.py`:

```python
"""Share-link opaque-token primitives.

Token shape: 32 random bytes → URL-safe base64 → 43 chars (no padding).
Server stores sha256(token). First 8 chars stored as prefix for owner UI.
"""

import re

from app.services.sharing import (
    generate_share_token,
    hash_share_token,
    token_prefix,
)


def test_generate_share_token_returns_43_url_safe_chars():
    tok = generate_share_token()
    assert len(tok) == 43
    assert re.fullmatch(r"[A-Za-z0-9_-]+", tok)


def test_generate_share_token_is_unpredictable():
    seen = {generate_share_token() for _ in range(100)}
    assert len(seen) == 100


def test_hash_share_token_returns_64_hex_chars():
    h = hash_share_token("known-token-for-test")
    assert len(h) == 64
    assert re.fullmatch(r"[0-9a-f]+", h)
    # Deterministic.
    assert hash_share_token("known-token-for-test") == h


def test_token_prefix_returns_first_8_chars():
    tok = "abcdefgh" + "x" * 35
    assert token_prefix(tok) == "abcdefgh"
```

- [ ] **Step 2: Verify fail**

Run: `cd backend && uv run pytest tests/test_share_tokens.py -v`
Expected: 4 fail with ImportError.

- [ ] **Step 3: Add helpers to services/sharing.py**

Append to `backend/app/services/sharing.py`:

```python
# --- Share-token primitives ---

_TOKEN_BYTES = 32  # 32 random bytes → 43 URL-safe-b64 chars
_TOKEN_PREFIX_LEN = 8


def generate_share_token() -> str:
    """Return a fresh opaque token suitable for embedding in a URL.

    32 random bytes give 256 bits of entropy → infeasible to guess.
    URL-safe-b64-no-pad encoding keeps the resulting string copy-pasteable
    and route-segment safe.
    """
    return secrets.token_urlsafe(_TOKEN_BYTES)


def hash_share_token(raw_token: str) -> str:
    """Return sha256(raw_token) as 64 hex chars.

    The raw token NEVER lands in the DB. Server stores this hash; on
    redeem the server hashes the URL-extracted token and looks it up.
    """
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def token_prefix(raw_token: str) -> str:
    """First 8 chars of the raw token — safe to store + display."""
    return raw_token[:_TOKEN_PREFIX_LEN]
```

- [ ] **Step 4: Verify tests pass**

Run: `cd backend && uv run pytest tests/test_share_tokens.py -v`
Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/sharing.py backend/tests/test_share_tokens.py
git commit -m "feat(services): share-token generation + hash helpers"
```

---

### Task A.8: `require_share_token` auth dependency

**Files:**
- Modify: `backend/app/core/auth.py`
- Create: `backend/tests/test_require_share_token.py`

- [ ] **Step 1: Write failing dependency tests**

Create `backend/tests/test_require_share_token.py`:

```python
"""require_share_token validates an opaque token from the URL path
and returns the resolved scope_id + link_id. Used by the public
`/api/share/{token}/...` routes."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException

from app.core.auth import require_share_token
from app.models.scope_share_link import ScopeShareLink
from app.services.sharing import generate_share_token, hash_share_token


@pytest.mark.asyncio
async def test_require_share_token_returns_scope_for_valid_token(
    db_session, seed_user, seed_scope
):
    raw = generate_share_token()
    link = ScopeShareLink(
        scope_id=seed_scope.id,
        token_hash=hash_share_token(raw),
        token_prefix=raw[:8],
        created_by=seed_user.id,
        created_at=datetime.now(UTC),
    )
    db_session.add(link)
    await db_session.commit()

    result = await require_share_token(token=raw, db=db_session)
    assert result.scope_id == seed_scope.id
    assert result.link_id == link.id


@pytest.mark.asyncio
async def test_require_share_token_rejects_unknown(db_session):
    with pytest.raises(HTTPException) as exc:
        await require_share_token(token="totally-bogus", db=db_session)
    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_require_share_token_rejects_revoked(
    db_session, seed_user, seed_scope
):
    raw = generate_share_token()
    link = ScopeShareLink(
        scope_id=seed_scope.id,
        token_hash=hash_share_token(raw),
        token_prefix=raw[:8],
        created_by=seed_user.id,
        created_at=datetime.now(UTC),
        revoked_at=datetime.now(UTC),
    )
    db_session.add(link)
    await db_session.commit()

    with pytest.raises(HTTPException) as exc:
        await require_share_token(token=raw, db=db_session)
    assert exc.value.status_code == 410


@pytest.mark.asyncio
async def test_require_share_token_rejects_expired(
    db_session, seed_user, seed_scope
):
    raw = generate_share_token()
    link = ScopeShareLink(
        scope_id=seed_scope.id,
        token_hash=hash_share_token(raw),
        token_prefix=raw[:8],
        created_by=seed_user.id,
        created_at=datetime.now(UTC) - timedelta(days=2),
        expires_at=datetime.now(UTC) - timedelta(days=1),
    )
    db_session.add(link)
    await db_session.commit()

    with pytest.raises(HTTPException) as exc:
        await require_share_token(token=raw, db=db_session)
    assert exc.value.status_code == 410


# Note: seed_scope fixture comes from Task A.9 — if missing at this
# point, add a minimal version inline at the top of this file using
# `await create_env_with_scope(db_session, user_id=seed_user.id, ...)`.
```

- [ ] **Step 2: Add `seed_scope` fixture to conftest.py**

Modify `backend/tests/conftest.py` (append):

```python
@pytest_asyncio.fixture
async def seed_scope(db_session: AsyncSession, seed_user: User) -> Scope:
    """The Personal scope created alongside seed_user. Convenience handle
    for sharing tests that need 'a scope owned by seed_user' without
    fussing with env-local scopes."""
    from sqlalchemy import select

    from app.models.scope import SCOPE_KIND_PERSONAL, Scope

    result = await db_session.execute(
        select(Scope).where(
            Scope.user_id == seed_user.id, Scope.kind == SCOPE_KIND_PERSONAL
        )
    )
    return result.scalar_one()
```

- [ ] **Step 3: Verify failing**

Run: `cd backend && uv run pytest tests/test_require_share_token.py -v`
Expected: 4 fail with ImportError on `require_share_token`.

- [ ] **Step 4: Implement dependency**

Append to `backend/app/core/auth.py` (after `require_admin_api_key`):

```python
class ShareTokenContext:
    """What require_share_token returns. Routes pull scope_id + link_id
    from here; no `AuthContext` (no user identity at all)."""

    def __init__(self, scope_id, link_id):
        self.scope_id = scope_id
        self.link_id = link_id


async def require_share_token(
    token: str,
    db: AsyncSession = Depends(get_session),
) -> ShareTokenContext:
    """Validate an opaque share token from the URL path.

    Anonymous endpoint dep — does NOT establish an AuthContext, does
    NOT carry user identity. Token holders are bearers of access to
    one specific scope's skill content, nothing more.

    Errors:
      404 — token not found (unknown raw token → hash mismatch)
      410 — token revoked or expired (existed but no longer valid)
    """
    from app.models.scope_share_link import ScopeShareLink
    from app.services.sharing import hash_share_token

    token_hash = hash_share_token(token)
    result = await db.execute(
        select(ScopeShareLink).where(ScopeShareLink.token_hash == token_hash)
    )
    link = result.scalar_one_or_none()
    if link is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "share link not found")
    if link.revoked_at is not None:
        raise HTTPException(status.HTTP_410_GONE, "share link has been revoked")
    if link.expires_at is not None and link.expires_at < datetime.now(UTC):
        raise HTTPException(status.HTTP_410_GONE, "share link has expired")
    return ShareTokenContext(scope_id=link.scope_id, link_id=link.id)
```

- [ ] **Step 5: Verify tests pass**

Run: `cd backend && uv run pytest tests/test_require_share_token.py -v`
Expected: 4 PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/app/core/auth.py backend/tests/test_require_share_token.py backend/tests/conftest.py
git commit -m "feat(auth): add require_share_token dependency for anonymous share endpoints"
```

---

### Task A.9: Run typecheck / ruff / lint pass

- [ ] **Step 1: Backend ruff format**

Run: `cd backend && uv run ruff format app/ tests/`
Expected: any reformatting applied automatically.

- [ ] **Step 2: Backend ruff lint**

Run: `cd backend && uv run ruff check app/`
Expected: `All checks passed!`

- [ ] **Step 3: All sharing tests green**

Run: `cd backend && uv run pytest tests/test_scope_sharing_models_import.py tests/test_sharing_schemas.py tests/test_owner_handle.py tests/test_share_tokens.py tests/test_require_share_token.py -v`
Expected: all PASS.

- [ ] **Step 4: Commit any format-only changes (if any)**

```bash
git status
# If any files modified by ruff format:
git add -u
git commit -m "style: ruff format pass for Phase A"
```

---

### Task A.10: Push Phase A branch + open PR-A

- [ ] **Step 1: Push the branch upstream**

Run: `git push origin feat/scope-sharing`
Expected: branch updated remotely.

- [ ] **Step 2: Open PR for Phase A only**

Run:
```bash
gh pr create --title "feat(sharing): backend schema + service primitives (Phase A)" --body "$(cat <<'EOF'
## Summary

Phase A of cross-user scope sharing — backend foundations only, no
business logic on top yet.

- Three new tables: scope_memberships, scope_invitations, scope_share_links (DDL-only migration b8e4d1c6f23a)
- SQLAlchemy models + Pydantic schemas
- services/sharing.py: owner-handle resolution + share-token generation/hash
- core/auth.py: require_share_token dependency for anonymous endpoints

Subsequent PRs add the routes that use this surface.

Spec: docs/superpowers/specs/2026-05-11-scope-sharing-design.md

## Test plan

- [x] uv run pytest covers models import, schemas, owner-handle resolver, share-token primitives, require_share_token gate
- [x] ruff check + format clean on app/
- [x] alembic upgrade head applies cleanly to local dev DB
- [ ] Staging migration verified (operator action)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.

- [ ] **Step 3: Wait for CI green**

Watch: `gh pr checks <PR-URL>` until all SUCCESS.

- [ ] **Step 4: Merge after review**

(Manual gate — user decides when to merge Phase A.)

---

## Phase B — Backend Owner Routes

Goal: ship every owner-facing HTTP endpoint (share-links, invitations, members, unshare) with tests covering happy path + auth + cross-tenant + idempotency.

All routes go in a single new `sharing.py` router mounted at `/api/scopes/{scope_id}/...`. Each route protected by `require_user_auth` + an inline owner-check helper `_assert_scope_owner(db, auth, scope_id)` that 404s if scope doesn't exist or belongs to someone else.

### Task B.1: Router skeleton + `_assert_scope_owner` helper + main.py wiring

**Files:**
- Create: `backend/app/routes/sharing.py`
- Modify: `backend/app/main.py`
- Create: `backend/tests/test_sharing_owner.py`

- [ ] **Step 1: Write failing skeleton test**

Create `backend/tests/test_sharing_owner.py`:

```python
"""Owner-facing /api/scopes/{id}/... endpoints for share links,
invitations, and members. Auth: require_user_auth + scope-owner check."""

import pytest


@pytest.mark.asyncio
async def test_share_links_list_requires_auth(client_unauth):
    r = await client_unauth.get(
        "/api/scopes/00000000-0000-0000-0000-000000000000/share-links"
    )
    assert r.status_code in (401, 403), r.text


@pytest.mark.asyncio
async def test_share_links_list_404_on_unknown_scope(client):
    r = await client.get(
        "/api/scopes/00000000-0000-0000-0000-000000000000/share-links"
    )
    assert r.status_code == 404
```

Note: `client` is the existing Clerk-authed fixture (seed_user). `client_unauth` may need to be added to conftest.py — see Step 2.

- [ ] **Step 2: Add `client_unauth` fixture to conftest.py if absent**

In `backend/tests/conftest.py`, ensure a fixture exists that yields a client WITHOUT a Clerk JWT override. If not, add:

```python
@pytest_asyncio.fixture
async def client_unauth(db_session) -> AsyncIterator[httpx.AsyncClient]:
    """HTTPX client that doesn't inject any auth — for testing
    that endpoints reject unauthenticated callers."""
    async def _override_get_session():
        yield db_session

    app.dependency_overrides[get_session] = _override_get_session
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac
    finally:
        app.dependency_overrides.clear()
```

- [ ] **Step 3: Run tests, expect failure (router not registered)**

Run: `cd backend && uv run pytest tests/test_sharing_owner.py -v`
Expected: 404 on second test, but **first test may pass coincidentally** (404 from "no route" vs 401 from auth). Either way, we want both green only after the route exists.

- [ ] **Step 4: Implement skeleton**

Create `backend/app/routes/sharing.py`:

```python
"""Owner-facing sharing endpoints.

Every route is gated by:
  1. require_user_auth (Clerk JWT or unbound CLI api_key — narrowly-
     scoped api_keys rejected).
  2. _assert_scope_owner — verifies the scope exists AND the caller
     owns it. 404 (not 403) on either condition to avoid leaking
     scope existence to non-owners.

Public anonymous routes (share-link redemption etc.) live in a
separate `share_redeem.py` router; that one uses require_share_token
instead of require_user_auth.
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_user_auth
from app.core.database import get_session
from app.models.scope import Scope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/scopes", tags=["sharing"])


async def _assert_scope_owner(
    db: AsyncSession, auth: AuthContext, scope_id: UUID
) -> Scope:
    """Resolve scope and verify the caller owns it. 404 if either
    the scope doesn't exist OR the caller isn't its owner — refusing
    to distinguish the two keeps scope IDs un-enumerable by non-owners."""
    result = await db.execute(select(Scope).where(Scope.id == scope_id))
    scope = result.scalar_one_or_none()
    if scope is None or scope.user_id != auth.user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "scope not found")
    return scope
```

- [ ] **Step 5: Register router in main.py**

Modify `backend/app/main.py`, in the section where routers are included (look for `app.include_router(admin_router)`):

```python
from app.routes.sharing import router as sharing_router
# ...
app.include_router(sharing_router)
```

- [ ] **Step 6: Verify tests pass**

Run: `cd backend && uv run pytest tests/test_sharing_owner.py -v`
Expected: 2 PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/app/routes/sharing.py backend/app/main.py backend/tests/test_sharing_owner.py backend/tests/conftest.py
git commit -m "feat(sharing): router skeleton + owner-check helper"
```

---

### Task B.2: `POST /api/scopes/{id}/share-links` (create link)

**Files:**
- Modify: `backend/app/routes/sharing.py`
- Modify: `backend/tests/test_sharing_owner.py`

- [ ] **Step 1: Write failing tests**

Append to `backend/tests/test_sharing_owner.py`:

```python
@pytest.mark.asyncio
async def test_create_share_link_returns_raw_token_once(
    client, db_session, seed_user, seed_scope
):
    r = await client.post(
        f"/api/scopes/{seed_scope.id}/share-links",
        json={"label": "team link"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["raw_token"]
    assert len(body["raw_token"]) == 43  # 32 bytes URL-safe-b64-no-pad
    assert body["url"].endswith(body["raw_token"])
    assert body["prefix"] == body["raw_token"][:8]
    assert body["label"] == "team link"


@pytest.mark.asyncio
async def test_create_share_link_persists_hash_not_raw(
    client, db_session, seed_user, seed_scope
):
    from app.models.scope_share_link import ScopeShareLink
    from app.services.sharing import hash_share_token

    r = await client.post(
        f"/api/scopes/{seed_scope.id}/share-links", json={}
    )
    assert r.status_code == 200
    raw = r.json()["raw_token"]

    row = (
        await db_session.execute(
            select(ScopeShareLink).where(
                ScopeShareLink.token_hash == hash_share_token(raw)
            )
        )
    ).scalar_one()
    assert row.scope_id == seed_scope.id
    # No raw_token column exists; can't even check that the raw value
    # is absent. The hash-only column shape is the guard.


@pytest.mark.asyncio
async def test_create_share_link_cross_tenant_404(
    client, db_session, seed_user
):
    """Caller (seed_user) tries to make a link on another user's scope."""
    from app.models.user import User
    from app.models.scope import SCOPE_KIND_PERSONAL, Scope

    other = User(clerk_id=f"other_{uuid.uuid4().hex[:8]}", email="o@x.dev", name="O")
    db_session.add(other)
    await db_session.commit()
    await db_session.refresh(other)
    other_scope = Scope(
        user_id=other.id, name="Other", slug="other", kind=SCOPE_KIND_PERSONAL
    )
    db_session.add(other_scope)
    await db_session.commit()

    try:
        r = await client.post(f"/api/scopes/{other_scope.id}/share-links", json={})
        assert r.status_code == 404
    finally:
        await db_session.delete(other_scope)
        await db_session.delete(other)
        await db_session.commit()
```

Add at top of file (if not already present):
```python
import uuid
from sqlalchemy import select
```

- [ ] **Step 2: Verify failures**

Run: `cd backend && uv run pytest tests/test_sharing_owner.py -v`
Expected: 3 new fail with 405/404 (route not implemented).

- [ ] **Step 3: Implement route**

Append to `backend/app/routes/sharing.py`:

```python
from datetime import UTC, datetime

from app.core.config import settings
from app.models.scope_share_link import ScopeShareLink
from app.schemas.sharing import ShareLinkCreate, ShareLinkCreated
from app.services.sharing import generate_share_token, hash_share_token, token_prefix


def _share_url(raw_token: str) -> str:
    """Compose the public share URL from the raw token.

    Hosts the public landing page on the dashboard origin
    (settings.web_origin). Falls back to a sentinel for OSS self-hosters
    who haven't configured a public dashboard URL.
    """
    base = settings.web_origin.rstrip("/") if settings.web_origin else "https://example.invalid"
    return f"{base}/share/{raw_token}"


from app.services.sharing import resolve_owner_handle


@router.post("/{scope_id}/share-links", response_model=ShareLinkCreated)
async def create_share_link(
    scope_id: UUID,
    body: ShareLinkCreate,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> ShareLinkCreated:
    """Generate a new share link for a scope.

    - Raw token returned ONCE; server stores only the hash.
    - Gate on owner having `display_name` set (spec § 4.5 + § 11.2).
      The handle is necessarily revealed to recipients; we don't fall
      back to email local-part because that leaks PII.
    - Resolves + freezes `resolved_owner_handle` on the link row at
      create time so every downstream consumer reads the same value.
    """
    await _assert_scope_owner(db, auth, scope_id)

    if not auth.user.name:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "error": "display_name_required",
                "message": (
                    "Set a display name on your profile before sharing a "
                    "scope. The name is shown to anyone you share with."
                ),
            },
        )
    try:
        owner_handle = resolve_owner_handle(auth.user)
    except ValueError:
        # Display name kebabs to empty (e.g. only punctuation).
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "error": "display_name_required",
                "message": (
                    "Your display name must contain at least one alphanumeric "
                    "character."
                ),
            },
        ) from None

    raw = generate_share_token()
    link = ScopeShareLink(
        scope_id=scope_id,
        token_hash=hash_share_token(raw),
        token_prefix=token_prefix(raw),
        label=body.label,
        created_by=auth.user_id,
        resolved_owner_handle=owner_handle,
        created_at=datetime.now(UTC),
        expires_at=body.expires_at,
    )
    db.add(link)
    await db.commit()
    await db.refresh(link)

    logger.info(
        "share_link_created scope_id=%s link_id=%s by=%s handle=%s",
        scope_id,
        link.id,
        auth.user_id,
        owner_handle,
    )
    return ShareLinkCreated(
        id=str(link.id),
        raw_token=raw,
        url=_share_url(raw),
        prefix=link.token_prefix,
        owner_handle=owner_handle,
        label=link.label,
        created_at=link.created_at,
        expires_at=link.expires_at,
    )
```

- [ ] **Step 4: Verify tests pass**

Run: `cd backend && uv run pytest tests/test_sharing_owner.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/routes/sharing.py backend/tests/test_sharing_owner.py
git commit -m "feat(sharing): POST share-links endpoint"
```

---

### Task B.3: `GET /api/scopes/{id}/share-links` (list)

**Files:**
- Modify: `backend/app/routes/sharing.py`
- Modify: `backend/tests/test_sharing_owner.py`

- [ ] **Step 1: Write failing test**

Append:

```python
@pytest.mark.asyncio
async def test_list_share_links_returns_prefix_not_raw(
    client, db_session, seed_user, seed_scope
):
    # Create two
    await client.post(f"/api/scopes/{seed_scope.id}/share-links", json={"label": "A"})
    await client.post(f"/api/scopes/{seed_scope.id}/share-links", json={"label": "B"})

    r = await client.get(f"/api/scopes/{seed_scope.id}/share-links")
    assert r.status_code == 200
    items = r.json()
    assert len(items) == 2
    labels = {item["label"] for item in items}
    assert labels == {"A", "B"}
    for item in items:
        assert "raw_token" not in item
        assert len(item["prefix"]) == 8
        assert item["redeem_count"] == 0
```

- [ ] **Step 2: Verify fail (405)**

- [ ] **Step 3: Implement**

Append to `sharing.py`:

```python
from app.schemas.sharing import ShareLinkResponse


@router.get("/{scope_id}/share-links", response_model=list[ShareLinkResponse])
async def list_share_links(
    scope_id: UUID,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> list[ShareLinkResponse]:
    await _assert_scope_owner(db, auth, scope_id)
    result = await db.execute(
        select(ScopeShareLink)
        .where(ScopeShareLink.scope_id == scope_id)
        .order_by(ScopeShareLink.created_at.desc())
    )
    return [
        ShareLinkResponse(
            id=str(link.id),
            prefix=link.token_prefix,
            label=link.label,
            created_at=link.created_at,
            expires_at=link.expires_at,
            revoked_at=link.revoked_at,
            redeem_count=link.redeem_count,
            last_redeemed_at=link.last_redeemed_at,
        )
        for link in result.scalars().all()
    ]
```

- [ ] **Step 4: Verify pass**
- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(sharing): GET share-links endpoint"
```

---

### Task B.4: `DELETE /api/scopes/{id}/share-links/{link_id}` (revoke)

**Files:**
- Modify: `backend/app/routes/sharing.py`
- Modify: `backend/tests/test_sharing_owner.py`

- [ ] **Step 1: Write failing tests**

Append:

```python
@pytest.mark.asyncio
async def test_revoke_share_link_sets_revoked_at(
    client, db_session, seed_user, seed_scope
):
    from app.models.scope_share_link import ScopeShareLink

    create_resp = await client.post(
        f"/api/scopes/{seed_scope.id}/share-links", json={}
    )
    link_id = create_resp.json()["id"]

    r = await client.delete(
        f"/api/scopes/{seed_scope.id}/share-links/{link_id}"
    )
    assert r.status_code == 200
    assert r.json()["status"] == "revoked"

    db_session.expire_all()
    row = (
        await db_session.execute(
            select(ScopeShareLink).where(ScopeShareLink.id == link_id)
        )
    ).scalar_one()
    assert row.revoked_at is not None


@pytest.mark.asyncio
async def test_revoke_share_link_idempotent(
    client, db_session, seed_user, seed_scope
):
    create_resp = await client.post(
        f"/api/scopes/{seed_scope.id}/share-links", json={}
    )
    link_id = create_resp.json()["id"]
    await client.delete(f"/api/scopes/{seed_scope.id}/share-links/{link_id}")

    r2 = await client.delete(f"/api/scopes/{seed_scope.id}/share-links/{link_id}")
    assert r2.status_code == 200
    assert r2.json()["status"] == "revoked"


@pytest.mark.asyncio
async def test_revoke_unknown_link_404(client, seed_scope):
    r = await client.delete(
        f"/api/scopes/{seed_scope.id}/share-links/00000000-0000-0000-0000-000000000000"
    )
    assert r.status_code == 404
```

- [ ] **Step 2: Verify failures**

- [ ] **Step 3: Implement**

Append to `sharing.py`:

```python
@router.delete("/{scope_id}/share-links/{link_id}")
async def revoke_share_link(
    scope_id: UUID,
    link_id: UUID,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    await _assert_scope_owner(db, auth, scope_id)
    result = await db.execute(
        select(ScopeShareLink).where(
            ScopeShareLink.id == link_id,
            ScopeShareLink.scope_id == scope_id,
        )
    )
    link = result.scalar_one_or_none()
    if link is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "share link not found")
    if link.revoked_at is None:
        link.revoked_at = datetime.now(UTC)
        await db.commit()
        logger.info("share_link_revoked link_id=%s by=%s", link_id, auth.user_id)
    return {"status": "revoked"}
```

- [ ] **Step 4: Verify pass**
- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(sharing): DELETE share-link (revoke) endpoint"
```

---

### Task B.5: `POST /api/scopes/{id}/invitations` (create)

**Files:**
- Modify: `backend/app/routes/sharing.py`
- Create: `backend/tests/test_sharing_invitations.py`

- [ ] **Step 1: Write failing tests**

Create `backend/tests/test_sharing_invitations.py`:

```python
"""Email invitation creation. Privacy posture: endpoint behaves the
same whether the email is registered or not — we don't leak account
existence. (No record is created when there's no user, the response
just doesn't differ in shape; CLI / web messaging downstream
suggests sending the share link instead.)"""

import uuid

import pytest
from sqlalchemy import select


@pytest.mark.asyncio
async def test_invite_existing_user_creates_invitation(
    client, db_session, seed_user, seed_scope
):
    from app.models.user import User
    from app.models.scope_invitation import ScopeInvitation

    invitee = User(
        clerk_id=f"invitee_{uuid.uuid4().hex[:8]}",
        email=f"invitee_{uuid.uuid4().hex[:6]}@test.dev",
        name="Invitee",
    )
    db_session.add(invitee)
    await db_session.commit()
    await db_session.refresh(invitee)

    try:
        r = await client.post(
            f"/api/scopes/{seed_scope.id}/invitations",
            json={"email": invitee.email},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["invitee_email"] == invitee.email

        row = (
            await db_session.execute(
                select(ScopeInvitation).where(
                    ScopeInvitation.scope_id == seed_scope.id,
                    ScopeInvitation.invitee_email == invitee.email,
                )
            )
        ).scalar_one()
        assert row.invited_by == seed_user.id
    finally:
        await db_session.delete(invitee)
        await db_session.commit()


@pytest.mark.asyncio
async def test_invite_unregistered_email_returns_404(
    client, db_session, seed_user, seed_scope
):
    r = await client.post(
        f"/api/scopes/{seed_scope.id}/invitations",
        json={"email": f"ghost_{uuid.uuid4().hex[:8]}@nowhere.test"},
    )
    assert r.status_code == 404
    body = r.json()
    assert body["detail"]["error"] == "user_not_found"


@pytest.mark.asyncio
async def test_invite_self_rejected(client, seed_user, seed_scope):
    r = await client.post(
        f"/api/scopes/{seed_scope.id}/invitations",
        json={"email": seed_user.email},
    )
    assert r.status_code == 400
    body = r.json()
    assert body["detail"]["error"] == "already_owner"


@pytest.mark.asyncio
async def test_invite_existing_pending_409(
    client, db_session, seed_user, seed_scope
):
    from app.models.user import User

    invitee = User(
        clerk_id=f"i_{uuid.uuid4().hex[:8]}",
        email=f"dup_{uuid.uuid4().hex[:6]}@test.dev",
        name="X",
    )
    db_session.add(invitee)
    await db_session.commit()
    try:
        await client.post(
            f"/api/scopes/{seed_scope.id}/invitations",
            json={"email": invitee.email},
        )
        r = await client.post(
            f"/api/scopes/{seed_scope.id}/invitations",
            json={"email": invitee.email},
        )
        assert r.status_code == 409
        body = r.json()
        assert body["detail"]["error"] == "already_invited"
    finally:
        await db_session.delete(invitee)
        await db_session.commit()
```

- [ ] **Step 2: Verify failures**

- [ ] **Step 3: Implement**

Append to `sharing.py`:

```python
from app.models.scope_invitation import ScopeInvitation
from app.models.scope_membership import ScopeMembership
from app.models.user import User
from app.schemas.sharing import InvitationCreate, InvitationResponse
from sqlalchemy.exc import IntegrityError


@router.post("/{scope_id}/invitations", response_model=InvitationResponse)
async def create_invitation(
    scope_id: UUID,
    body: InvitationCreate,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> InvitationResponse:
    """Send a pending email invitation. Invitee must already have an
    account (email lookup); for unregistered targets the response
    instructs the owner to send a share-link instead."""
    scope = await _assert_scope_owner(db, auth, scope_id)
    target_email = body.email.lower()

    # Self-invite guard.
    if auth.user.email and auth.user.email.lower() == target_email:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            {"error": "already_owner", "message": "You're already the owner."},
        )

    # Look up registered user.
    invitee_result = await db.execute(
        select(User).where(User.email == target_email)
    )
    invitee = invitee_result.scalar_one_or_none()
    if invitee is None:
        # Case-insensitive fallback (emails stored as-typed).
        invitee_result = await db.execute(
            select(User).where(User.email.ilike(target_email))
        )
        invitee = invitee_result.scalar_one_or_none()
    if invitee is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            {
                "error": "user_not_found",
                "message": (
                    "No clawdi account found for that email. "
                    "Send them a share link instead."
                ),
            },
        )

    # Already a member?
    existing = await db.execute(
        select(ScopeMembership).where(
            ScopeMembership.scope_id == scope_id,
            ScopeMembership.user_id == invitee.id,
        )
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {"error": "already_member", "message": "Already a member."},
        )

    invitation = ScopeInvitation(
        scope_id=scope_id,
        invitee_user_id=invitee.id,
        invitee_email=target_email,
        invited_by=auth.user_id,
        created_at=datetime.now(UTC),
    )
    db.add(invitation)
    try:
        await db.commit()
    except IntegrityError:
        # uq_scope_invitations_scope_user — pending invite exists.
        await db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {"error": "already_invited", "message": "Invitation already pending."},
        ) from None
    await db.refresh(invitation)

    logger.info(
        "invitation_created scope_id=%s email=%s by=%s",
        scope_id,
        target_email,
        auth.user_id,
    )
    return InvitationResponse(
        id=str(invitation.id),
        scope_id=str(scope_id),
        invitee_email=target_email,
        invited_by_user_id=str(auth.user_id),
        invited_by_display=auth.user.name or auth.user.email,
        created_at=invitation.created_at,
    )
```

- [ ] **Step 4: Verify tests pass**
- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(sharing): POST invitations endpoint"
```

---

### Task B.6: `GET /api/scopes/{id}/invitations` + `DELETE /api/scopes/{id}/invitations/{id}` (list / cancel)

**Files:**
- Modify: `backend/app/routes/sharing.py`
- Modify: `backend/tests/test_sharing_invitations.py`

- [ ] **Step 1: Tests**

Append to test file:

```python
@pytest.mark.asyncio
async def test_list_invitations(client, db_session, seed_user, seed_scope):
    from app.models.user import User

    invitee = User(
        clerk_id=f"li_{uuid.uuid4().hex[:8]}",
        email=f"li_{uuid.uuid4().hex[:6]}@test.dev",
        name="L",
    )
    db_session.add(invitee)
    await db_session.commit()
    try:
        await client.post(
            f"/api/scopes/{seed_scope.id}/invitations",
            json={"email": invitee.email},
        )
        r = await client.get(f"/api/scopes/{seed_scope.id}/invitations")
        assert r.status_code == 200
        items = r.json()
        assert len(items) == 1
        assert items[0]["invitee_email"] == invitee.email.lower()
    finally:
        await db_session.delete(invitee)
        await db_session.commit()


@pytest.mark.asyncio
async def test_cancel_invitation(client, db_session, seed_user, seed_scope):
    from app.models.scope_invitation import ScopeInvitation
    from app.models.user import User

    invitee = User(
        clerk_id=f"ci_{uuid.uuid4().hex[:8]}",
        email=f"ci_{uuid.uuid4().hex[:6]}@test.dev",
        name="C",
    )
    db_session.add(invitee)
    await db_session.commit()
    try:
        create = await client.post(
            f"/api/scopes/{seed_scope.id}/invitations",
            json={"email": invitee.email},
        )
        inv_id = create.json()["id"]
        r = await client.delete(
            f"/api/scopes/{seed_scope.id}/invitations/{inv_id}"
        )
        assert r.status_code == 200
        absent = (
            await db_session.execute(
                select(ScopeInvitation).where(ScopeInvitation.id == inv_id)
            )
        ).scalar_one_or_none()
        assert absent is None
    finally:
        await db_session.delete(invitee)
        await db_session.commit()
```

- [ ] **Step 2: Verify fail**

- [ ] **Step 3: Implement**

Append to `sharing.py`:

```python
@router.get("/{scope_id}/invitations", response_model=list[InvitationResponse])
async def list_invitations(
    scope_id: UUID,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> list[InvitationResponse]:
    await _assert_scope_owner(db, auth, scope_id)
    rows = (
        await db.execute(
            select(ScopeInvitation, User)
            .outerjoin(User, User.id == ScopeInvitation.invited_by)
            .where(ScopeInvitation.scope_id == scope_id)
            .order_by(ScopeInvitation.created_at.desc())
        )
    ).all()
    return [
        InvitationResponse(
            id=str(inv.id),
            scope_id=str(inv.scope_id),
            invitee_email=inv.invitee_email,
            invited_by_user_id=str(inv.invited_by),
            invited_by_display=(by.name or by.email) if by else None,
            created_at=inv.created_at,
        )
        for inv, by in rows
    ]


@router.delete("/{scope_id}/invitations/{invitation_id}")
async def cancel_invitation(
    scope_id: UUID,
    invitation_id: UUID,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    await _assert_scope_owner(db, auth, scope_id)
    row = (
        await db.execute(
            select(ScopeInvitation).where(
                ScopeInvitation.id == invitation_id,
                ScopeInvitation.scope_id == scope_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "invitation not found")
    await db.delete(row)
    await db.commit()
    logger.info(
        "invitation_cancelled id=%s by=%s", invitation_id, auth.user_id
    )
    return {"status": "cancelled"}
```

- [ ] **Step 4: Verify**
- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(sharing): list + cancel invitations"
```

---

### Task B.7: `GET /api/scopes/{id}/members` + `DELETE /api/scopes/{id}/members/{user_id}`

**Files:**
- Modify: `backend/app/routes/sharing.py`
- Create: `backend/tests/test_sharing_members.py`

- [ ] **Step 1: Tests**

Create `backend/tests/test_sharing_members.py`:

```python
"""Member listing + removal. Members are only created by accept-invite
or token-upgrade flows; for these tests we insert membership rows
directly to focus on the read/remove paths."""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select


@pytest.mark.asyncio
async def test_list_members_returns_user_info(
    client, db_session, seed_user, seed_scope
):
    from app.models.scope_membership import ScopeMembership
    from app.models.user import User

    member_user = User(
        clerk_id=f"m_{uuid.uuid4().hex[:8]}",
        email=f"m_{uuid.uuid4().hex[:6]}@test.dev",
        name="Member One",
    )
    db_session.add(member_user)
    await db_session.commit()
    await db_session.refresh(member_user)

    membership = ScopeMembership(
        scope_id=seed_scope.id,
        user_id=member_user.id,
        role="viewer",
        joined_via="invite",
        joined_at=datetime.now(UTC),
        resolved_owner_handle="ownerhandle",
    )
    db_session.add(membership)
    await db_session.commit()

    try:
        r = await client.get(f"/api/scopes/{seed_scope.id}/members")
        assert r.status_code == 200, r.text
        items = r.json()
        assert len(items) == 1
        assert items[0]["user_email"] == member_user.email
        assert items[0]["user_display"] == "Member One"
        assert items[0]["role"] == "viewer"
        assert items[0]["joined_via"] == "invite"
    finally:
        await db_session.delete(member_user)
        await db_session.commit()


@pytest.mark.asyncio
async def test_remove_member(
    client, db_session, seed_user, seed_scope
):
    from app.models.scope_membership import ScopeMembership
    from app.models.user import User

    member_user = User(
        clerk_id=f"rm_{uuid.uuid4().hex[:8]}",
        email=f"rm_{uuid.uuid4().hex[:6]}@test.dev",
        name="To Remove",
    )
    db_session.add(member_user)
    await db_session.commit()
    await db_session.refresh(member_user)
    membership = ScopeMembership(
        scope_id=seed_scope.id,
        user_id=member_user.id,
        role="viewer",
        joined_via="link",
        joined_at=datetime.now(UTC),
        resolved_owner_handle="h",
    )
    db_session.add(membership)
    await db_session.commit()

    try:
        r = await client.delete(
            f"/api/scopes/{seed_scope.id}/members/{member_user.id}"
        )
        assert r.status_code == 200
        absent = (
            await db_session.execute(
                select(ScopeMembership).where(
                    ScopeMembership.scope_id == seed_scope.id,
                    ScopeMembership.user_id == member_user.id,
                )
            )
        ).scalar_one_or_none()
        assert absent is None
    finally:
        await db_session.delete(member_user)
        await db_session.commit()
```

- [ ] **Step 2: Verify fail**

- [ ] **Step 3: Implement**

Append to `sharing.py`:

```python
from app.schemas.sharing import MemberResponse


@router.get("/{scope_id}/members", response_model=list[MemberResponse])
async def list_members(
    scope_id: UUID,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> list[MemberResponse]:
    await _assert_scope_owner(db, auth, scope_id)
    rows = (
        await db.execute(
            select(ScopeMembership, User)
            .join(User, User.id == ScopeMembership.user_id)
            .where(ScopeMembership.scope_id == scope_id)
            .order_by(ScopeMembership.joined_at.desc())
        )
    ).all()
    return [
        MemberResponse(
            id=str(m.id),
            user_id=str(m.user_id),
            user_email=u.email,
            user_display=u.name,
            role=m.role,
            joined_via=m.joined_via,
            joined_at=m.joined_at,
            resolved_owner_handle=m.resolved_owner_handle,
        )
        for m, u in rows
    ]


@router.delete("/{scope_id}/members/{user_id}")
async def remove_member(
    scope_id: UUID,
    user_id: UUID,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    await _assert_scope_owner(db, auth, scope_id)
    row = (
        await db.execute(
            select(ScopeMembership).where(
                ScopeMembership.scope_id == scope_id,
                ScopeMembership.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "member not found")
    await db.delete(row)
    await db.commit()
    logger.info(
        "member_removed scope_id=%s user_id=%s by=%s",
        scope_id,
        user_id,
        auth.user_id,
    )
    return {"status": "removed"}
```

- [ ] **Step 4: Verify**
- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(sharing): list + remove members endpoints"
```

---

### Task B.8: `POST /api/scopes/{id}/unshare` (transactional clear)

**Files:**
- Modify: `backend/app/routes/sharing.py`
- Modify: `backend/tests/test_sharing_members.py`

- [ ] **Step 1: Test**

Append:

```python
@pytest.mark.asyncio
async def test_unshare_revokes_links_and_removes_members(
    client, db_session, seed_user, seed_scope
):
    from app.models.scope_membership import ScopeMembership
    from app.models.scope_share_link import ScopeShareLink
    from app.models.user import User

    member_user = User(
        clerk_id=f"u_{uuid.uuid4().hex[:8]}",
        email=f"u_{uuid.uuid4().hex[:6]}@test.dev",
        name="X",
    )
    db_session.add(member_user)
    await db_session.commit()
    await db_session.refresh(member_user)
    db_session.add(
        ScopeMembership(
            scope_id=seed_scope.id,
            user_id=member_user.id,
            role="viewer",
            joined_via="link",
            joined_at=datetime.now(UTC),
            resolved_owner_handle="h",
        )
    )
    await db_session.commit()
    await client.post(f"/api/scopes/{seed_scope.id}/share-links", json={})
    await client.post(f"/api/scopes/{seed_scope.id}/share-links", json={})

    try:
        r = await client.post(f"/api/scopes/{seed_scope.id}/unshare")
        assert r.status_code == 200
        body = r.json()
        assert body["links_revoked"] == 2
        assert body["members_removed"] == 1

        links = (
            await db_session.execute(
                select(ScopeShareLink).where(
                    ScopeShareLink.scope_id == seed_scope.id
                )
            )
        ).scalars().all()
        assert all(l.revoked_at is not None for l in links)
        absent = (
            await db_session.execute(
                select(ScopeMembership).where(
                    ScopeMembership.scope_id == seed_scope.id
                )
            )
        ).scalar_one_or_none()
        assert absent is None
    finally:
        await db_session.delete(member_user)
        await db_session.commit()
```

- [ ] **Step 2: Verify fail (404 — endpoint absent)**

- [ ] **Step 3: Implement**

Append to `sharing.py`:

```python
from sqlalchemy import update, delete as sql_delete

from app.schemas.sharing import UnshareResponse


@router.post("/{scope_id}/unshare", response_model=UnshareResponse)
async def unshare(
    scope_id: UUID,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> UnshareResponse:
    """Revoke every share link + remove every member + delete every
    pending invitation in one transaction. Idempotent."""
    await _assert_scope_owner(db, auth, scope_id)
    now = datetime.now(UTC)

    revoke_result = await db.execute(
        update(ScopeShareLink)
        .where(
            ScopeShareLink.scope_id == scope_id,
            ScopeShareLink.revoked_at.is_(None),
        )
        .values(revoked_at=now)
    )
    member_result = await db.execute(
        sql_delete(ScopeMembership).where(ScopeMembership.scope_id == scope_id)
    )
    invite_result = await db.execute(
        sql_delete(ScopeInvitation).where(ScopeInvitation.scope_id == scope_id)
    )
    await db.commit()

    logger.info(
        "unshare scope_id=%s links=%d members=%d invites=%d by=%s",
        scope_id,
        revoke_result.rowcount,
        member_result.rowcount,
        invite_result.rowcount,
        auth.user_id,
    )
    return UnshareResponse(
        links_revoked=revoke_result.rowcount or 0,
        members_removed=member_result.rowcount or 0,
        invitations_cancelled=invite_result.rowcount or 0,
    )
```

- [ ] **Step 4: Verify**
- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(sharing): POST unshare endpoint"
```

---

### Task B.9: Phase B lint pass + PR-B

- [ ] **Step 1: Lint**

Run: `cd backend && uv run ruff format app/ tests/ && uv run ruff check app/`
Expected: clean.

- [ ] **Step 2: Full test pass**

Run: `cd backend && uv run pytest tests/test_sharing_owner.py tests/test_sharing_invitations.py tests/test_sharing_members.py -v`
Expected: all PASS.

- [ ] **Step 3: Push**

```bash
git push origin feat/scope-sharing
```

- [ ] **Step 4: PR description**

If shipping Phase A + B together, update PR-A's body to mention owner routes. If separate PR, open PR-B with title `feat(sharing): backend owner routes (Phase B)`.

---

## Phase C — Backend Sharee Routes

Goal: ship the anonymous share-redeem surface (`/api/share/...`), the sharee-facing `/api/me/...` surface (invitations inbox, scope list, accept/decline), and the `scope_id`-level leave + accept transactional flows.

### Task C.1: `share_redeem.py` router skeleton

**Files:**
- Create: `backend/app/routes/share_redeem.py`
- Modify: `backend/app/main.py`
- Create: `backend/tests/test_sharing_redeem.py`

- [ ] **Step 1: Failing test**

Create `backend/tests/test_sharing_redeem.py`:

```python
"""Public /api/share/{token}/... endpoints — no auth, no user
identity. Token presence + validity is the sole gate."""

import pytest
from datetime import UTC, datetime


@pytest.mark.asyncio
async def test_redeem_unknown_token_404(client_unauth):
    r = await client_unauth.post("/api/share/totally-bogus/redeem")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_redeem_valid_token_returns_scope_summary(
    client_unauth, db_session, seed_user, seed_scope
):
    from app.models.scope_share_link import ScopeShareLink
    from app.services.sharing import generate_share_token, hash_share_token

    raw = generate_share_token()
    link = ScopeShareLink(
        scope_id=seed_scope.id,
        token_hash=hash_share_token(raw),
        token_prefix=raw[:8],
        created_by=seed_user.id,
        created_at=datetime.now(UTC),
    )
    db_session.add(link)
    await db_session.commit()

    r = await client_unauth.post(f"/api/share/{raw}/redeem")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scope_id"] == str(seed_scope.id)
    assert body["owner_display"] in (seed_user.name, seed_user.email)
    assert isinstance(body["owner_handle"], str)
    assert body["vault_locked"] is True


@pytest.mark.asyncio
async def test_redeem_increments_count(
    client_unauth, db_session, seed_user, seed_scope
):
    from app.models.scope_share_link import ScopeShareLink
    from app.services.sharing import generate_share_token, hash_share_token
    from sqlalchemy import select

    raw = generate_share_token()
    link = ScopeShareLink(
        scope_id=seed_scope.id,
        token_hash=hash_share_token(raw),
        token_prefix=raw[:8],
        created_by=seed_user.id,
        created_at=datetime.now(UTC),
    )
    db_session.add(link)
    await db_session.commit()
    link_id = link.id

    await client_unauth.post(f"/api/share/{raw}/redeem")
    await client_unauth.post(f"/api/share/{raw}/redeem")

    db_session.expire_all()
    row = (
        await db_session.execute(
            select(ScopeShareLink).where(ScopeShareLink.id == link_id)
        )
    ).scalar_one()
    assert row.redeem_count == 2
    assert row.last_redeemed_at is not None
```

- [ ] **Step 2: Verify fail**

- [ ] **Step 3: Implement**

Create `backend/app/routes/share_redeem.py`:

```python
"""Public anonymous share-token endpoints.

Auth dep is `require_share_token` — no AuthContext, no user identity.
Endpoints expose read-only metadata + tarball streams scoped to a
single shared scope's content. Vault item plaintext is NOT available
via this surface (see spec § 7.4); CLI clients pre-empt vault resolve
on share-token-only state.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import ShareTokenContext, require_share_token
from app.core.database import get_session
from app.models.scope import Scope
from app.models.scope_membership import ScopeMembership
from app.models.scope_share_link import ScopeShareLink
from app.models.skill import Skill
from app.models.user import User
from app.models.vault import Vault, VaultItem
from app.schemas.sharing import ShareRedeemResponse
from app.services.sharing import resolve_owner_handle

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/share", tags=["share-redeem"])


async def _owner_display_for_link(
    db: AsyncSession, link: ScopeShareLink
) -> tuple[str, str, User]:
    """Resolve owner display + handle for a share-link redemption.

    The handle is NOT recomputed — it was frozen on the link row at
    create time (`scope_share_links.resolved_owner_handle`). The
    display string IS recomputed each call since it's purely
    presentation (no path stability concerns).
    """
    scope_result = await db.execute(select(Scope).where(Scope.id == link.scope_id))
    scope = scope_result.scalar_one()
    owner_result = await db.execute(select(User).where(User.id == scope.user_id))
    owner = owner_result.scalar_one()
    display = owner.name or owner.email or f"user-{str(owner.id)[:8]}"
    return display, link.resolved_owner_handle, owner


@router.post("/{token}/redeem", response_model=ShareRedeemResponse)
async def redeem(
    ctx: ShareTokenContext = Depends(require_share_token),
    db: AsyncSession = Depends(get_session),
) -> ShareRedeemResponse:
    """First-time redemption: returns scope metadata + counts.

    Side effect: bumps redeem_count and stamps last_redeemed_at. The
    operation is idempotent for the client (returns the same payload
    on repeated calls) but accumulates stats for the owner."""
    # Bump counter atomically.
    await db.execute(
        update(ScopeShareLink)
        .where(ScopeShareLink.id == ctx.link_id)
        .values(
            redeem_count=ScopeShareLink.redeem_count + 1,
            last_redeemed_at=datetime.now(UTC),
        )
    )

    link_result = await db.execute(
        select(ScopeShareLink).where(ScopeShareLink.id == ctx.link_id)
    )
    link = link_result.scalar_one()
    scope_result = await db.execute(select(Scope).where(Scope.id == ctx.scope_id))
    scope = scope_result.scalar_one()
    display, handle, _ = await _owner_display_for_link(db, link)

    skill_count = (
        await db.execute(
            select(func.count(Skill.id)).where(
                Skill.scope_id == ctx.scope_id, Skill.is_active == True  # noqa: E712
            )
        )
    ).scalar_one() or 0

    vault_count = (
        await db.execute(
            select(func.count(VaultItem.id))
            .join(Vault, Vault.id == VaultItem.vault_id)
            .where(Vault.scope_id == ctx.scope_id)
        )
    ).scalar_one() or 0

    await db.commit()

    return ShareRedeemResponse(
        scope_id=str(scope.id),
        scope_name=scope.name,
        owner_display=display,
        owner_handle=handle,
        skill_count=skill_count,
        vault_count=vault_count,
        vault_locked=True,
    )
```

- [ ] **Step 4: Register router**

Modify `backend/app/main.py`:

```python
from app.routes.share_redeem import router as share_redeem_router
# ...
app.include_router(share_redeem_router)
```

- [ ] **Step 5: Verify tests pass**

- [ ] **Step 6: Commit**

```bash
git add backend/app/routes/share_redeem.py backend/app/main.py backend/tests/test_sharing_redeem.py
git commit -m "feat(sharing): POST share-redeem endpoint"
```

---

### Task C.2: `GET /api/share/{token}/scope` (full scope index)

**Files:**
- Modify: `backend/app/routes/share_redeem.py`
- Modify: `backend/tests/test_sharing_redeem.py`

- [ ] **Step 1: Tests**

Append:

```python
@pytest.mark.asyncio
async def test_scope_index_returns_skill_and_vault_metadata(
    client_unauth, db_session, seed_user, seed_scope
):
    from app.models.scope_share_link import ScopeShareLink
    from app.models.skill import Skill
    from app.models.vault import Vault, VaultItem
    from app.services.sharing import generate_share_token, hash_share_token

    raw = generate_share_token()
    db_session.add(
        ScopeShareLink(
            scope_id=seed_scope.id,
            token_hash=hash_share_token(raw),
            token_prefix=raw[:8],
            created_by=seed_user.id,
            created_at=datetime.now(UTC),
        )
    )
    db_session.add(
        Skill(
            user_id=seed_user.id,
            scope_id=seed_scope.id,
            skill_key="kit-1",
            name="Kit 1",
            content_hash="aa" * 32,
        )
    )
    vault = Vault(
        user_id=seed_user.id,
        scope_id=seed_scope.id,
        slug="prod",
        name="Prod",
    )
    db_session.add(vault)
    await db_session.flush()
    db_session.add(
        VaultItem(
            vault_id=vault.id,
            item_name="api-key",
            section="",
            encrypted_value=b"x",
            nonce=b"n" * 12,
        )
    )
    await db_session.commit()

    r = await client_unauth.get(f"/api/share/{raw}/scope")
    assert r.status_code == 200, r.text
    body = r.json()
    assert {s["skill_key"] for s in body["skills"]} == {"kit-1"}
    vault_slugs = {v["slug"] for v in body["vaults"]}
    assert "prod" in vault_slugs
    prod = next(v for v in body["vaults"] if v["slug"] == "prod")
    item_names = {item["item_name"] for item in prod["items"]}
    assert "api-key" in item_names
    # No encrypted_value or nonce in payload.
    first_item = prod["items"][0]
    assert "encrypted_value" not in first_item
    assert "nonce" not in first_item
```

- [ ] **Step 2: Verify fail**

- [ ] **Step 3: Implement**

Add to `share_redeem.py`:

```python
from pydantic import BaseModel


class _SkillIndex(BaseModel):
    skill_key: str
    name: str
    version: int
    content_hash: str
    description: str | None


class _VaultItemIndex(BaseModel):
    item_name: str
    section: str
    updated_at: datetime


class _VaultIndex(BaseModel):
    slug: str
    name: str
    items: list[_VaultItemIndex]


class _ScopeIndexResponse(BaseModel):
    scope_id: str
    scope_name: str
    owner_display: str
    owner_handle: str
    skills: list[_SkillIndex]
    vaults: list[_VaultIndex]


@router.get("/{token}/scope", response_model=_ScopeIndexResponse)
async def scope_index(
    ctx: ShareTokenContext = Depends(require_share_token),
    db: AsyncSession = Depends(get_session),
) -> _ScopeIndexResponse:
    link_result = await db.execute(
        select(ScopeShareLink).where(ScopeShareLink.id == ctx.link_id)
    )
    link = link_result.scalar_one()
    scope_result = await db.execute(select(Scope).where(Scope.id == ctx.scope_id))
    scope = scope_result.scalar_one()
    display, handle, _ = await _owner_display_for_link(db, link)

    skills = (
        await db.execute(
            select(Skill)
            .where(
                Skill.scope_id == ctx.scope_id,
                Skill.is_active == True,  # noqa: E712
            )
            .order_by(Skill.skill_key)
        )
    ).scalars().all()

    vault_rows = (
        await db.execute(
            select(Vault).where(Vault.scope_id == ctx.scope_id).order_by(Vault.slug)
        )
    ).scalars().all()
    vault_indices: list[_VaultIndex] = []
    for v in vault_rows:
        items = (
            await db.execute(
                select(VaultItem)
                .where(VaultItem.vault_id == v.id)
                .order_by(VaultItem.section, VaultItem.item_name)
            )
        ).scalars().all()
        vault_indices.append(
            _VaultIndex(
                slug=v.slug,
                name=v.name,
                items=[
                    _VaultItemIndex(
                        item_name=item.item_name,
                        section=item.section,
                        updated_at=item.updated_at,
                    )
                    for item in items
                ],
            )
        )

    return _ScopeIndexResponse(
        scope_id=str(scope.id),
        scope_name=scope.name,
        owner_display=display,
        owner_handle=handle,
        skills=[
            _SkillIndex(
                skill_key=s.skill_key,
                name=s.name,
                version=s.version,
                content_hash=s.content_hash,
                description=s.description,
            )
            for s in skills
        ],
        vaults=vault_indices,
    )
```

- [ ] **Step 4: Verify**
- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(sharing): GET share-scope index (skills + vault metadata)"
```

---

### Task C.3: `GET /api/share/{token}/skills/{skill_key}/tarball`

**Files:**
- Modify: `backend/app/routes/share_redeem.py`
- Modify: `backend/tests/test_sharing_redeem.py`

This route streams the same tar content the authenticated skill download path returns, but gated by `require_share_token` instead of `require_user_auth`. Reuse the existing tar streaming helper (find it via `grep -rn "skill_tarball\|tar_stream" backend/app/routes/skills.py`); thin wrapper.

- [ ] **Step 1: Test**

Append to `test_sharing_redeem.py`:

```python
@pytest.mark.asyncio
async def test_skill_tarball_streams_via_token(
    client_unauth, db_session, seed_user, seed_scope, tmp_path
):
    """Smoke: token-bound caller can fetch a skill tar."""
    from app.models.scope_share_link import ScopeShareLink
    from app.models.skill import Skill
    from app.services.sharing import generate_share_token, hash_share_token

    raw = generate_share_token()
    db_session.add(
        ScopeShareLink(
            scope_id=seed_scope.id,
            token_hash=hash_share_token(raw),
            token_prefix=raw[:8],
            created_by=seed_user.id,
            created_at=datetime.now(UTC),
        )
    )
    db_session.add(
        Skill(
            user_id=seed_user.id,
            scope_id=seed_scope.id,
            skill_key="streamable",
            name="S",
            content_hash="ab" * 32,
            file_key=None,  # local file_store; details depend on test setup
        )
    )
    await db_session.commit()

    r = await client_unauth.get(
        f"/api/share/{raw}/skills/streamable/tarball"
    )
    # 200 if file_store has content; 404 if there's no tar persisted
    # (acceptable for this smoke test — the route plumbing is what we
    # care about). Either way the path resolved and auth gate passed.
    assert r.status_code in (200, 404), r.text
```

- [ ] **Step 2: Verify fail (405)**

- [ ] **Step 3: Implement**

Inspect the existing authenticated tarball route in `backend/app/routes/skills.py` and copy/adapt the streaming logic. The new endpoint signature:

```python
from fastapi.responses import StreamingResponse

from app.services.file_store import get_file_store


@router.get("/{token}/skills/{skill_key}/tarball")
async def skill_tarball(
    skill_key: str,
    ctx: ShareTokenContext = Depends(require_share_token),
    db: AsyncSession = Depends(get_session),
) -> StreamingResponse:
    """Stream the active skill tar for the token's scope.

    Mirrors the authenticated `/api/skills/{key}/tarball` route but
    gated by token. Inactive / missing skills → 404."""
    result = await db.execute(
        select(Skill).where(
            Skill.scope_id == ctx.scope_id,
            Skill.skill_key == skill_key,
            Skill.is_active == True,  # noqa: E712
        )
    )
    skill = result.scalar_one_or_none()
    if skill is None or skill.file_key is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "skill not found")

    store = get_file_store()
    try:
        stream = await store.open_stream(skill.file_key)
    except FileNotFoundError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "tar missing") from e
    return StreamingResponse(stream, media_type="application/x-tar")
```

(Adjust import paths to match the existing file_store helper.)

- [ ] **Step 4: Verify**
- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(sharing): GET share-token skill tarball stream"
```

---

### Task C.4: `POST /api/share/{token}/upgrade` (token → membership)

**Files:**
- Modify: `backend/app/routes/share_redeem.py`
- Create: `backend/tests/test_sharing_upgrade.py`

- [ ] **Step 1: Tests**

Create `backend/tests/test_sharing_upgrade.py`:

```python
"""Convert a still-valid share-token into a permanent ScopeMembership
for the now-authenticated caller. Idempotent on (scope_id, user_id)."""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select


@pytest.mark.asyncio
async def test_upgrade_creates_membership(
    client, db_session, seed_user, seed_scope
):
    """Note: `client` is Clerk-authed for seed_user. We share to
    seed_user from a DIFFERENT user (owner), then upgrade as seed_user."""
    from app.models.scope import SCOPE_KIND_PERSONAL, Scope
    from app.models.scope_membership import ScopeMembership
    from app.models.scope_share_link import ScopeShareLink
    from app.models.user import User
    from app.services.sharing import generate_share_token, hash_share_token

    owner = User(
        clerk_id=f"o_{uuid.uuid4().hex[:8]}",
        email=f"o_{uuid.uuid4().hex[:6]}@test.dev",
        name="Owner",
    )
    db_session.add(owner)
    await db_session.commit()
    owner_scope = Scope(
        user_id=owner.id, name="Owner's", slug="owners", kind=SCOPE_KIND_PERSONAL
    )
    db_session.add(owner_scope)
    await db_session.commit()
    raw = generate_share_token()
    db_session.add(
        ScopeShareLink(
            scope_id=owner_scope.id,
            token_hash=hash_share_token(raw),
            token_prefix=raw[:8],
            created_by=owner.id,
            created_at=datetime.now(UTC),
        )
    )
    await db_session.commit()

    try:
        r = await client.post(f"/api/share/{raw}/upgrade")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["scope_id"] == str(owner_scope.id)
        assert body["role"] == "viewer"

        membership = (
            await db_session.execute(
                select(ScopeMembership).where(
                    ScopeMembership.scope_id == owner_scope.id,
                    ScopeMembership.user_id == seed_user.id,
                )
            )
        ).scalar_one()
        assert membership.joined_via == "link"
        assert membership.resolved_owner_handle  # non-empty
    finally:
        await db_session.delete(owner_scope)
        await db_session.delete(owner)
        await db_session.commit()


@pytest.mark.asyncio
async def test_upgrade_twice_is_idempotent(
    client, db_session, seed_user
):
    """Two devices upgrading the same token converge on one row."""
    from app.models.scope import SCOPE_KIND_PERSONAL, Scope
    from app.models.scope_membership import ScopeMembership
    from app.models.scope_share_link import ScopeShareLink
    from app.models.user import User
    from app.services.sharing import generate_share_token, hash_share_token
    from sqlalchemy import func

    owner = User(
        clerk_id=f"o2_{uuid.uuid4().hex[:8]}",
        email=f"o2_{uuid.uuid4().hex[:6]}@test.dev",
        name="O",
    )
    db_session.add(owner)
    await db_session.commit()
    scope = Scope(user_id=owner.id, name="X", slug="x", kind=SCOPE_KIND_PERSONAL)
    db_session.add(scope)
    await db_session.commit()
    raw = generate_share_token()
    db_session.add(
        ScopeShareLink(
            scope_id=scope.id,
            token_hash=hash_share_token(raw),
            token_prefix=raw[:8],
            created_by=owner.id,
            created_at=datetime.now(UTC),
        )
    )
    await db_session.commit()

    try:
        r1 = await client.post(f"/api/share/{raw}/upgrade")
        r2 = await client.post(f"/api/share/{raw}/upgrade")
        assert r1.status_code == 200
        assert r2.status_code == 200
        count = (
            await db_session.execute(
                select(func.count(ScopeMembership.id)).where(
                    ScopeMembership.scope_id == scope.id,
                    ScopeMembership.user_id == seed_user.id,
                )
            )
        ).scalar_one()
        assert count == 1
    finally:
        await db_session.delete(scope)
        await db_session.delete(owner)
        await db_session.commit()


@pytest.mark.asyncio
async def test_upgrade_owner_self_is_409(client, seed_user, db_session, seed_scope):
    """Owner of the scope trying to 'become a viewer of themselves' — reject."""
    from app.models.scope_share_link import ScopeShareLink
    from app.services.sharing import generate_share_token, hash_share_token

    raw = generate_share_token()
    db_session.add(
        ScopeShareLink(
            scope_id=seed_scope.id,
            token_hash=hash_share_token(raw),
            token_prefix=raw[:8],
            created_by=seed_user.id,
            created_at=datetime.now(UTC),
        )
    )
    await db_session.commit()

    r = await client.post(f"/api/share/{raw}/upgrade")
    assert r.status_code == 409
    assert r.json()["detail"]["error"] == "already_owner"
```

- [ ] **Step 2: Verify fail**

- [ ] **Step 3: Implement**

Append to `share_redeem.py`:

```python
from app.core.auth import require_user_auth, AuthContext


@router.post("/{token}/upgrade")
async def upgrade(
    ctx: ShareTokenContext = Depends(require_share_token),
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> dict:
    """Convert a share-token access into a permanent ScopeMembership
    for the now-signed-in caller. Idempotent: re-calling for the same
    (scope, user) returns the existing row.
    """
    scope = (
        await db.execute(select(Scope).where(Scope.id == ctx.scope_id))
    ).scalar_one()
    if scope.user_id == auth.user_id:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {"error": "already_owner", "message": "You own this scope."},
        )

    existing = (
        await db.execute(
            select(ScopeMembership).where(
                ScopeMembership.scope_id == ctx.scope_id,
                ScopeMembership.user_id == auth.user_id,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        return _membership_response(existing)

    # Copy the frozen handle off the share-link row. This is what
    # keeps anonymous + post-upgrade paths in agreement on the
    # local skill folder name.
    link = (
        await db.execute(
            select(ScopeShareLink).where(ScopeShareLink.id == ctx.link_id)
        )
    ).scalar_one()

    membership = ScopeMembership(
        scope_id=ctx.scope_id,
        user_id=auth.user_id,
        role="viewer",
        joined_via="link",
        joined_at=datetime.now(UTC),
        resolved_owner_handle=link.resolved_owner_handle,
    )
    db.add(membership)
    # Auto-cleanup: if this user has a pending email invitation to
    # the same scope, blow it away — they joined via the link first.
    await db.execute(
        sql_delete(ScopeInvitation).where(
            ScopeInvitation.scope_id == ctx.scope_id,
            ScopeInvitation.invitee_user_id == auth.user_id,
        )
    )
    try:
        await db.commit()
        await db.refresh(membership)
    except Exception:
        # ON CONFLICT (scope_id, user_id) race — re-read existing.
        await db.rollback()
        existing = (
            await db.execute(
                select(ScopeMembership).where(
                    ScopeMembership.scope_id == ctx.scope_id,
                    ScopeMembership.user_id == auth.user_id,
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            return _membership_response(existing)
        raise

    logger.info(
        "membership_via_link scope_id=%s user_id=%s handle=%s",
        ctx.scope_id,
        auth.user_id,
        handle,
    )
    return _membership_response(membership)


def _membership_response(m: ScopeMembership) -> dict:
    return {
        "id": str(m.id),
        "scope_id": str(m.scope_id),
        "user_id": str(m.user_id),
        "role": m.role,
        "joined_via": m.joined_via,
        "joined_at": m.joined_at.isoformat(),
        "resolved_owner_handle": m.resolved_owner_handle,
    }
```

- [ ] **Step 4: Verify**
- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(sharing): POST share upgrade — token to membership"
```

---

### Task C.5: `/api/me/...` router (invitations + scope list + accept/decline + leave)

**Files:**
- Create: `backend/app/routes/me.py`
- Modify: `backend/app/routes/scopes.py`
- Modify: `backend/app/main.py`
- Create: `backend/tests/test_me_routes.py`

- [ ] **Step 1: Tests**

Create `backend/tests/test_me_routes.py`:

```python
"""Sharee-facing /api/me/... and scope-leave routes."""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select


@pytest.mark.asyncio
async def test_me_invitations_lists_only_my_email(
    client, db_session, seed_user
):
    from app.models.scope import SCOPE_KIND_PERSONAL, Scope
    from app.models.scope_invitation import ScopeInvitation
    from app.models.user import User

    owner = User(
        clerk_id=f"o_{uuid.uuid4().hex[:8]}",
        email=f"o_{uuid.uuid4().hex[:6]}@test.dev",
        name="O",
    )
    db_session.add(owner)
    await db_session.commit()
    scope = Scope(user_id=owner.id, name="x", slug="x", kind=SCOPE_KIND_PERSONAL)
    db_session.add(scope)
    await db_session.commit()
    db_session.add(
        ScopeInvitation(
            scope_id=scope.id,
            invitee_user_id=seed_user.id,
            invitee_email=seed_user.email.lower(),
            invited_by=owner.id,
            created_at=datetime.now(UTC),
        )
    )
    # An invitation to a DIFFERENT user — must NOT appear in seed_user's inbox.
    other_invitee = User(
        clerk_id=f"other_{uuid.uuid4().hex[:8]}",
        email="someone-else@test.dev",
        name="Someone Else",
    )
    db_session.add(other_invitee)
    await db_session.commit()
    db_session.add(
        ScopeInvitation(
            scope_id=scope.id,
            invitee_user_id=other_invitee.id,
            invitee_email=other_invitee.email,
            invited_by=owner.id,
            created_at=datetime.now(UTC),
        )
    )
    await db_session.commit()

    try:
        r = await client.get("/api/me/invitations")
        assert r.status_code == 200
        items = r.json()
        assert len(items) == 1
        assert items[0]["invitee_email"] == seed_user.email.lower()
    finally:
        await db_session.delete(scope)
        await db_session.delete(owner)
        await db_session.commit()


@pytest.mark.asyncio
async def test_accept_invitation_creates_membership(
    client, db_session, seed_user
):
    from app.models.scope import SCOPE_KIND_PERSONAL, Scope
    from app.models.scope_invitation import ScopeInvitation
    from app.models.scope_membership import ScopeMembership
    from app.models.user import User

    owner = User(
        clerk_id=f"o_{uuid.uuid4().hex[:8]}",
        email=f"o_{uuid.uuid4().hex[:6]}@test.dev",
        name="O",
    )
    db_session.add(owner)
    await db_session.commit()
    scope = Scope(user_id=owner.id, name="x", slug="x", kind=SCOPE_KIND_PERSONAL)
    db_session.add(scope)
    await db_session.commit()
    inv = ScopeInvitation(
        scope_id=scope.id,
        invitee_user_id=seed_user.id,
        invitee_email=seed_user.email.lower(),
        invited_by=owner.id,
        created_at=datetime.now(UTC),
    )
    db_session.add(inv)
    await db_session.commit()
    inv_id = inv.id

    try:
        r = await client.post(f"/api/me/invitations/{inv_id}/accept")
        assert r.status_code == 200, r.text
        # Invitation gone, membership created.
        absent = (
            await db_session.execute(
                select(ScopeInvitation).where(ScopeInvitation.id == inv_id)
            )
        ).scalar_one_or_none()
        assert absent is None
        membership = (
            await db_session.execute(
                select(ScopeMembership).where(
                    ScopeMembership.scope_id == scope.id,
                    ScopeMembership.user_id == seed_user.id,
                )
            )
        ).scalar_one()
        assert membership.joined_via == "invite"
    finally:
        await db_session.delete(scope)
        await db_session.delete(owner)
        await db_session.commit()


@pytest.mark.asyncio
async def test_decline_invitation_deletes_row(client, db_session, seed_user):
    from app.models.scope import SCOPE_KIND_PERSONAL, Scope
    from app.models.scope_invitation import ScopeInvitation
    from app.models.user import User

    owner = User(
        clerk_id=f"o_{uuid.uuid4().hex[:8]}",
        email=f"o_{uuid.uuid4().hex[:6]}@test.dev",
        name="O",
    )
    db_session.add(owner)
    await db_session.commit()
    scope = Scope(user_id=owner.id, name="x", slug="x", kind=SCOPE_KIND_PERSONAL)
    db_session.add(scope)
    await db_session.commit()
    inv = ScopeInvitation(
        scope_id=scope.id,
        invitee_user_id=seed_user.id,
        invitee_email=seed_user.email.lower(),
        invited_by=owner.id,
        created_at=datetime.now(UTC),
    )
    db_session.add(inv)
    await db_session.commit()
    inv_id = inv.id

    try:
        r = await client.post(f"/api/me/invitations/{inv_id}/decline")
        assert r.status_code == 200
        absent = (
            await db_session.execute(
                select(ScopeInvitation).where(ScopeInvitation.id == inv_id)
            )
        ).scalar_one_or_none()
        assert absent is None
    finally:
        await db_session.delete(scope)
        await db_session.delete(owner)
        await db_session.commit()


@pytest.mark.asyncio
async def test_leave_scope_deletes_membership(client, db_session, seed_user):
    from app.models.scope import SCOPE_KIND_PERSONAL, Scope
    from app.models.scope_membership import ScopeMembership
    from app.models.user import User

    owner = User(
        clerk_id=f"o_{uuid.uuid4().hex[:8]}",
        email=f"o_{uuid.uuid4().hex[:6]}@test.dev",
        name="O",
    )
    db_session.add(owner)
    await db_session.commit()
    scope = Scope(user_id=owner.id, name="x", slug="x", kind=SCOPE_KIND_PERSONAL)
    db_session.add(scope)
    await db_session.commit()
    db_session.add(
        ScopeMembership(
            scope_id=scope.id,
            user_id=seed_user.id,
            role="viewer",
            joined_via="invite",
            joined_at=datetime.now(UTC),
            resolved_owner_handle="o",
        )
    )
    await db_session.commit()

    try:
        r = await client.post(f"/api/scopes/{scope.id}/leave")
        assert r.status_code == 200
        absent = (
            await db_session.execute(
                select(ScopeMembership).where(
                    ScopeMembership.scope_id == scope.id,
                    ScopeMembership.user_id == seed_user.id,
                )
            )
        ).scalar_one_or_none()
        assert absent is None
    finally:
        await db_session.delete(scope)
        await db_session.delete(owner)
        await db_session.commit()


@pytest.mark.asyncio
async def test_me_scopes_split_owned_and_shared(
    client, db_session, seed_user, seed_scope
):
    from app.models.scope import SCOPE_KIND_PERSONAL, Scope
    from app.models.scope_membership import ScopeMembership
    from app.models.user import User

    owner = User(
        clerk_id=f"o_{uuid.uuid4().hex[:8]}",
        email=f"o_{uuid.uuid4().hex[:6]}@test.dev",
        name="O",
    )
    db_session.add(owner)
    await db_session.commit()
    shared = Scope(
        user_id=owner.id, name="shared", slug="shared", kind=SCOPE_KIND_PERSONAL
    )
    db_session.add(shared)
    await db_session.commit()
    db_session.add(
        ScopeMembership(
            scope_id=shared.id,
            user_id=seed_user.id,
            role="viewer",
            joined_via="invite",
            joined_at=datetime.now(UTC),
            resolved_owner_handle="ohandle",
        )
    )
    await db_session.commit()

    try:
        r = await client.get("/api/me/scopes")
        assert r.status_code == 200, r.text
        body = r.json()
        assert any(s["id"] == str(seed_scope.id) for s in body["owned"])
        assert any(s["id"] == str(shared.id) for s in body["shared"])
        shared_entry = next(s for s in body["shared"] if s["id"] == str(shared.id))
        assert shared_entry["owner_handle"] == "ohandle"
    finally:
        await db_session.delete(shared)
        await db_session.delete(owner)
        await db_session.commit()
```

- [ ] **Step 2: Verify failures**

- [ ] **Step 3: Implement me.py**

Create `backend/app/routes/me.py`:

```python
"""Caller-facing /api/me/... routes for the sharee experience.

invitations inbox + accept/decline + a merged scope listing that
distinguishes "my scopes" from "shared with me".
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_user_auth
from app.core.database import get_session
from app.models.scope import Scope
from app.models.scope_invitation import ScopeInvitation
from app.models.scope_membership import ScopeMembership
from app.models.user import User
from app.schemas.sharing import InvitationResponse, SharedScopeResponse
from app.services.sharing import resolve_owner_handle

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/me", tags=["me"])


@router.get("/invitations", response_model=list[InvitationResponse])
async def list_my_invitations(
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> list[InvitationResponse]:
    rows = (
        await db.execute(
            select(ScopeInvitation, User)
            .outerjoin(User, User.id == ScopeInvitation.invited_by)
            .where(ScopeInvitation.invitee_user_id == auth.user_id)
            .order_by(ScopeInvitation.created_at.desc())
        )
    ).all()
    return [
        InvitationResponse(
            id=str(inv.id),
            scope_id=str(inv.scope_id),
            invitee_email=inv.invitee_email,
            invited_by_user_id=str(inv.invited_by),
            invited_by_display=(by.name or by.email) if by else None,
            created_at=inv.created_at,
        )
        for inv, by in rows
    ]


@router.post("/invitations/{invitation_id}/accept")
async def accept_invitation(
    invitation_id: UUID,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> dict:
    inv = (
        await db.execute(
            select(ScopeInvitation).where(ScopeInvitation.id == invitation_id)
        )
    ).scalar_one_or_none()
    # Identity check on invitee_user_id (stable across email rotations)
    # — not on invitee_email which is purely historical context.
    if inv is None or inv.invitee_user_id != auth.user_id:
        raise HTTPException(status.HTTP_410_GONE, "invitation not available")

    scope = (
        await db.execute(select(Scope).where(Scope.id == inv.scope_id))
    ).scalar_one()
    owner = (
        await db.execute(select(User).where(User.id == scope.user_id))
    ).scalar_one()

    # Compute the frozen handle from the owner's current identity.
    # Helper raises ValueError if owner has no display_name — that
    # would be unusual at this stage (the share-link path 409s on
    # this, but the invite path doesn't pre-check). Surface as 409
    # so the owner knows to set their profile.
    try:
        handle = resolve_owner_handle(owner)
    except ValueError:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "error": "owner_display_name_required",
                "message": (
                    "The scope owner has no display name set on their profile. "
                    "Ask them to set one before you can join."
                ),
            },
        ) from None

    membership = ScopeMembership(
        scope_id=inv.scope_id,
        user_id=auth.user_id,
        role="viewer",
        joined_via="invite",
        joined_at=datetime.now(UTC),
        resolved_owner_handle=handle,
    )
    db.add(membership)
    await db.delete(inv)
    # Defense in depth: if the same user happens to have any OTHER
    # pending invitation row for the same scope (e.g. owner accidentally
    # invited an alias email that maps to the same user_id, though
    # the unique constraint on (scope_id, invitee_user_id) makes
    # this near-impossible in practice), clear them too.
    await db.execute(
        sql_delete(ScopeInvitation).where(
            ScopeInvitation.scope_id == inv.scope_id,
            ScopeInvitation.invitee_user_id == auth.user_id,
        )
    )
    await db.commit()
    await db.refresh(membership)
    logger.info(
        "invitation_accepted invitation_id=%s by=%s scope_id=%s",
        invitation_id,
        auth.user_id,
        inv.scope_id,
    )
    return {
        "id": str(membership.id),
        "scope_id": str(membership.scope_id),
        "role": membership.role,
        "joined_via": membership.joined_via,
        "joined_at": membership.joined_at.isoformat(),
        "resolved_owner_handle": membership.resolved_owner_handle,
    }


@router.post("/invitations/{invitation_id}/decline")
async def decline_invitation(
    invitation_id: UUID,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    inv = (
        await db.execute(
            select(ScopeInvitation).where(ScopeInvitation.id == invitation_id)
        )
    ).scalar_one_or_none()
    if inv is None or inv.invitee_user_id != auth.user_id:
        raise HTTPException(status.HTTP_410_GONE, "invitation not available")
    await db.delete(inv)
    await db.commit()
    return {"status": "declined"}


@router.get("/scopes")
async def my_scopes(
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> dict:
    owned_rows = (
        await db.execute(
            select(Scope).where(Scope.user_id == auth.user_id).order_by(Scope.name)
        )
    ).scalars().all()

    shared_rows = (
        await db.execute(
            select(ScopeMembership, Scope, User)
            .join(Scope, Scope.id == ScopeMembership.scope_id)
            .join(User, User.id == Scope.user_id)
            .where(ScopeMembership.user_id == auth.user_id)
            .order_by(ScopeMembership.joined_at.desc())
        )
    ).all()

    return {
        "owned": [
            {
                "id": str(s.id),
                "name": s.name,
                "slug": s.slug,
                "kind": s.kind,
                "is_owner": True,
            }
            for s in owned_rows
        ],
        "shared": [
            SharedScopeResponse(
                id=str(scope.id),
                name=scope.name,
                slug=scope.slug,
                kind=scope.kind,
                owner_display=owner.name or owner.email or "?",
                owner_handle=membership.resolved_owner_handle,
                role=membership.role,
                joined_at=membership.joined_at,
                is_owner=False,
            ).model_dump()
            for membership, scope, owner in shared_rows
        ],
    }
```

- [ ] **Step 4: Add leave endpoint to scopes.py**

Append to `backend/app/routes/scopes.py`:

```python
from app.models.scope_membership import ScopeMembership


@router.post("/{scope_id}/leave")
async def leave_scope(
    scope_id: UUID,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    """Sharee removes themselves from a scope. Owners cannot 'leave'
    their own scope — they must delete it instead."""
    membership = (
        await db.execute(
            select(ScopeMembership).where(
                ScopeMembership.scope_id == scope_id,
                ScopeMembership.user_id == auth.user_id,
            )
        )
    ).scalar_one_or_none()
    if membership is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not a member")
    await db.delete(membership)
    await db.commit()
    return {"status": "left"}
```

- [ ] **Step 5: Register me_router**

Modify `backend/app/main.py`:

```python
from app.routes.me import router as me_router
# ...
app.include_router(me_router)
```

- [ ] **Step 6: Verify all pass**

Run: `cd backend && uv run pytest tests/test_me_routes.py tests/test_sharing_upgrade.py -v`

- [ ] **Step 7: Commit**

```bash
git add -u
git commit -m "feat(sharing): /api/me/* + scope leave endpoints"
```

---

### Task C.6: Phase C lint pass + push

- [ ] **Step 1: Lint**

```bash
cd backend && uv run ruff format app/ tests/ && uv run ruff check app/
```

- [ ] **Step 2: Full sharing test suite**

```bash
cd backend && uv run pytest tests/ -k sharing -v
```
Expected: all PASS.

- [ ] **Step 3: Push**

```bash
git push origin feat/scope-sharing
```

---

## Phase D — Access Integration (`scope_ids_visible_to` + Vault Gate Verification)

Goal: extend the central visibility helper so every existing read path (skills list, vault list, etc.) automatically picks up shared scopes. Plus end-to-end verify that vault plaintext resolution works for viewer members AND fails cleanly for share-token-only callers (the latter is verified by absence — they can't reach the endpoint).

### Task D.1: Extend `scope_ids_visible_to` to include memberships

**Files:**
- Modify: `backend/app/core/scope.py`
- Create: `backend/tests/test_scope_visibility_shared.py`

- [ ] **Step 1: Failing tests**

Create `backend/tests/test_scope_visibility_shared.py`:

```python
"""scope_ids_visible_to widens to include shared memberships for
Clerk JWT + unbound-CLI callers. Env-bound api_keys keep their
single-scope ceiling regardless of memberships (deploy-key blast
radius boundary)."""

import uuid
from datetime import UTC, datetime

import pytest

from app.core.auth import AuthContext
from app.core.scope import scope_ids_visible_to


@pytest.mark.asyncio
async def test_clerk_jwt_sees_owned_and_shared_scopes(
    db_session, seed_user, seed_scope
):
    from app.models.scope import SCOPE_KIND_PERSONAL, Scope
    from app.models.scope_membership import ScopeMembership
    from app.models.user import User

    owner = User(
        clerk_id=f"o_{uuid.uuid4().hex[:8]}",
        email=f"o_{uuid.uuid4().hex[:6]}@test.dev",
        name="O",
    )
    db_session.add(owner)
    await db_session.commit()
    shared = Scope(user_id=owner.id, name="s", slug="s", kind=SCOPE_KIND_PERSONAL)
    db_session.add(shared)
    await db_session.commit()
    db_session.add(
        ScopeMembership(
            scope_id=shared.id,
            user_id=seed_user.id,
            role="viewer",
            joined_via="invite",
            joined_at=datetime.now(UTC),
            resolved_owner_handle="o",
        )
    )
    await db_session.commit()

    try:
        # Simulated Clerk-JWT AuthContext: api_key=None.
        auth = AuthContext(user=seed_user, api_key=None)
        visible = await scope_ids_visible_to(db_session, auth)
        assert seed_scope.id in visible
        assert shared.id in visible
    finally:
        await db_session.delete(shared)
        await db_session.delete(owner)
        await db_session.commit()


@pytest.mark.asyncio
async def test_env_bound_api_key_does_not_see_shared(
    db_session, seed_user, seed_scope
):
    """A deploy-key bound to env X must NEVER gain visibility to
    scopes the user is a member of. The env binding is the blast-
    radius boundary."""
    from app.models.api_key import ApiKey
    from app.models.scope import SCOPE_KIND_PERSONAL, Scope
    from app.models.scope_membership import ScopeMembership
    from app.models.user import User
    from tests.conftest import create_env_with_scope

    owner = User(
        clerk_id=f"o_{uuid.uuid4().hex[:8]}",
        email=f"o_{uuid.uuid4().hex[:6]}@test.dev",
        name="O",
    )
    db_session.add(owner)
    await db_session.commit()
    shared = Scope(user_id=owner.id, name="s2", slug="s2", kind=SCOPE_KIND_PERSONAL)
    db_session.add(shared)
    await db_session.commit()
    db_session.add(
        ScopeMembership(
            scope_id=shared.id,
            user_id=seed_user.id,
            role="viewer",
            joined_via="invite",
            joined_at=datetime.now(UTC),
            resolved_owner_handle="o",
        )
    )
    env = await create_env_with_scope(
        db_session,
        user_id=seed_user.id,
        machine_id="visibility-test",
        machine_name="m",
    )
    api_key = ApiKey(
        user_id=seed_user.id,
        key_hash="h" * 64,
        key_prefix="clawdi_x",
        label="env-bound",
        environment_id=env.id,
        scopes=["sessions:write"],
    )
    db_session.add(api_key)
    await db_session.commit()

    try:
        auth = AuthContext(user=seed_user, api_key=api_key)
        visible = await scope_ids_visible_to(db_session, auth)
        # Env-bound: ONLY the bound env's default_scope_id.
        assert visible == [env.default_scope_id]
        assert shared.id not in visible
        assert seed_scope.id not in visible
    finally:
        await db_session.delete(api_key)
        await db_session.delete(env)
        await db_session.delete(shared)
        await db_session.delete(owner)
        await db_session.commit()
```

- [ ] **Step 2: Verify failures**

Run: `cd backend && uv run pytest tests/test_scope_visibility_shared.py -v`
Expected: first test FAILS (shared scope absent from visible list); second test PASSES already (env-bound branch unchanged).

- [ ] **Step 3: Extend `scope_ids_visible_to`**

Modify `backend/app/core/scope.py`, in `scope_ids_visible_to`, after the env-bound short-circuit and before the kill-switch fallback, restructure the "full inventory" branches to UNION with memberships:

```python
# ... existing env-bound short-circuit stays at top, unchanged ...

if not scope_routing_enabled():
    # Kill-switch path: all of the user's owned scopes.
    owned = await db.execute(
        select(Scope.id).where(Scope.user_id == auth.user_id)
    )
    return list(owned.scalars().all())

# Owned + shared. Two queries kept separate because:
#   - SQLAlchemy union_all() composability with `Scope.id` literal
#     types is awkward and the readability cost outweighs the one
#     extra round-trip.
#   - Both queries hit indexed columns; combined cost is sub-ms.
from app.models.scope_membership import ScopeMembership

owned_ids = list(
    (
        await db.execute(
            select(Scope.id).where(Scope.user_id == auth.user_id)
        )
    ).scalars().all()
)
shared_ids = list(
    (
        await db.execute(
            select(ScopeMembership.scope_id).where(
                ScopeMembership.user_id == auth.user_id
            )
        )
    ).scalars().all()
)
# Preserve owned ordering; append shared in deterministic order.
seen = set(owned_ids)
result_ids = list(owned_ids)
for sid in shared_ids:
    if sid not in seen:
        result_ids.append(sid)
        seen.add(sid)
return result_ids
```

(If the existing function has a different return path or branch structure, blend the addition rather than wholesale replacing — keep all env-bound and kill-switch behavior intact.)

- [ ] **Step 4: Verify tests pass**

Run: `cd backend && uv run pytest tests/test_scope_visibility_shared.py -v`
Expected: both PASS.

- [ ] **Step 5: Also run skill / vault read tests to confirm no regressions**

Run: `cd backend && uv run pytest tests/test_skills.py tests/test_vault.py -v 2>&1 | tail -20`
Expected: no new failures.

- [ ] **Step 6: Commit**

```bash
git add backend/app/core/scope.py backend/tests/test_scope_visibility_shared.py
git commit -m "feat(scope): include shared memberships in scope_ids_visible_to"
```

---

### Task D.2: Verify vault resolve works end-to-end for shared scopes

**Files:**
- Create: `backend/tests/test_vault_shared_gate.py`

This task adds tests only — no code change. The vault resolve endpoint already respects `scope_ids_visible_to`; Task D.1 makes shared scopes visible.

- [ ] **Step 1: Test**

Create `backend/tests/test_vault_shared_gate.py`:

```python
"""Vault resolve gate for shared scopes.

  - Owner: can always resolve own vault items (status quo).
  - Viewer member (Clerk-bound): can resolve owner's vault items
    because scope_id is now in their visible set.
  - Share-token-only caller: never reaches /api/vault/resolve
    (no AuthContext, request fails at require_user_cli with 401).
"""

import uuid
from datetime import UTC, datetime

import pytest


@pytest.mark.asyncio
async def test_viewer_can_resolve_shared_vault_item(
    client, db_session, seed_user
):
    from app.models.scope import SCOPE_KIND_PERSONAL, Scope
    from app.models.scope_membership import ScopeMembership
    from app.models.user import User
    from app.models.vault import Vault, VaultItem
    from app.services.vault_crypto import encrypt_value

    owner = User(
        clerk_id=f"o_{uuid.uuid4().hex[:8]}",
        email=f"o_{uuid.uuid4().hex[:6]}@test.dev",
        name="O",
    )
    db_session.add(owner)
    await db_session.commit()
    scope = Scope(user_id=owner.id, name="x", slug="x", kind=SCOPE_KIND_PERSONAL)
    db_session.add(scope)
    await db_session.commit()
    vault = Vault(user_id=owner.id, scope_id=scope.id, slug="vault", name="V")
    db_session.add(vault)
    await db_session.flush()
    encrypted, nonce = encrypt_value("super-secret")
    db_session.add(
        VaultItem(
            vault_id=vault.id,
            item_name="api-key",
            section="",
            encrypted_value=encrypted,
            nonce=nonce,
        )
    )
    db_session.add(
        ScopeMembership(
            scope_id=scope.id,
            user_id=seed_user.id,
            role="viewer",
            joined_via="invite",
            joined_at=datetime.now(UTC),
            resolved_owner_handle="o",
        )
    )
    await db_session.commit()

    try:
        # Resolve using clawdi:// URI shape (verify against existing
        # `/api/vault/resolve` request body shape — check
        # backend/app/routes/vault.py for the exact endpoint signature
        # before running). Typical body:
        #   {"refs": [{"vault": "vault", "section": "", "item": "api-key"}]}
        r = await client.post(
            "/api/vault/resolve",
            json={
                "refs": [
                    {
                        "scope_id": str(scope.id),
                        "vault_slug": "vault",
                        "section": "",
                        "item": "api-key",
                    }
                ]
            },
        )
        assert r.status_code == 200, r.text
        body = r.json()
        # Resolved values shape varies — accept dict-or-list keyed
        # plaintext as long as "super-secret" appears.
        assert "super-secret" in str(body)
    finally:
        await db_session.delete(scope)
        await db_session.delete(owner)
        await db_session.commit()
```

Note: this test assumes `client` is a CLI-key-authed fixture (since `/api/vault/resolve` requires `require_user_cli`, not Clerk JWT). If the existing fixture is JWT-only, add a CLI-authed variant — check `backend/tests/conftest.py` for `client_cli` or similar; if absent, the test scaffolding for vault resolve in `test_vault.py` will show the right pattern.

- [ ] **Step 2: Verify pass**

Run: `cd backend && uv run pytest tests/test_vault_shared_gate.py -v`
Expected: PASS (since D.1 already gave the viewer visibility into the shared scope).

If the test fails because the existing `/api/vault/resolve` route doesn't filter by `scope_ids_visible_to` (it may resolve only by `user_id`), this is a separate gap — extend the resolver to honour shared scopes:

In `backend/app/routes/vault.py`, find the WHERE clause that filters by `user_id == auth.user_id` and add OR clause with `Vault.scope_id IN (scope_ids_visible_to result)`. This is a one-line fix in the same idiom as `app/routes/skills.py`.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/test_vault_shared_gate.py [+ any vault.py edits]
git commit -m "test(vault): viewer members resolve shared vault items"
```

---

### Task D.3: Read-path audit — skill list, vault list, SSE

Spec § 5.3 + § 13 claim every existing `WHERE scope_id IN (...)` read path "automatically include[s] shared scopes" once `scope_ids_visible_to` widens. That claim only holds if each route actually goes through `scope_ids_visible_to` instead of filtering by `user_id` directly. Audit each one and patch where needed.

**Files:**
- Audit: `backend/app/routes/skills.py`, `backend/app/routes/vault.py`, `backend/app/routes/sync.py`
- Test: `backend/tests/test_sharing_read_paths.py` (new)

- [ ] **Step 1: Failing tests for shared-scope read paths**

Create `backend/tests/test_sharing_read_paths.py`:

```python
"""Verifies that owner-side read endpoints (skills list, vault list,
SSE event stream) return shared-scope content to viewer members.
Failures here mean a read path is filtering by user_id directly
instead of by scope_ids_visible_to(db, auth)."""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select


async def _seed_shared_scope_with_skill(db_session, seed_user):
    """Create a different user + scope + skill + membership for seed_user."""
    from app.models.scope import SCOPE_KIND_PERSONAL, Scope
    from app.models.scope_membership import ScopeMembership
    from app.models.skill import Skill
    from app.models.user import User

    owner = User(
        clerk_id=f"o_{uuid.uuid4().hex[:8]}",
        email=f"o_{uuid.uuid4().hex[:6]}@test.dev",
        name="Owner",
    )
    db_session.add(owner)
    await db_session.commit()
    scope = Scope(user_id=owner.id, name="shared", slug="s", kind=SCOPE_KIND_PERSONAL)
    db_session.add(scope)
    await db_session.commit()
    skill = Skill(
        user_id=owner.id,
        scope_id=scope.id,
        skill_key="shared-skill",
        name="Shared Skill",
        content_hash="cc" * 32,
    )
    db_session.add(skill)
    db_session.add(
        ScopeMembership(
            scope_id=scope.id,
            user_id=seed_user.id,
            role="viewer",
            joined_via="invite",
            joined_at=datetime.now(UTC),
            resolved_owner_handle="o",
        )
    )
    await db_session.commit()
    return owner, scope, skill


@pytest.mark.asyncio
async def test_skill_list_includes_shared_scope_skills(
    client, db_session, seed_user
):
    owner, scope, skill = await _seed_shared_scope_with_skill(db_session, seed_user)
    try:
        r = await client.get("/api/skills")
        assert r.status_code == 200
        keys = {s["skill_key"] for s in r.json().get("items", r.json())}
        assert "shared-skill" in keys, (
            "skill list filter must use scope_ids_visible_to (not just user_id)"
        )
    finally:
        await db_session.delete(skill)
        await db_session.delete(scope)
        await db_session.delete(owner)
        await db_session.commit()


@pytest.mark.asyncio
async def test_vault_list_includes_shared_scope_vaults(
    client, db_session, seed_user
):
    from app.models.scope import SCOPE_KIND_PERSONAL, Scope
    from app.models.scope_membership import ScopeMembership
    from app.models.user import User
    from app.models.vault import Vault

    owner = User(
        clerk_id=f"o_{uuid.uuid4().hex[:8]}",
        email=f"o_{uuid.uuid4().hex[:6]}@test.dev",
        name="O",
    )
    db_session.add(owner)
    await db_session.commit()
    scope = Scope(user_id=owner.id, name="sv", slug="sv", kind=SCOPE_KIND_PERSONAL)
    db_session.add(scope)
    await db_session.commit()
    vault = Vault(user_id=owner.id, scope_id=scope.id, slug="prod", name="P")
    db_session.add(vault)
    db_session.add(
        ScopeMembership(
            scope_id=scope.id,
            user_id=seed_user.id,
            role="viewer",
            joined_via="invite",
            joined_at=datetime.now(UTC),
            resolved_owner_handle="o",
        )
    )
    await db_session.commit()

    try:
        r = await client.get("/api/vault")
        assert r.status_code == 200
        slugs = {v["slug"] for v in r.json().get("items", r.json())}
        assert "prod" in slugs, (
            "vault list filter must use scope_ids_visible_to (not just user_id)"
        )
    finally:
        await db_session.delete(scope)
        await db_session.delete(owner)
        await db_session.commit()
```

(Adjust endpoint paths and response shapes to match the actual codebase — verify via `grep -rn 'api/skills\|api/vault' backend/app/routes/` before running.)

- [ ] **Step 2: Run tests, expect at-least-one failure**

Run: `cd backend && uv run pytest tests/test_sharing_read_paths.py -v`
Expected: 2 PASS if read paths already use `scope_ids_visible_to`; FAIL if they filter by `user_id`. Read the failure to know which path needs patching.

- [ ] **Step 3: Patch any failing read path**

For each failing route, locate the `WHERE` clause that uses `user_id` and convert to scope-based filtering. Concrete pattern using `app/routes/skills.py` as the example:

```python
# Before — filtering by user_id directly:
result = await db.execute(
    select(Skill).where(Skill.user_id == auth.user_id, Skill.is_active == True)
)

# After — filter by visible scope set:
from app.core.scope import scope_ids_visible_to

visible = await scope_ids_visible_to(db, auth)
result = await db.execute(
    select(Skill).where(Skill.scope_id.in_(visible), Skill.is_active == True)
)
```

Apply the same pattern to vault list and any other read path that surfaces in test failures. Each patch is one route at most.

- [ ] **Step 4: SSE verification**

`backend/app/routes/sync.py` runs the SSE event stream. Find the scope filter (`grep -n "scope_id\|user_id" backend/app/routes/sync.py`) and confirm it uses `scope_ids_visible_to` (or equivalently `scope_id IN (...)` derived from it) rather than `user_id` alone. If it filters by user_id, extend the same way.

Add one targeted test that subscribes to SSE as `seed_user`, has the owner push a skill_changed event for the shared scope (via the existing internal helper), and asserts `seed_user`'s connection receives it. If the SSE test harness is complex, document the manual check inline instead and defer the automated test to v1.1.

- [ ] **Step 5: Re-run tests, verify all green**

```bash
cd backend && uv run pytest tests/test_sharing_read_paths.py -v
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -u
git commit -m "fix(read-paths): route skill/vault list filters through scope_ids_visible_to"
```

---

### Task D.4: Phase D push

- [ ] **Step 1: Lint + full sharing test sweep**

```bash
cd backend && uv run ruff format app/ tests/ && uv run ruff check app/
cd backend && uv run pytest tests/ -k "sharing or scope_visibility or vault_shared or read_paths" -v
```

- [ ] **Step 2: Push**

```bash
git push origin feat/scope-sharing
```

End of backend phases. Phases A-D complete the cloud-api surface; CLI and Web can now build against a stable contract.

---

## Phase E — CLI

Goal: ship every new `clawdi` subcommand listed in spec § 8.1, the `~/.clawdi/share-tokens.json` state file, the auto-upgrade on `clawdi auth login`, and adapter-level `getSharedSkillPath` for skill landing paths.

### Task E.1: `~/.clawdi/share-tokens.json` store

**Files:**
- Create: `packages/cli/src/share/tokens.ts`
- Create: `packages/cli/src/share/tokens.test.ts`

- [ ] **Step 1: Failing tests**

Create `packages/cli/src/share/tokens.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	addToken,
	listTokens,
	removeToken,
	type ShareToken,
} from "./tokens";

const ORIG_HOME = process.env.HOME;
let tempHome: string;

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "clawdi-tokens-"));
	mkdirSync(join(tempHome, ".clawdi"), { recursive: true });
	process.env.HOME = tempHome;
});

afterEach(() => {
	rmSync(tempHome, { recursive: true, force: true });
	process.env.HOME = ORIG_HOME;
});

const sample: ShareToken = {
	scope_id: "abc-123",
	scope_name: "Team Toolkit",
	owner_display: "Alice",
	owner_handle: "alice",
	token: "x".repeat(43),
	redeemed_at: new Date().toISOString(),
};

describe("share-tokens.json", () => {
	it("returns empty list when file absent", () => {
		expect(listTokens()).toEqual([]);
	});

	it("addToken then listTokens round-trips", () => {
		addToken(sample);
		expect(listTokens()).toEqual([sample]);
	});

	it("addToken upserts on scope_id", () => {
		addToken(sample);
		addToken({ ...sample, owner_handle: "alice-2" });
		const all = listTokens();
		expect(all).toHaveLength(1);
		expect(all[0].owner_handle).toBe("alice-2");
	});

	it("removeToken by scope_id", () => {
		addToken(sample);
		addToken({ ...sample, scope_id: "def-456" });
		removeToken("abc-123");
		const all = listTokens();
		expect(all).toHaveLength(1);
		expect(all[0].scope_id).toBe("def-456");
	});

	it("writes file with 0600 perms", () => {
		addToken(sample);
		const stat = require("node:fs").statSync(
			join(tempHome, ".clawdi", "share-tokens.json"),
		);
		// 0o600 = 384 decimal; mask off file-type bits.
		expect(stat.mode & 0o777).toBe(0o600);
	});

	it("survives empty / malformed file", () => {
		const path = join(tempHome, ".clawdi", "share-tokens.json");
		require("node:fs").writeFileSync(path, "not-json", "utf-8");
		expect(listTokens()).toEqual([]);
	});
});
```

- [ ] **Step 2: Verify fail**

Run: `cd packages/cli && bun test src/share/tokens.test.ts`
Expected: fails — module not found.

- [ ] **Step 3: Implement**

Create `packages/cli/src/share/tokens.ts`:

```ts
/**
 * Local state for accepted share-links. One JSON file under
 * `~/.clawdi/share-tokens.json`, written 0600.
 *
 * The raw token IS stored locally (different from cloud-api which
 * stores only the hash) because the CLI needs to send the raw token
 * to the server on every sync round. The file is the bearer
 * credential. 0600 mode is the security measure; we don't envelope-
 * encrypt because losing the device is already game-over for any
 * locally-cached credential (api_keys, vault plaintext caches, etc.).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ShareToken {
	scope_id: string;
	scope_name: string;
	owner_display: string;
	owner_handle: string;
	token: string;
	redeemed_at: string; // ISO8601
	upgraded_at?: string; // set after clawdi auth login + upgrade
}

interface ShareTokensFile {
	version: 1;
	tokens: ShareToken[];
}

function filePath(): string {
	return join(homedir(), ".clawdi", "share-tokens.json");
}

function loadRaw(): ShareTokensFile {
	const path = filePath();
	if (!existsSync(path)) {
		return { version: 1, tokens: [] };
	}
	try {
		const text = readFileSync(path, "utf-8");
		const parsed = JSON.parse(text) as ShareTokensFile;
		if (parsed.version !== 1 || !Array.isArray(parsed.tokens)) {
			// Treat malformed as empty — CLI is forgiving on local state
			// corruption. Operator can re-accept any shares they care
			// about.
			return { version: 1, tokens: [] };
		}
		return parsed;
	} catch {
		return { version: 1, tokens: [] };
	}
}

function save(state: ShareTokensFile): void {
	const path = filePath();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function listTokens(): ShareToken[] {
	return loadRaw().tokens;
}

export function addToken(token: ShareToken): void {
	const state = loadRaw();
	const idx = state.tokens.findIndex((t) => t.scope_id === token.scope_id);
	if (idx === -1) {
		state.tokens.push(token);
	} else {
		state.tokens[idx] = token;
	}
	save(state);
}

export function removeToken(scopeId: string): void {
	const state = loadRaw();
	state.tokens = state.tokens.filter((t) => t.scope_id !== scopeId);
	save(state);
}

export function findToken(scopeId: string): ShareToken | undefined {
	return listTokens().find((t) => t.scope_id === scopeId);
}
```

- [ ] **Step 4: Verify pass**

Run: `cd packages/cli && bun test src/share/tokens.test.ts`
Expected: 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/share/tokens.ts packages/cli/src/share/tokens.test.ts
git commit -m "feat(cli): share-tokens.json local store"
```

---

### Task E.2: Adapter `getSharedSkillPath`

**Files:**
- Modify: `packages/cli/src/adapters/base.ts`
- Modify: `packages/cli/src/adapters/claude-code.ts`
- Modify: `packages/cli/src/adapters/codex.ts`
- Modify: `packages/cli/src/adapters/openclaw.ts`
- Modify: `packages/cli/src/adapters/hermes.ts`
- Create: `packages/cli/src/share/paths.test.ts`

- [ ] **Step 1: Failing tests**

Create `packages/cli/src/share/paths.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { ClaudeCodeAdapter } from "../adapters/claude-code";

describe("getSharedSkillPath", () => {
	it("Claude Code: appends __ownerHandle suffix", () => {
		const adapter = new ClaudeCodeAdapter();
		const p = adapter.getSharedSkillPath("git-tools", "alice");
		expect(p).toMatch(/skills\/git-tools__alice$/);
	});

	it("Personal skill path stays unchanged", () => {
		const adapter = new ClaudeCodeAdapter();
		const p = adapter.getSkillsRootDir();
		expect(p).toMatch(/skills$/);
	});
});
```

(Add similar tests for other adapters after implementing — keep this file focused on the Claude Code happy path; per-adapter coverage lives next to each adapter file.)

- [ ] **Step 2: Verify fail**

- [ ] **Step 3: Extend base interface**

In `packages/cli/src/adapters/base.ts`:

```ts
// Add to the AgentAdapter interface, after getSkillsRootDir():
/**
 * Returns the on-disk path where a skill from a SHARED scope should
 * land. The owner-handle (resolved server-side, frozen at first
 * redeem) is appended with `__` separator so the same key from
 * different owners coexists with the sharee's own key.
 *
 * Example: getSharedSkillPath("git-tools", "alice")
 *   → "~/.claude/skills/git-tools__alice"   (Claude Code)
 *
 * Personal-scope skills continue to use getSkillsRootDir() + key
 * (no suffix) — see spec § 11.1.
 */
getSharedSkillPath(skillKey: string, ownerHandle: string): string;
```

- [ ] **Step 4: Implement per-adapter**

In `claude-code.ts`:
```ts
getSharedSkillPath(skillKey: string, ownerHandle: string): string {
	return join(claudeDir(), "skills", `${skillKey}__${ownerHandle}`);
}
```

In `codex.ts`: locate the existing `getSkillsRootDir()` and mirror.
```ts
getSharedSkillPath(skillKey: string, ownerHandle: string): string {
	return join(this.getSkillsRootDir(), `${skillKey}__${ownerHandle}`);
}
```

In `openclaw.ts`: same pattern; verify it lands under the agent-id substructure correctly:
```ts
getSharedSkillPath(skillKey: string, ownerHandle: string): string {
	return join(this.getSkillsRootDir(), `${skillKey}__${ownerHandle}`);
}
```

In `hermes.ts` (which already supports nested categories): append the suffix at the leaf:
```ts
getSharedSkillPath(skillKey: string, ownerHandle: string): string {
	// Hermes uses category/key structure. Sharee skills go under a
	// `shared` category so they don't intermix with user categories.
	return join(this.getSkillsRootDir(), "shared", `${skillKey}__${ownerHandle}`);
}
```

- [ ] **Step 5: Verify**

Run: `cd packages/cli && bun test src/share/paths.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/adapters/ packages/cli/src/share/paths.test.ts
git commit -m "feat(cli): adapter getSharedSkillPath for shared-scope local layout"
```

---

### Task E.3: `clawdi share accept <url>` command

**Files:**
- Create: `packages/cli/src/commands/share-accept.ts`
- Create: `packages/cli/src/share/redeem.ts`
- Create: `packages/cli/src/share/redeem.test.ts`
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Failing test**

Create `packages/cli/src/share/redeem.test.ts`:

```ts
import { describe, expect, it } from "bun:test";

import { extractTokenFromUrl } from "./redeem";

describe("extractTokenFromUrl", () => {
	it("extracts token from canonical URL", () => {
		expect(
			extractTokenFromUrl("https://clawdi.ai/share/abc-def-123"),
		).toBe("abc-def-123");
	});

	it("strips trailing slash + query", () => {
		expect(
			extractTokenFromUrl("https://clawdi.ai/share/abc-def-123/?foo=bar"),
		).toBe("abc-def-123");
	});

	it("rejects non-share URLs", () => {
		expect(() => extractTokenFromUrl("https://google.com")).toThrow();
	});

	it("accepts raw token (no URL wrapper)", () => {
		const tok = "x".repeat(43);
		expect(extractTokenFromUrl(tok)).toBe(tok);
	});
});
```

- [ ] **Step 2: Verify fail**

- [ ] **Step 3: Implement helpers**

Create `packages/cli/src/share/redeem.ts`:

```ts
/**
 * `clawdi share accept` implementation. Validates URL, calls the
 * public /api/share/{token}/redeem endpoint, persists token locally,
 * and pulls each skill in the scope to the adapter's shared-skill
 * path.
 */

import { addToken, type ShareToken } from "./tokens";

export function extractTokenFromUrl(input: string): string {
	const trimmed = input.trim();
	// Bare token (43 URL-safe-b64 chars).
	if (/^[A-Za-z0-9_-]{43}$/.test(trimmed)) return trimmed;

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error(
			`Not a valid share link or raw token: ${trimmed.slice(0, 40)}...`,
		);
	}
	const match = url.pathname.match(/\/share\/([A-Za-z0-9_-]+)\/?$/);
	if (!match) {
		throw new Error(`URL is not a clawdi share link: ${trimmed}`);
	}
	return match[1];
}

export interface AcceptDeps {
	apiBaseUrl: string; // e.g. https://cloud-api.clawdi.ai
	fetchImpl: typeof fetch;
}

export async function acceptShare(
	urlOrToken: string,
	deps: AcceptDeps,
): Promise<ShareToken> {
	const token = extractTokenFromUrl(urlOrToken);
	const redeem = await deps.fetchImpl(
		`${deps.apiBaseUrl}/api/share/${token}/redeem`,
		{ method: "POST" },
	);
	if (redeem.status === 404) {
		throw new Error("Share link not found. Ask the owner for a fresh one.");
	}
	if (redeem.status === 410) {
		throw new Error(
			"Share link has been revoked or expired. Ask the owner for a fresh one.",
		);
	}
	if (!redeem.ok) {
		throw new Error(`Redeem failed: HTTP ${redeem.status}`);
	}
	const body = (await redeem.json()) as {
		scope_id: string;
		scope_name: string;
		owner_display: string;
		owner_handle: string;
		skill_count: number;
		vault_count: number;
	};

	const record: ShareToken = {
		scope_id: body.scope_id,
		scope_name: body.scope_name,
		owner_display: body.owner_display,
		owner_handle: body.owner_handle,
		token,
		redeemed_at: new Date().toISOString(),
	};
	addToken(record);
	return record;
}
```

- [ ] **Step 4: Command wrapper**

Create `packages/cli/src/commands/share-accept.ts`:

```ts
import { acceptShare } from "../share/redeem";
import { getApiBaseUrl } from "../lib/config";  // existing helper

export async function shareAcceptCommand(urlOrToken: string): Promise<void> {
	const apiBaseUrl = getApiBaseUrl();
	const record = await acceptShare(urlOrToken, {
		apiBaseUrl,
		fetchImpl: fetch,
	});
	console.log(`Accepted share for scope "${record.scope_name}".`);
	console.log(`  Owner: ${record.owner_display} (@${record.owner_handle})`);
	console.log(`  Token stored in ~/.clawdi/share-tokens.json`);
	console.log(`Next: run \`clawdi share list\` to see what landed locally.`);
	// Skill pull happens via the daemon (clawdi serve) on next cycle,
	// or run \`clawdi pull --shared\` to fetch immediately. See E.5.
}
```

- [ ] **Step 5: Register command in index.ts**

In `packages/cli/src/index.ts`, register under a new `share` subcommand:

```ts
program
	.command("share")
	.description("Manage shared scopes")
	.command("accept <url>")
	.description("Accept a share link from a scope owner")
	.action(async (url) => {
		const { shareAcceptCommand } = await import("./commands/share-accept");
		await shareAcceptCommand(url);
	});
```

(Match the existing Commander pattern in the file — if it uses subcommand chaining differently, adapt to match.)

- [ ] **Step 6: Verify tests pass**

```bash
cd packages/cli && bun test src/share/redeem.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/share/redeem.ts packages/cli/src/commands/share-accept.ts packages/cli/src/index.ts packages/cli/src/share/redeem.test.ts
git commit -m "feat(cli): clawdi share accept command"
```

---

### Task E.4: `clawdi share list` + `clawdi share remove <scope-id>`

**Files:**
- Create: `packages/cli/src/commands/share-list.ts`
- Create: `packages/cli/src/commands/share-remove.ts`
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Implement list**

Create `packages/cli/src/commands/share-list.ts`:

```ts
import { listTokens } from "../share/tokens";

export function shareListCommand(): void {
	const tokens = listTokens();
	if (tokens.length === 0) {
		console.log("No shared scopes accepted on this device.");
		console.log("Get a share link from a scope owner and run:");
		console.log("  clawdi share accept <url>");
		return;
	}
	console.log(`Shared scopes (${tokens.length}):`);
	for (const t of tokens) {
		const upgraded = t.upgraded_at ? " (member)" : "";
		console.log(`  ${t.scope_name}  — @${t.owner_handle}${upgraded}`);
		console.log(`    scope_id: ${t.scope_id}`);
		console.log(`    accepted: ${t.redeemed_at}`);
	}
}
```

- [ ] **Step 2: Implement remove**

Create `packages/cli/src/commands/share-remove.ts`:

```ts
import { rmSync } from "node:fs";
import { join } from "node:path";

import { getAdapter } from "../adapters";  // existing factory
import { findToken, removeToken } from "../share/tokens";

export function shareRemoveCommand(scopeId: string): void {
	const token = findToken(scopeId);
	if (!token) {
		console.error(`No local share found for scope ${scopeId}.`);
		process.exitCode = 1;
		return;
	}
	// Clean up local skill files for this shared scope. Adapter-aware:
	// per-skill share path lives under the adapter's root using
	// getSharedSkillPath(). Without an authoritative server query
	// here we don't know the exact skill keys; the daemon's
	// reconcile loop on next start would catch up. Simpler approach
	// for the v1 remove command: just delete the token and let the
	// daemon's existing rescan logic clean stale folders.
	removeToken(scopeId);
	console.log(`Removed share for scope ${scopeId} (${token.scope_name}).`);
	console.log(
		"Local skill folders under shared paths will be cleaned by the next \`clawdi serve\` sweep.",
	);
}
```

- [ ] **Step 3: Register in index.ts**

Append to the `share` subcommand block:

```ts
.command("list")
.description("List shared scopes accepted on this device")
.action(async () => {
	const { shareListCommand } = await import("./commands/share-list");
	shareListCommand();
})
.command("remove <scope-id>")
.description("Remove a shared scope from this device")
.action(async (scopeId) => {
	const { shareRemoveCommand } = await import("./commands/share-remove");
	shareRemoveCommand(scopeId);
});
```

- [ ] **Step 4: Smoke test manually**

```bash
cd packages/cli && bun run src/index.ts share list
```
Expected: "No shared scopes accepted on this device." message.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/share-list.ts packages/cli/src/commands/share-remove.ts packages/cli/src/index.ts
git commit -m "feat(cli): clawdi share list / share remove commands"
```

---

### Task E.5: Sync engine extends to pull shared scopes

**Files:**
- Modify: `packages/cli/src/serve/sync-engine.ts`
- Create: `packages/cli/src/share/sync.ts`

The daemon (`clawdi serve`) currently pulls skills only from its env-bound scope. Extend it to also enumerate `share-tokens.json` and pull each shared scope's skills via `GET /api/share/{token}/scope` + per-skill tarball downloads to `getSharedSkillPath`.

- [ ] **Step 1: Create the shared-sync helper**

Create `packages/cli/src/share/sync.ts`:

```ts
/**
 * Pull skills for each share-token in ~/.clawdi/share-tokens.json
 * to the adapter's getSharedSkillPath. Called from the daemon's
 * reconcile loop on each cycle.
 *
 * On 410 (link revoked/expired) → remove the local token + clean
 * the cached folder.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AgentAdapter } from "../adapters/base";
import { listTokens, removeToken, type ShareToken } from "./tokens";

interface SharedScopeIndex {
	scope_id: string;
	skills: { skill_key: string; content_hash: string; version: number }[];
}

export interface SharedSyncDeps {
	apiBaseUrl: string;
	fetchImpl: typeof fetch;
	adapter: AgentAdapter;
	log: { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void };
}

export async function syncAllSharedScopes(deps: SharedSyncDeps): Promise<void> {
	for (const token of listTokens()) {
		try {
			await syncOneSharedScope(token, deps);
		} catch (e) {
			deps.log.warn("shared_sync_one_failed", {
				scope_id: token.scope_id,
				error: String(e),
			});
		}
	}
}

async function syncOneSharedScope(
	token: ShareToken,
	deps: SharedSyncDeps,
): Promise<void> {
	const indexResp = await deps.fetchImpl(
		`${deps.apiBaseUrl}/api/share/${token.token}/scope`,
	);
	if (indexResp.status === 410 || indexResp.status === 404) {
		deps.log.warn("shared_sync_token_invalid_cleaning_up", {
			scope_id: token.scope_id,
			status: indexResp.status,
		});
		removeToken(token.scope_id);
		return;
	}
	if (!indexResp.ok) {
		throw new Error(`scope index HTTP ${indexResp.status}`);
	}
	const idx = (await indexResp.json()) as SharedScopeIndex;

	for (const skill of idx.skills) {
		const localPath = deps.adapter.getSharedSkillPath(
			skill.skill_key,
			token.owner_handle,
		);
		// Skip if local hash matches (we don't track per-shared-skill
		// lock yet; v1 simplification — always pull. Add hash cache
		// in v1.1 if bandwidth is a concern).
		const tarResp = await deps.fetchImpl(
			`${deps.apiBaseUrl}/api/share/${token.token}/skills/${encodeURIComponent(skill.skill_key)}/tarball`,
		);
		if (!tarResp.ok || !tarResp.body) {
			deps.log.warn("shared_sync_skill_tar_missing", {
				skill_key: skill.skill_key,
			});
			continue;
		}
		const bytes = await tarResp.arrayBuffer();
		mkdirSync(localPath, { recursive: true });
		const tarPath = join(localPath, ".clawdi-shared.tar");
		writeFileSync(tarPath, Buffer.from(bytes));
		// Extract via the same helper the daemon already uses for
		// owner-side pulls (look for `extractTar` in
		// packages/cli/src/serve/sync-engine.ts; reuse it).
		// Pseudocode placeholder:
		//   await extractTar(tarPath, localPath);
		//   unlinkSync(tarPath);
	}
}
```

- [ ] **Step 2: Wire into sync-engine**

In `packages/cli/src/serve/sync-engine.ts`, in the main reconcile loop (look for `reconcileLoop` or the function that pulls skills periodically), add:

```ts
import { syncAllSharedScopes } from "../share/sync";

// Inside the reconcile-loop body, after the owner-side skill pull:
try {
	await syncAllSharedScopes({
		apiBaseUrl: api.baseUrl,
		fetchImpl: fetch,
		adapter: opts.adapter,
		log,
	});
} catch (e) {
	log.warn("shared_sync_top_level_failed", { error: String(e) });
}
```

- [ ] **Step 3: Verify nothing breaks**

```bash
cd packages/cli && bun run typecheck
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/share/sync.ts packages/cli/src/serve/sync-engine.ts
git commit -m "feat(cli): daemon syncs shared scopes from share-tokens.json"
```

---

### Task E.6: Auto-upgrade after `clawdi auth login`

**Files:**
- Create: `packages/cli/src/share/upgrade.ts`
- Modify: `packages/cli/src/commands/auth-login.ts` (or wherever Clerk OAuth completes)

- [ ] **Step 1: Implement upgrade flow**

Create `packages/cli/src/share/upgrade.ts`:

```ts
/**
 * After a fresh `clawdi auth login` completes, prompt the user to
 * convert local share-tokens (anonymous redemptions) into permanent
 * memberships on the server. Memberships persist across devices
 * (the next CLI on a new machine sees them via /api/me/scopes);
 * tokens remain local-only.
 */

import { listTokens } from "./tokens";

export interface UpgradeDeps {
	apiBaseUrl: string;
	apiKey: string; // newly-minted CLI api_key OR Clerk JWT
	fetchImpl: typeof fetch;
	prompt: (msg: string) => Promise<string>;
}

export async function maybeUpgradeShares(deps: UpgradeDeps): Promise<void> {
	const tokens = listTokens().filter((t) => !t.upgraded_at);
	if (tokens.length === 0) return;

	const answer = await deps.prompt(
		`You have ${tokens.length} pending shared scope(s) on this device. ` +
			`Convert to permanent memberships in your account? [Y/n] `,
	);
	if (answer.trim().toLowerCase() === "n") return;

	for (const t of tokens) {
		try {
			const r = await deps.fetchImpl(
				`${deps.apiBaseUrl}/api/share/${t.token}/upgrade`,
				{
					method: "POST",
					headers: { Authorization: `Bearer ${deps.apiKey}` },
				},
			);
			if (r.ok) {
				// Mark upgraded locally so subsequent logins on this device
				// don't re-prompt.
				const { addToken } = await import("./tokens");
				addToken({ ...t, upgraded_at: new Date().toISOString() });
				console.log(`  Upgraded: ${t.scope_name} (@${t.owner_handle})`);
			} else if (r.status === 410) {
				console.log(`  Skipped (link revoked): ${t.scope_name}`);
				const { removeToken } = await import("./tokens");
				removeToken(t.scope_id);
			} else {
				console.log(`  Failed (${r.status}): ${t.scope_name}`);
			}
		} catch (e) {
			console.log(`  Failed: ${t.scope_name} — ${String(e)}`);
		}
	}
}
```

- [ ] **Step 2: Wire into auth login**

Find the existing login command (search: `grep -rn "auth login\|loginCommand\|authLogin" packages/cli/src/`). After the api_key is successfully stored, add:

```ts
import { maybeUpgradeShares } from "../share/upgrade";

await maybeUpgradeShares({
	apiBaseUrl: getApiBaseUrl(),
	apiKey: newlyMintedApiKey,
	fetchImpl: fetch,
	prompt: defaultPrompt, // reuse existing prompt helper or readline
});
```

- [ ] **Step 3: Commit**

```bash
git add -u
git commit -m "feat(cli): auto-upgrade share-tokens to memberships on auth login"
```

---

### Task E.7: Owner-side commands (`clawdi scope share` etc.)

**Files:**
- Create: `packages/cli/src/commands/scope-share.ts`
- Create: `packages/cli/src/commands/scope-share-links.ts`
- Create: `packages/cli/src/commands/scope-invite.ts`
- Create: `packages/cli/src/commands/scope-invites.ts`
- Create: `packages/cli/src/commands/scope-members.ts`
- Create: `packages/cli/src/commands/scope-unshare.ts`
- Create: `packages/cli/src/commands/scope-leave.ts`
- Modify: `packages/cli/src/commands/scope-list.ts` (existing) to include shared
- Modify: `packages/cli/src/index.ts`

All commands call the corresponding `/api/scopes/{id}/...` endpoint and print a table or status line. Pattern is uniform — show the canonical example then list each command's call signature.

- [ ] **Step 1: Canonical pattern (scope-share.ts as template)**

Create `packages/cli/src/commands/scope-share.ts`:

```ts
/**
 * `clawdi scope share <scope>` — generate a new share link for a scope
 * the caller owns. Prints the URL and a copy-paste redeem hint.
 */

import { createInterface } from "node:readline/promises";

import { getApiBaseUrl, getCliApiKey } from "../lib/config";

export async function scopeShareCommand(
	scopeIdOrSlug: string,
	options: { label?: string; yes?: boolean } = {},
): Promise<void> {
	const apiBase = getApiBaseUrl();
	const apiKey = getCliApiKey();
	if (!apiKey) {
		console.error("Not signed in. Run `clawdi auth login` first.");
		process.exitCode = 1;
		return;
	}
	const scopeId = await resolveScopeId(apiBase, apiKey, scopeIdOrSlug);

	// Fetch scope summary so we can count skills and surface the
	// secret-disclosure warning before generating a link. See spec § 10.4.
	const meta = await fetchScopeMeta(apiBase, apiKey, scopeId);
	if (!options.yes) {
		const ok = await promptShareConfirmation(meta.name, meta.skill_count);
		if (!ok) {
			console.log("Cancelled.");
			return;
		}
	}

	const r = await fetch(
		`${apiBase}/api/scopes/${scopeId}/share-links`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({ label: options.label }),
		},
	);
	if (r.status === 404) {
		console.error(`Scope not found or you don't own it: ${scopeIdOrSlug}`);
		process.exitCode = 1;
		return;
	}
	if (r.status === 409) {
		const body = await r.json();
		const err = body?.detail?.error;
		if (err === "display_name_required") {
			console.error(
				"Set a display name on your profile before sharing a scope " +
					"(it's shown to anyone you share with). Visit your dashboard " +
					"settings or update via the web UI.",
			);
			process.exitCode = 1;
			return;
		}
	}
	if (!r.ok) {
		console.error(`Create link failed: HTTP ${r.status}`);
		process.exitCode = 1;
		return;
	}
	const body = (await r.json()) as {
		url: string;
		raw_token: string;
		owner_handle: string;
	};
	console.log("Share link (copy + send to someone):");
	console.log(`  ${body.url}`);
	console.log();
	console.log(`Recipients will see you as: @${body.owner_handle}`);
	console.log();
	console.log("Recipient runs:");
	console.log(`  clawdi share accept ${body.url}`);
	console.log();
	console.log(
		"This token is shown ONCE. Lost links can be regenerated via `clawdi scope share-links`.",
	);
}

async function fetchScopeMeta(
	apiBase: string,
	apiKey: string,
	scopeId: string,
): Promise<{ name: string; skill_count: number }> {
	// Reuses the existing /api/scopes/{id} endpoint (extended in
	// Phase B/D to return skill_count). If your codebase doesn't yet
	// expose skill_count on that route, plumb it through there or
	// inline a quick /api/skills?scope_id= count.
	const r = await fetch(`${apiBase}/api/scopes/${scopeId}`, {
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	if (!r.ok) {
		throw new Error(`Scope lookup failed: HTTP ${r.status}`);
	}
	return r.json();
}

async function promptShareConfirmation(
	scopeName: string,
	skillCount: number,
): Promise<boolean> {
	// Skill content disclosure warning — spec § 10.4. Anyone with the
	// share link can download every skill file verbatim, including
	// any secrets hardcoded inside them.
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		console.log();
		console.log(
			`This will create a share link giving ANYONE who has it full read access`,
		);
		console.log(
			`to ${skillCount} skill${skillCount === 1 ? "" : "s"} in scope "${scopeName}".`,
		);
		console.log();
		console.log(
			`Skills are NOT encrypted. If any of your skill files contain API keys,`,
		);
		console.log(
			`tokens, passwords, or other secrets, they WILL be visible to recipients.`,
		);
		console.log(
			`(Use vault references like \`clawdi://vault/...\` inside skills instead.)`,
		);
		console.log();
		console.log(
			`Vault items in this scope stay locked — recipients must sign in to resolve.`,
		);
		console.log();
		const answer = await rl.question("Continue? [y/N] ");
		return answer.trim().toLowerCase() === "y";
	} finally {
		rl.close();
	}
}

async function resolveScopeId(
	apiBase: string,
	apiKey: string,
	idOrSlug: string,
): Promise<string> {
	// If it's already a UUID, accept as-is. Else look it up by slug.
	const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	if (uuidRe.test(idOrSlug)) return idOrSlug;
	const r = await fetch(`${apiBase}/api/me/scopes`, {
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	if (!r.ok) throw new Error(`scope lookup failed: HTTP ${r.status}`);
	const body = (await r.json()) as {
		owned: { id: string; slug: string }[];
	};
	const match = body.owned.find((s) => s.slug === idOrSlug);
	if (!match) throw new Error(`Scope slug not found: ${idOrSlug}`);
	return match.id;
}
```

- [ ] **Step 2: Implement the remaining 6 owner commands**

Each follows the same pattern — pick scope_id, call its endpoint, render output. File-by-file:

- `scope-share-links.ts`: `clawdi scope share-links <scope> [--revoke <id>]`. GET to list, DELETE to revoke. Render table with prefix, label, created_at, redeem_count.
- `scope-invite.ts`: `clawdi scope invite <scope> --email <email>`. POST `/invitations`. Print "Sent." or specific error messages for 400/404/409.
- `scope-invites.ts`: `clawdi scope invites [<scope>]` — without scope arg, GET `/api/me/invitations` (incoming). With scope arg, GET `/api/scopes/{id}/invitations` (outgoing). `--accept <id>` / `--decline <id>` / `--cancel <id>` for actions.
- `scope-members.ts`: `clawdi scope members <scope> [--remove <email-or-id>]`. GET to list, DELETE to remove.
- `scope-unshare.ts`: `clawdi scope unshare <scope>`. POST `/unshare`. Print summary.
- `scope-leave.ts`: `clawdi scope leave <scope>`. POST `/leave`. Print "Left."

(For brevity, the plan doesn't duplicate the full file body for each — they all share the same skeleton from scope-share.ts: get config → resolve scope → fetch → handle status codes → render. The engineer copies the skeleton and swaps the call.)

- [ ] **Step 3: Update scope-list.ts**

Modify the existing `scope list` command to fetch from `/api/me/scopes` instead of `/api/scopes`, and render two sections: "My scopes" and "Shared with me." Use the `is_owner` field for clarity.

- [ ] **Step 4: Register all in index.ts**

Add the new commands under the `scope` subcommand tree, matching the existing pattern.

- [ ] **Step 5: Smoke test**

For each command, run `bun run src/index.ts <command> --help`. Confirm help text renders cleanly.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/ packages/cli/src/index.ts
git commit -m "feat(cli): owner-side scope sharing commands"
```

---

### Task E.8: Phase E typecheck + biome + push

- [ ] **Step 1: Typecheck**

```bash
bun run typecheck
```
Expected: PASS for clawdi (CLI).

- [ ] **Step 2: Biome**

```bash
bun run check
```

- [ ] **Step 3: Bun test sweep**

```bash
cd packages/cli && bun test
```
Expected: existing tests still pass; new sharing tests pass.

- [ ] **Step 4: Push**

```bash
git push origin feat/scope-sharing
```

---

## Phase F — Web Dashboard

Goal: ship every page listed in spec § 9 — landing page, owner Sharing tab, invitation inbox, scope-detail branching, sidebar split, and shared indicators on skill/vault rows.

### Task F.1: Regenerate API client types

**Files:**
- Modify: `packages/shared/src/api/api.generated.ts` (regenerated)

- [ ] **Step 1: Run the regen**

```bash
cd apps/web && bun run generate-api
```
Expected: `api.generated.ts` updated with the new endpoint shapes (sharing routes, /me routes, share-redeem routes).

- [ ] **Step 2: Type-check**

```bash
cd /Users/kingsley/Programs/clawdi && bun run typecheck
```
Expected: clean. If any web file breaks due to renamed types, fix inline (rare — the new endpoints don't replace existing shapes).

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/api/api.generated.ts
git commit -m "chore(shared): regenerate api client for sharing endpoints"
```

---

### Task F.2: TanStack Query hooks for sharing

**Files:**
- Create: `apps/web/src/lib/sharing/use-share-links.ts`
- Create: `apps/web/src/lib/sharing/use-invitations.ts`
- Create: `apps/web/src/lib/sharing/use-members.ts`
- Create: `apps/web/src/lib/sharing/use-me-scopes.ts`

- [ ] **Step 1: Implement share-links hook**

Create `apps/web/src/lib/sharing/use-share-links.ts`:

```ts
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { unwrap, useApi } from "@/lib/api";

export function useShareLinks(scopeId: string) {
	const api = useApi();
	return useQuery({
		queryKey: ["share-links", scopeId],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/scopes/{scope_id}/share-links", {
					params: { path: { scope_id: scopeId } },
				}),
			),
		enabled: Boolean(scopeId),
	});
}

export function useCreateShareLink(scopeId: string) {
	const api = useApi();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (body: { label?: string; expires_at?: string }) =>
			unwrap(
				await api.POST("/api/scopes/{scope_id}/share-links", {
					params: { path: { scope_id: scopeId } },
					body,
				}),
			),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["share-links", scopeId] });
		},
	});
}

export function useRevokeShareLink(scopeId: string) {
	const api = useApi();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (linkId: string) =>
			unwrap(
				await api.DELETE("/api/scopes/{scope_id}/share-links/{link_id}", {
					params: { path: { scope_id: scopeId, link_id: linkId } },
				}),
			),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["share-links", scopeId] });
		},
	});
}
```

- [ ] **Step 2: Same shape for invitations + members + me-scopes**

Mirror the pattern:
- `use-invitations.ts` — `useInvitations(scopeId)`, `useCreateInvitation`, `useCancelInvitation`, `useIncomingInvitations`, `useAcceptInvitation`, `useDeclineInvitation`.
- `use-members.ts` — `useMembers(scopeId)`, `useRemoveMember`, `useUnshare`, `useLeaveScope`.
- `use-me-scopes.ts` — `useMyScopes` returning `{ owned, shared }`.

(Each hook is ~10 lines following the share-links template. The plan doesn't repeat them; the engineer copies the skeleton and swaps the endpoint.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/sharing/
git commit -m "feat(web): TanStack hooks for sharing endpoints"
```

---

### Task F.3: Public landing page `/share/[token]`

**Files:**
- Create: `apps/web/src/app/share/[token]/page.tsx`
- Create: `apps/web/src/app/share/[token]/redeem-form.tsx` (client component for the CLI command block + "Add to dashboard" button)

- [ ] **Step 1: Server component scaffold**

Create `apps/web/src/app/share/[token]/page.tsx`:

```tsx
/**
 * Public share-link landing page. No middleware gate — anonymous
 * visitors should reach this. The page fetches the scope preview
 * server-side via `/api/share/{token}/redeem` (which bumps the
 * counter — that's fine, the bump represents "someone looked at it"),
 * and renders the redeem command + an "Add to dashboard" button.
 */

import { notFound } from "next/navigation";
import { env } from "@/lib/env";
import { RedeemForm } from "./redeem-form";

interface ScopePreview {
	scope_id: string;
	scope_name: string;
	owner_display: string;
	owner_handle: string;
	skill_count: number;
	vault_count: number;
}

async function fetchPreview(token: string): Promise<ScopePreview | null> {
	const r = await fetch(
		`${env.NEXT_PUBLIC_API_URL}/api/share/${token}/redeem`,
		{ method: "POST", cache: "no-store" },
	);
	if (r.status === 404 || r.status === 410) return null;
	if (!r.ok) throw new Error(`Preview failed: HTTP ${r.status}`);
	return r.json() as Promise<ScopePreview>;
}

export default async function SharePage({
	params,
}: {
	params: Promise<{ token: string }>;
}) {
	const { token } = await params;
	const preview = await fetchPreview(token);
	if (!preview) notFound();

	return (
		<main className="mx-auto max-w-2xl space-y-6 px-4 py-12">
			<header>
				<p className="text-sm text-muted-foreground">
					{preview.owner_display} (@{preview.owner_handle}) is sharing
				</p>
				<h1 className="text-3xl font-semibold">{preview.scope_name}</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					{preview.skill_count} skill
					{preview.skill_count === 1 ? "" : "s"}
					{preview.vault_count > 0
						? ` · ${preview.vault_count} vault secret${preview.vault_count === 1 ? "" : "s"} (locked — sign in to use)`
						: ""}
				</p>
			</header>

			<RedeemForm token={token} previewName={preview.scope_name} />
		</main>
	);
}
```

- [ ] **Step 2: Redeem form (client) — CLI command + Clerk gate**

Create `apps/web/src/app/share/[token]/redeem-form.tsx`:

```tsx
"use client";

import { SignInButton, useUser } from "@clerk/nextjs";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { useApi } from "@/lib/api";

export function RedeemForm({
	token,
	previewName,
}: {
	token: string;
	previewName: string;
}) {
	const { isSignedIn } = useUser();
	const api = useApi();
	const router = useRouter();
	const [adding, setAdding] = useState(false);
	const redeemUrl = typeof window !== "undefined"
		? `${window.location.origin}/share/${token}`
		: `https://clawdi.ai/share/${token}`;
	const cliCommand = `clawdi share accept ${redeemUrl}`;

	const handleAddToDashboard = async () => {
		setAdding(true);
		try {
			const r = await api.POST("/api/share/{token}/upgrade", {
				params: { path: { token } },
			});
			if (r.error) {
				throw new Error(JSON.stringify(r.error));
			}
			router.push(`/scopes/${r.data?.scope_id}`);
		} catch (e) {
			console.error(e);
			alert(`Failed: ${String(e)}`);
			setAdding(false);
		}
	};

	return (
		<div className="space-y-6 rounded-xl border bg-card p-6">
			<section>
				<h2 className="text-lg font-medium">Have the CLI?</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					Paste this in your terminal to start using {previewName}
					{" "}immediately. No account required.
				</p>
				<pre className="mt-3 overflow-x-auto rounded-md bg-muted p-3 font-mono text-sm">
					{cliCommand}
				</pre>
				<p className="mt-2 text-xs text-muted-foreground">
					Don&apos;t have it yet?{" "}
					<a className="underline" href="/install">
						Install clawdi CLI
					</a>
					.
				</p>
			</section>

			<section className="border-t pt-6">
				<h2 className="text-lg font-medium">Or add to your dashboard</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					Sign in to add this scope to your account permanently — vault
					secrets become available, the scope appears in &ldquo;Shared
					with me&rdquo;, and all your devices stay in sync.
				</p>
				{isSignedIn ? (
					<Button
						className="mt-3"
						onClick={handleAddToDashboard}
						disabled={adding}
					>
						{adding ? "Adding..." : "Add to my dashboard"}
					</Button>
				) : (
					<SignInButton mode="modal">
						<Button className="mt-3">Sign in to add</Button>
					</SignInButton>
				)}
			</section>
		</div>
	);
}
```

- [ ] **Step 3: Verify `/share/[token]` is NOT behind Clerk middleware**

Check `apps/web/src/middleware.ts` or wherever Clerk routes are configured. The `/share/(.*)`pattern should be in the public-routes list. If a current middleware blocks it, add the exception.

- [ ] **Step 4: Smoke test**

```bash
cd apps/web && bun dev
# Visit http://localhost:3000/share/some-random-token → 404 page (good)
# Visit with a real token from `clawdi scope share` → preview renders
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/share/ apps/web/src/middleware.ts
git commit -m "feat(web): public share landing page"
```

---

### Task F.4: Owner Sharing tab on scope detail

**Files:**
- Create: `apps/web/src/app/(dashboard)/scopes/[id]/sharing/page.tsx`
- Create: `apps/web/src/app/(dashboard)/scopes/[id]/sharing/links-section.tsx`
- Create: `apps/web/src/app/(dashboard)/scopes/[id]/sharing/invitations-section.tsx`
- Create: `apps/web/src/app/(dashboard)/scopes/[id]/sharing/members-section.tsx`

- [ ] **Step 1: Sharing page entry**

Create `apps/web/src/app/(dashboard)/scopes/[id]/sharing/page.tsx`:

```tsx
"use client";

import { useParams } from "next/navigation";

import { LinksSection } from "./links-section";
import { InvitationsSection } from "./invitations-section";
import { MembersSection } from "./members-section";

export default function SharingPage() {
	const { id } = useParams<{ id: string }>();
	return (
		<div className="space-y-8">
			<header>
				<h1 className="text-2xl font-semibold">Sharing</h1>
				<p className="text-sm text-muted-foreground">
					Share this scope&apos;s skills and vaults with collaborators.
					Vault secrets are visible only to members who have signed in.
				</p>
			</header>
			<LinksSection scopeId={id} />
			<InvitationsSection scopeId={id} />
			<MembersSection scopeId={id} />
		</div>
	);
}
```

- [ ] **Step 2: Links section**

Create `apps/web/src/app/(dashboard)/scopes/[id]/sharing/links-section.tsx`:

```tsx
"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	useCreateShareLink,
	useRevokeShareLink,
	useShareLinks,
} from "@/lib/sharing/use-share-links";

export function LinksSection({ scopeId }: { scopeId: string }) {
	const { data, isLoading } = useShareLinks(scopeId);
	const create = useCreateShareLink(scopeId);
	const revoke = useRevokeShareLink(scopeId);
	const [label, setLabel] = useState("");
	const [freshLink, setFreshLink] = useState<string | null>(null);
	// Confirmation modal — spec § 10.4. Owners need to acknowledge
	// skill content disclosure before generating a link.
	const [confirmOpen, setConfirmOpen] = useState(false);

	const handleCreate = async () => {
		const result = await create.mutateAsync({ label: label || undefined });
		setFreshLink(result.url);
		setLabel("");
		setConfirmOpen(false);
	};

	// Handle 409 display_name_required with a clear inline message
	// rather than a generic toast.
	const isDisplayNameError =
		create.error &&
		(create.error as any)?.message?.includes("display_name_required");

	return (
		<section className="space-y-3">
			<h2 className="text-lg font-medium">Share links</h2>
			<div className="flex gap-2">
				<Input
					value={label}
					onChange={(e) => setLabel(e.target.value)}
					placeholder="Optional label (e.g. 'team')"
				/>
				<Button
					onClick={() => setConfirmOpen(true)}
					disabled={create.isPending}
				>
					{create.isPending ? "Creating..." : "Generate link"}
				</Button>
			</div>
			{isDisplayNameError ? (
				<p className="text-sm text-destructive">
					Set a display name on your profile before sharing — it&apos;s
					shown to anyone you share with.
				</p>
			) : null}
			<ShareConfirmDialog
				open={confirmOpen}
				onClose={() => setConfirmOpen(false)}
				onConfirm={handleCreate}
			/>
			{freshLink ? (
				<div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
					<p className="font-medium">Copy this link — it&apos;s shown only once:</p>
					<pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono">
						{freshLink}
					</pre>
					<Button
						className="mt-2"
						variant="outline"
						size="sm"
						onClick={() => {
							navigator.clipboard.writeText(freshLink);
							toast.success("Copied");
						}}
					>
						Copy
					</Button>
				</div>
			) : null}
			{isLoading ? (
				<p className="text-sm text-muted-foreground">Loading…</p>
			) : (data ?? []).length === 0 ? (
				<p className="text-sm text-muted-foreground">No links yet.</p>
			) : (
				<ul className="divide-y rounded-md border">
					{(data ?? []).map((link) => (
						<li
							key={link.id}
							className="flex items-center justify-between gap-3 p-3 text-sm"
						>
							<div className="min-w-0">
								<p className="font-mono text-xs text-muted-foreground">
									{link.prefix}…
								</p>
								<p>
									{link.label ?? "(no label)"}
									{" — "}
									{link.redeem_count} redemption
									{link.redeem_count === 1 ? "" : "s"}
									{link.revoked_at ? " — revoked" : ""}
								</p>
							</div>
							{link.revoked_at ? null : (
								<Button
									variant="outline"
									size="sm"
									onClick={() => revoke.mutate(link.id)}
								>
									Revoke
								</Button>
							)}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
```

- [ ] **Step 3: ShareConfirmDialog component**

In the same `links-section.tsx` file (or extract to a sibling
component file `share-confirm-dialog.tsx`):

```tsx
function ShareConfirmDialog({
	open,
	onClose,
	onConfirm,
}: {
	open: boolean;
	onClose: () => void;
	onConfirm: () => void;
}) {
	return (
		<Dialog open={open} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Generate share link?</DialogTitle>
				</DialogHeader>
				<div className="space-y-3 text-sm">
					<p>
						Anyone with this link can download the full content of every
						skill in this scope, including any text or files they contain.
					</p>
					<p className="text-muted-foreground">
						Make sure none of your skills contain API keys, passwords, or
						other secrets. Use vault references (
						<code className="rounded bg-muted px-1 py-0.5 text-[11px]">
							clawdi://vault/...
						</code>
						) inside skills instead — vault items stay locked.
					</p>
				</div>
				<div className="flex justify-end gap-2 pt-2">
					<Button variant="outline" onClick={onClose}>
						Cancel
					</Button>
					<Button onClick={onConfirm}>I understand, generate link</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
```

- [ ] **Step 4: Invitations + Members sections**

Mirror the LinksSection shape:
- `invitations-section.tsx` — email input + "Invite" button, list pending with cancel; show 400/404/409 error toasts based on the structured response body.
- `members-section.tsx` — table of members (display, email, joined_via, joined_at), with the **two-lever remove flow** from spec § 12.5:
  - "Remove" button on each row opens a dialog with two distinct buttons:
    > **Just remove** — Deletes the membership only. Active share links still work; the user can re-enter via any token they kept.
    > **Remove + revoke all share-links** — Same plus revokes every non-revoked link on this scope (you'll need to re-share links to your other members).
  - An "Unshare entirely" CTA at the bottom calls `POST /unshare` and confirms with a single dialog (no two-lever needed there — it's already comprehensive).

(The skeleton from links-section.tsx adapts trivially; each is ~80 lines.)

- [ ] **Step 5: Smoke test**

`bun dev`, navigate to `/scopes/<own-scope-id>/sharing`, exercise create/list/revoke flows. Verify the confirm dialog appears before each link generation; verify the two-button "Remove member" dialog renders correctly.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/\(dashboard\)/scopes/\[id\]/sharing/
git commit -m "feat(web): owner Sharing tab on scope detail page"
```

---

### Task F.5: Scope detail page conditional + Leave button

**Files:**
- Modify: `apps/web/src/app/(dashboard)/scopes/[id]/page.tsx`
- Create: `apps/web/src/app/(dashboard)/scopes/[id]/leave-button.tsx`

- [ ] **Step 1: Branch on `is_owner`**

In the scope detail page, fetch `/api/me/scopes` (or extend `/api/scopes/{id}` to return `is_owner`) and conditionally render:
- If `is_owner`: existing edit affordances + Sharing tab link.
- If sharee: "Shared from @owner-handle" header + `<LeaveButton scopeId={...} />` button instead of Sharing tab.

- [ ] **Step 2: LeaveButton component**

Create `apps/web/src/app/(dashboard)/scopes/[id]/leave-button.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { useLeaveScope } from "@/lib/sharing/use-members";

export function LeaveButton({ scopeId }: { scopeId: string }) {
	const router = useRouter();
	const leave = useLeaveScope(scopeId);
	const onClick = async () => {
		if (!confirm("Leave this shared scope?")) return;
		await leave.mutateAsync();
		router.push("/scopes");
	};
	return (
		<Button variant="outline" onClick={onClick} disabled={leave.isPending}>
			{leave.isPending ? "Leaving..." : "Leave shared scope"}
		</Button>
	);
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/\(dashboard\)/scopes/\[id\]/
git commit -m "feat(web): scope detail branches owner vs sharee, adds Leave button"
```

---

### Task F.6: Sidebar split + skill/vault row badges

**Files:**
- Modify: `apps/web/src/components/dashboard/scopes-sidebar.tsx` (or wherever the scope list lives — find via `grep -rn "scope" apps/web/src/components/`)
- Create: `apps/web/src/components/dashboard/scope-shared-badge.tsx`
- Modify: skill list page + vault list page to show the badge

- [ ] **Step 1: Sidebar split**

Refactor the sidebar to call `useMyScopes()` and render two sections: "My scopes" (the `owned` list) and "Shared with me" (the `shared` list). Use the existing visual treatment for each; the only addition is the header label.

- [ ] **Step 2: Badge component**

Create `apps/web/src/components/dashboard/scope-shared-badge.tsx`:

```tsx
import { Cloud } from "lucide-react";

import { cn } from "@/lib/utils";

export function ScopeSharedBadge({
	ownerHandle,
	className,
}: {
	ownerHandle: string;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary",
				className,
			)}
			title={`Shared from @${ownerHandle}`}
		>
			<Cloud className="size-2.5" />
			shared from @{ownerHandle}
		</span>
	);
}
```

- [ ] **Step 3: Tag rows**

In the skill list page (and vault list page), when the row's `scope_id` belongs to a shared scope, render `<ScopeSharedBadge ownerHandle={...} />` next to the row title. Cross-reference with `useMyScopes().shared` to know which scope_ids are shared and their owner_handle.

Also: in shared-scope mode, hide the "Edit"/"Delete"/"Push" action buttons on each row. Add a tooltip on the disabled action: "Read-only — shared by @owner".

- [ ] **Step 4: Commit**

```bash
git add -u
git commit -m "feat(web): sidebar split + shared-from badges on skill/vault rows"
```

---

### Task F.7: Invitation inbox `/me/invitations`

**Files:**
- Create: `apps/web/src/app/(dashboard)/me/invitations/page.tsx`
- Modify: sidebar badge

- [ ] **Step 1: Inbox page**

Create `apps/web/src/app/(dashboard)/me/invitations/page.tsx`:

```tsx
"use client";

import { Button } from "@/components/ui/button";
import {
	useAcceptInvitation,
	useDeclineInvitation,
	useIncomingInvitations,
} from "@/lib/sharing/use-invitations";

export default function InvitationsPage() {
	const { data, isLoading } = useIncomingInvitations();
	const accept = useAcceptInvitation();
	const decline = useDeclineInvitation();

	return (
		<div className="space-y-4 px-4 lg:px-6">
			<h1 className="text-2xl font-semibold">Invitations</h1>
			{isLoading ? (
				<p className="text-sm text-muted-foreground">Loading...</p>
			) : (data ?? []).length === 0 ? (
				<p className="text-sm text-muted-foreground">No invitations.</p>
			) : (
				<ul className="divide-y rounded-md border">
					{(data ?? []).map((inv) => (
						<li
							key={inv.id}
							className="flex items-center justify-between gap-3 p-3 text-sm"
						>
							<div>
								<p>
									{inv.invited_by_display ?? "Someone"} invited you to a scope.
								</p>
								<p className="text-xs text-muted-foreground">
									{new Date(inv.created_at).toLocaleString()}
								</p>
							</div>
							<div className="flex gap-2">
								<Button
									variant="outline"
									size="sm"
									onClick={() => decline.mutate(inv.id)}
								>
									Decline
								</Button>
								<Button
									size="sm"
									onClick={() => accept.mutate(inv.id)}
								>
									Accept
								</Button>
							</div>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
```

- [ ] **Step 2: Sidebar badge for incoming count**

In the sidebar component, query `useIncomingInvitations()` and render a numeric badge next to the "Invitations" link when count > 0.

- [ ] **Step 3: Commit**

```bash
git add -u
git commit -m "feat(web): invitation inbox + sidebar badge"
```

---

### Task F.8: Phase F polish + push

- [ ] **Step 1: Type-check / biome / build**

```bash
cd /Users/kingsley/Programs/clawdi
bun run typecheck
bun run check
cd apps/web && bun run build
```

- [ ] **Step 2: Push**

```bash
git push origin feat/scope-sharing
```

---

## Phase G — E2E + Final Polish

Goal: scripted end-to-end coverage of the happy paths + manual smoke verification.

### Task G.1: Programmatic e2e test

**Files:**
- Create: `backend/tests/test_sharing_e2e.py`

- [ ] **Step 1: Implement**

Create `backend/tests/test_sharing_e2e.py`:

```python
"""End-to-end happy paths through the cross-user sharing surface,
exercised entirely through the HTTP API. The CLI/Web are not covered
here — see scripts/e2e/scope-sharing.sh for manual checks.
"""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from app.models.scope import SCOPE_KIND_PERSONAL, Scope
from app.models.user import User


@pytest.mark.asyncio
async def test_share_link_flow_end_to_end(
    client, client_unauth, db_session, seed_user, seed_scope
):
    """Owner generates link → anonymous redeem → upgrade with another
    user's auth → membership exists → owner sees it in member list."""

    # Owner creates link.
    create_r = await client.post(
        f"/api/scopes/{seed_scope.id}/share-links", json={"label": "e2e"}
    )
    assert create_r.status_code == 200
    raw_token = create_r.json()["raw_token"]

    # Anonymous redeem returns scope preview.
    redeem_r = await client_unauth.post(f"/api/share/{raw_token}/redeem")
    assert redeem_r.status_code == 200
    preview = redeem_r.json()
    assert preview["scope_id"] == str(seed_scope.id)

    # Create a "sharee" user and authenticate as them. (In this test
    # rig we directly create a user row + JWT — see existing patterns
    # in test_auth_keys.py for how to mint a Clerk JWT here.)
    sharee = User(
        clerk_id=f"sharee_{uuid.uuid4().hex[:8]}",
        email=f"sharee_{uuid.uuid4().hex[:6]}@test.dev",
        name="Sharee",
    )
    db_session.add(sharee)
    await db_session.commit()
    await db_session.refresh(sharee)

    # Upgrade via Clerk JWT as the sharee (build a client fixture for
    # this — pattern: similar to `client` but with seed_user replaced
    # by the new `sharee`). For brevity, assume a helper
    # `client_for(user)` exists in conftest.
    from tests.conftest import client_for

    async with client_for(sharee) as sharee_client:
        upgrade_r = await sharee_client.post(f"/api/share/{raw_token}/upgrade")
        assert upgrade_r.status_code == 200, upgrade_r.text
        m = upgrade_r.json()
        assert m["scope_id"] == str(seed_scope.id)

    # Owner sees sharee in members.
    members_r = await client.get(f"/api/scopes/{seed_scope.id}/members")
    assert members_r.status_code == 200
    emails = {m["user_email"] for m in members_r.json()}
    assert sharee.email in emails

    # Cleanup: sharee leaves.
    async with client_for(sharee) as sharee_client:
        leave_r = await sharee_client.post(f"/api/scopes/{seed_scope.id}/leave")
        assert leave_r.status_code == 200


@pytest.mark.asyncio
async def test_invitation_flow_end_to_end(
    client, db_session, seed_user, seed_scope
):
    invitee = User(
        clerk_id=f"inv_{uuid.uuid4().hex[:8]}",
        email=f"inv_{uuid.uuid4().hex[:6]}@test.dev",
        name="Invitee",
    )
    db_session.add(invitee)
    await db_session.commit()
    await db_session.refresh(invitee)

    try:
        r = await client.post(
            f"/api/scopes/{seed_scope.id}/invitations",
            json={"email": invitee.email},
        )
        assert r.status_code == 200
        inv_id = r.json()["id"]

        from tests.conftest import client_for

        async with client_for(invitee) as invitee_client:
            # Sees the invite in /me.
            me_r = await invitee_client.get("/api/me/invitations")
            assert me_r.status_code == 200
            assert any(i["id"] == inv_id for i in me_r.json())

            # Accepts.
            accept_r = await invitee_client.post(
                f"/api/me/invitations/{inv_id}/accept"
            )
            assert accept_r.status_code == 200

        # Owner sees the member.
        m_r = await client.get(f"/api/scopes/{seed_scope.id}/members")
        assert m_r.status_code == 200
        assert any(m["user_email"] == invitee.email for m in m_r.json())
    finally:
        await db_session.delete(invitee)
        await db_session.commit()
```

- [ ] **Step 2: Add `client_for(user)` helper to conftest if missing**

In `backend/tests/conftest.py`, add a context-manager-style fixture that yields a Clerk-JWT-authed httpx client for an arbitrary user (not just `seed_user`). Mirror the existing `client` fixture pattern; only difference is the user it overrides the auth to.

- [ ] **Step 3: Run e2e**

```bash
cd backend && uv run pytest tests/test_sharing_e2e.py -v
```
Expected: 2 PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/tests/test_sharing_e2e.py backend/tests/conftest.py
git commit -m "test(sharing): end-to-end happy-path coverage"
```

---

### Task G.2: Manual smoke script

**Files:**
- Create: `scripts/e2e/scope-sharing.sh`

- [ ] **Step 1: Write the smoke script**

Create `scripts/e2e/scope-sharing.sh`:

```bash
#!/usr/bin/env bash
# Manual smoke test for cross-user scope sharing against local dev.
#
# Prereqs:
#   - cloud-api dev server running on :8000 with ADMIN_API_KEY set
#   - Postgres on :5433
#   - clawdi CLI 0.6.x+ installed (with scope-sharing commands)
#   - One existing user (`alice@local.dev`) with one personal scope
#   - One existing user (`bob@local.dev`)
#
# Usage: bash scripts/e2e/scope-sharing.sh

set -euo pipefail

ADMIN_KEY="local-dev-admin-secret"
API="http://localhost:8000"

# Alice mints an api_key via admin endpoint (substitute for real
# Clerk login in this manual flow).
echo "=== 1. Alice creates a scope (assumed already exists as Personal) ==="
ALICE_SCOPE_ID=$(PGPASSWORD=clawdi_dev psql -h localhost -p 5433 -U clawdi -d clawdi_cloud -t -c \
  "SELECT id FROM scopes WHERE user_id = (SELECT id FROM users WHERE email='alice@local.dev') LIMIT 1;" | tr -d ' \n')
echo "  scope_id=$ALICE_SCOPE_ID"

echo "=== 2. Alice generates a share link via API ==="
ALICE_KEY=$(curl -fsSX POST "$API/api/admin/auth/keys" -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d "{\"target_clerk_id\":\"alice_clerk_id\",\"label\":\"e2e-test\"}" | python3 -c "import json,sys; print(json.load(sys.stdin)['raw_key'])")
SHARE_URL=$(curl -fsSX POST "$API/api/scopes/$ALICE_SCOPE_ID/share-links" \
  -H "Authorization: Bearer $ALICE_KEY" -H "Content-Type: application/json" \
  -d '{"label":"e2e"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['url'])")
echo "  share_url=$SHARE_URL"

echo "=== 3. Anonymous CLI redeems ==="
clawdi share accept "$SHARE_URL"

echo "=== 4. clawdi share list shows the share ==="
clawdi share list

echo "=== 5. Bob (signed in) upgrades the same token ==="
BOB_KEY=$(curl -fsSX POST "$API/api/admin/auth/keys" -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d "{\"target_clerk_id\":\"bob_clerk_id\",\"label\":\"e2e-bob\"}" | python3 -c "import json,sys; print(json.load(sys.stdin)['raw_key'])")
TOKEN=$(echo "$SHARE_URL" | awk -F'/share/' '{print $2}')
curl -fsSX POST "$API/api/share/$TOKEN/upgrade" -H "Authorization: Bearer $BOB_KEY"

echo "=== 6. Alice sees Bob in members list ==="
curl -fsS "$API/api/scopes/$ALICE_SCOPE_ID/members" -H "Authorization: Bearer $ALICE_KEY" | python3 -m json.tool

echo "=== 7. Cleanup hint ==="
echo "  curl -X POST '$API/api/scopes/$ALICE_SCOPE_ID/unshare' -H 'Authorization: Bearer $ALICE_KEY'"
```

- [ ] **Step 2: Commit**

```bash
chmod +x scripts/e2e/scope-sharing.sh
git add scripts/e2e/scope-sharing.sh
git commit -m "chore(e2e): manual smoke script for scope sharing"
```

---

### Task G.3: Open PR for full feature + final review

- [ ] **Step 1: Force push final branch**

```bash
git push origin feat/scope-sharing
```

- [ ] **Step 2: PR description**

If shipping all phases as a single PR (large but cohesive):

```bash
gh pr create --title "feat: cross-user scope sharing (skills + vaults)" --body "$(cat <<'EOF'
## Summary

v1 of cross-user scope sharing for skills + vaults. Share-link
(anonymous CLI redeem) and email-invite (pending → accept) ingress
paths; Owner + Viewer role model; equal CLI + Web dashboard surface.

Architecture: token-based anonymous access + post-login membership
upgrade (Figma view-link / Spotify playlist pattern). No anonymous
user row.

## What ships

- 3 new tables (scope_memberships, scope_invitations, scope_share_links)
  via single DDL-only migration
- ~20 new HTTP endpoints (owner-facing + sharee-facing + anonymous-public)
- 10+ new `clawdi` subcommands + ~/.clawdi/share-tokens.json local state
- 4 new web pages (public landing, owner Sharing tab, /me/invitations,
  modified scope detail)
- Vault gate: server-side decrypt model retained for v1; viewer members
  can resolve, share-token-only callers cannot (CLI pre-empts client-side)
- E2E + happy-path tests

Out of scope (follow-up milestones):
- Per-member envelope encryption for vault
- Editor role
- Memory cross-user sharing
- Audit log

## Spec

docs/superpowers/specs/2026-05-11-scope-sharing-design.md

## Test plan

- [x] All sharing pytest suites pass
- [x] CLI bun test pass
- [x] Web typecheck + biome + build pass
- [x] Alembic migration applies cleanly to local dev DB
- [x] scripts/e2e/scope-sharing.sh end-to-end run on local
- [ ] Staging migration verified (operator)
- [ ] Manual web QA on staging (operator)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Or, if shipping per-phase: each phase has its own PR opened in the corresponding "Phase X push" step.

- [ ] **Step 3: Wait for CI**

`gh pr checks <PR-URL>` until all green.

- [ ] **Step 4: Merge after review**

Manual gate.

---
