from __future__ import annotations

import uuid

import pytest
from sqlalchemy.exc import IntegrityError

from app.models.user import (
    PRINCIPAL_KIND_CLERK,
    PRINCIPAL_KIND_PARTNER_TENANT,
    User,
)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "identity",
    [
        {
            "clerk_id": None,
            "principal_kind": PRINCIPAL_KIND_CLERK,
            "partner_tenant_ref": None,
        },
        {
            "clerk_id": "user_invalid_partner",
            "principal_kind": PRINCIPAL_KIND_PARTNER_TENANT,
            "partner_tenant_ref": "phala_cloud:team_invalid_partner",
        },
        {
            "clerk_id": None,
            "principal_kind": PRINCIPAL_KIND_PARTNER_TENANT,
            "partner_tenant_ref": None,
        },
        {
            "clerk_id": "user_invalid_double",
            "principal_kind": PRINCIPAL_KIND_CLERK,
            "partner_tenant_ref": "phala_cloud:team_invalid_double",
        },
        {
            "clerk_id": "user_invalid_kind",
            "principal_kind": "unknown",
            "partner_tenant_ref": None,
        },
    ],
)
async def test_database_rejects_invalid_principal_identity_combinations(
    db_session,
    identity,
):
    user = User(
        id=uuid.uuid4(),
        email=None,
        name=None,
        **identity,
    )
    db_session.add(user)

    with pytest.raises(IntegrityError):
        await db_session.flush()
    await db_session.rollback()
