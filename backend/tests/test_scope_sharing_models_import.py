"""Smoke test: models import cleanly + register with metadata.

These tests don't need a DB session — they just verify the model files
parse, declare correct columns, and register with SQLAlchemy's metadata
so a later `Base.metadata.create_all` (or alembic autogenerate) sees them.
"""


def test_scope_membership_model_importable():
    from app.models.scope_membership import ScopeMembership

    assert ScopeMembership.__tablename__ == "scope_memberships"
    cols = {c.name for c in ScopeMembership.__table__.columns}
    assert {
        "id",
        "scope_id",
        "user_id",
        "role",
        "joined_via",
        "joined_at",
        "resolved_owner_handle",
    } <= cols


def test_scope_invitation_model_importable():
    from app.models.scope_invitation import ScopeInvitation

    assert ScopeInvitation.__tablename__ == "scope_invitations"
    cols = {c.name for c in ScopeInvitation.__table__.columns}
    assert {
        "id",
        "scope_id",
        "invitee_user_id",
        "invitee_email",
        "invited_by",
        "created_at",
    } <= cols
