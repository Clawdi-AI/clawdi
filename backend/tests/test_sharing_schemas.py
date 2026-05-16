"""Schema sanity checks for project-sharing models."""

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


def test_upgrade_body_validates_bind_as_and_agent_ids():
    from app.schemas.sharing import UpgradeBody

    parsed = UpgradeBody.model_validate({"agent_ids": ["a", "b"], "bind_as": "context"})
    assert parsed.bind_as == "context"
    assert parsed.agent_ids == ["a", "b"]

    with pytest.raises(ValidationError):
        UpgradeBody.model_validate({"bind_as": "invalid"})

    with pytest.raises(ValidationError):
        UpgradeBody.model_validate({"bind_as": "primary"})
