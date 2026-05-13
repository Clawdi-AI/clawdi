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


def test_mount_alias_validation_matches_database_shape():
    from app.schemas.sharing import MountCreate, UpgradeBody

    parsed = UpgradeBody.model_validate({"alias": "@alice/team-tools-2"})
    assert parsed.alias == "@alice/team-tools-2"

    parsed_mount = MountCreate.model_validate(
        {"source_scope_id": "source", "alias": "alice shared/tools"}
    )
    assert parsed_mount.alias == "alice shared/tools"

    with pytest.raises(ValidationError):
        UpgradeBody.model_validate({"alias": ""})
    with pytest.raises(ValidationError):
        MountCreate.model_validate({"source_scope_id": "source", "alias": "../bad\nalias"})
    with pytest.raises(ValidationError):
        UpgradeBody.model_validate({"alias": "x" * 81})
