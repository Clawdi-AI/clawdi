from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_user_auth
from app.core.database import get_session
from app.models.user import UserSetting
from app.schemas.settings import (
    SECRET_FIELDS,
    SettingsResponse,
    SettingsUpdate,
    SettingsUpdateResponse,
)
from app.services.vault_crypto import encrypt_field, is_encrypted_field

router = APIRouter(prefix="/api/settings", tags=["settings"])

# Mask shown to clients in place of actual secret values.
_SECRET_MASK = "••••••••"


def _encrypt_secrets(data: dict) -> dict:
    """Return a copy of *data* with secret fields encrypted.

    Always encrypts string secret values (including those that happen to start
    with the ``enc:`` prefix) — trusting a client-supplied prefix would let an
    attacker PATCH raw ciphertext that the server would store verbatim and
    then 500 on every subsequent decrypt.
    """
    out = dict(data)
    for key in SECRET_FIELDS:
        value = out.get(key)
        if isinstance(value, str) and value:
            out[key] = encrypt_field(value)
    return out


def _mask_secrets(data: dict) -> dict:
    """Return a copy of *data* safe to send to the client.

    Replaces secret values with a fixed mask string so the frontend can detect
    whether a key has been configured without ever receiving the actual value.
    """
    out = dict(data)
    for key in SECRET_FIELDS:
        value = out.get(key)
        if isinstance(value, str) and value:
            out[key] = _SECRET_MASK
    return out


@router.get("")
async def get_settings(
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> SettingsResponse:
    result = await db.execute(select(UserSetting).where(UserSetting.user_id == auth.user_id))
    setting = result.scalar_one_or_none()

    raw = setting.settings if setting else {}
    # Mask secrets — clients must never receive plaintext or encrypted blobs.
    safe = _mask_secrets(raw)
    return SettingsResponse(safe)


@router.patch("")
async def update_settings(
    body: SettingsUpdate,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> SettingsUpdateResponse:
    result = await db.execute(select(UserSetting).where(UserSetting.user_id == auth.user_id))
    setting = result.scalar_one_or_none()

    # Step 1: drop mask-echoed secrets from the client's patch — if the form
    # round-tripped the masked GET response, those fields must not overwrite
    # the real stored value. Must happen BEFORE encryption: otherwise the
    # mask gets encrypted and no longer compares equal to _SECRET_MASK.
    raw_patch = {
        k: v
        for k, v in body.settings.items()
        if not (k in SECRET_FIELDS and isinstance(v, str) and v == _SECRET_MASK)
    }

    # Step 2: encrypt any remaining secret fields the client actually wants to set.
    encrypted_patch = _encrypt_secrets(raw_patch)

    if setting:
        current = dict(setting.settings)
        current.update(encrypted_patch)
        # Step 3: transparent migration — if an existing row still holds a
        # legacy plaintext secret, encrypt it on the first PATCH that touches
        # the row. Guarded by is_encrypted_field so we never double-encrypt.
        for key in SECRET_FIELDS:
            stored = current.get(key)
            if isinstance(stored, str) and stored and not is_encrypted_field(stored):
                current[key] = encrypt_field(stored)
        setting.settings = current
    else:
        setting = UserSetting(user_id=auth.user_id, settings=encrypted_patch)
        db.add(setting)

    await db.commit()
    return SettingsUpdateResponse(status="updated")
