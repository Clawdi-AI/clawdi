"""Smoke test: project-sharing models import cleanly + register with metadata."""


def test_project_membership_model_importable():
    from app.models.project_membership import ProjectMembership

    assert ProjectMembership.__tablename__ == "project_memberships"
    cols = {c.name for c in ProjectMembership.__table__.columns}
    assert {
        "id",
        "project_id",
        "member_user_id",
        "role",
        "joined_via",
        "joined_at",
        "resolved_owner_handle",
    } <= cols


def test_project_invitation_model_importable():
    from app.models.project_invitation import ProjectInvitation

    assert ProjectInvitation.__tablename__ == "project_invitations"
    cols = {c.name for c in ProjectInvitation.__table__.columns}
    assert {
        "id",
        "project_id",
        "invitee_user_id",
        "invitee_email",
        "invited_by",
        "resolved_owner_handle",
        "created_at",
    } <= cols
    index_names = {i.name for i in ProjectInvitation.__table__.indexes}
    assert "ix_project_invitations_invited_by" in index_names


def test_project_share_link_model_importable():
    from app.models.project_share_link import ProjectShareLink

    assert ProjectShareLink.__tablename__ == "project_share_links"
    cols = {c.name for c in ProjectShareLink.__table__.columns}
    assert {
        "id",
        "project_id",
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
    index_names = {i.name for i in ProjectShareLink.__table__.indexes}
    assert "ix_project_share_links_created_by" in index_names
