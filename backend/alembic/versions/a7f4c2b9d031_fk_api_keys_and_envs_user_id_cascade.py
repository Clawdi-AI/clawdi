"""fk api_keys + agent_environments user_id on delete cascade

Revision ID: a7f4c2b9d031
Revises: d2f9e1a0c4b3
Create Date: 2026-05-11 19:30:00.000000

Both `api_keys.user_id` and `agent_environments.user_id` were declared
as plain UUID columns with no foreign-key constraint. Deleting a user
left their api_keys and agent_envs as dangling references — no
runtime breakage (the columns aren't traversed during normal reads),
but the rows accumulate forever and any future audit / GC tooling has
to reason about orphans.

Admin-side endpoints (mint key, register env) added in PR #77 widen
the blast radius: SaaS batch tooling can now create many of these
rows for a user that the SaaS side might later delete. Locking the
relationship down with ON DELETE CASCADE makes the cleanup
deterministic — when the user disappears, every key and env they
owned disappears with them.

Pattern mirrors `6dee7134c53f_fk_sessions_environment_id…`: add the
constraint NOT VALID (immediately enforced for new writes / cascade
behaviour), clean up existing orphans, then VALIDATE to scan
existing rows.

Why DELETE for cleanup instead of UPDATE-to-NULL like the sessions
migration: both columns are NOT NULL. There's no canonical user to
re-bind an orphan key or env to anyway — the user that owned it is
gone, so the row no longer represents anything meaningful.

NOTE: this migration ONLY touches the two tables admin endpoints
write to. Several other user-owned tables (memories, skills, vault,
sessions, user_settings) also lack the user_id FK and have the same
orphan-on-user-delete problem. Closing those is out of this PR's
scope — track separately.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "a7f4c2b9d031"
down_revision: str | Sequence[str] | None = "d2f9e1a0c4b3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 1. Add both FKs in NOT VALID mode — immediately enforces new
    #    writes + makes ON DELETE CASCADE fire on parent deletes,
    #    without scanning existing rows yet.
    op.execute(
        """
        ALTER TABLE api_keys
        ADD CONSTRAINT api_keys_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE NOT VALID
        """
    )
    op.execute(
        """
        ALTER TABLE agent_environments
        ADD CONSTRAINT agent_environments_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE NOT VALID
        """
    )

    # 2. Delete existing orphans. NOT EXISTS instead of NOT IN to
    #    avoid the well-known NULL-in-subquery footgun (`x NOT IN
    #    (NULL, …)` is NULL, not TRUE, so rows would silently survive).
    op.execute(
        """
        DELETE FROM api_keys
        WHERE NOT EXISTS (
            SELECT 1 FROM users WHERE id = api_keys.user_id
        )
        """
    )
    op.execute(
        """
        DELETE FROM agent_environments
        WHERE NOT EXISTS (
            SELECT 1 FROM users WHERE id = agent_environments.user_id
        )
        """
    )

    # 3. Validate against existing rows (now no orphans). Takes only
    #    a SHARE UPDATE EXCLUSIVE lock — concurrent reads + writes
    #    keep working.
    op.execute("ALTER TABLE api_keys VALIDATE CONSTRAINT api_keys_user_id_fkey")
    op.execute("ALTER TABLE agent_environments VALIDATE CONSTRAINT agent_environments_user_id_fkey")


def downgrade() -> None:
    # We can't restore the orphan rows the upgrade deleted, but
    # dropping the constraints is reversible at the schema level.
    # Operators who downgrade keep the cleaned-up state.
    op.drop_constraint("agent_environments_user_id_fkey", "agent_environments", type_="foreignkey")
    op.drop_constraint("api_keys_user_id_fkey", "api_keys", type_="foreignkey")
