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
    index_names = {i.name for i in ScopeInvitation.__table__.indexes}
    assert "ix_scope_invitations_invited_by" in index_names


def test_scope_share_link_model_importable():
    from app.models.scope_share_link import ScopeShareLink

    assert ScopeShareLink.__tablename__ == "scope_share_links"
    cols = {c.name for c in ScopeShareLink.__table__.columns}
    assert {
        "id",
        "scope_id",
        "token_hash",
        "token_prefix",
        "label",
        "created_by",
        "resolved_owner_handle",
        "created_at",
        "expires_at",
        "revoked_at",
        "redeem_count",
        "last_redeemed_at",
    } <= cols
    index_names = {i.name for i in ScopeShareLink.__table__.indexes}
    assert "ix_scope_share_links_created_by" in index_names
