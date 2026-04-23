from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.models.user import UserSetting
from app.schemas.settings import (
    SECRET_FIELDS,
    SettingsResponse,
    SettingsUpdate,
    SettingsUpdateResponse,
)
from app.services.vault_crypto import decrypt_field, encrypt_field, is_encrypted_field

router = APIRouter(prefix="/api/settings", tags=["settings"])

# Mask shown to clients in place of actual secret values.
_SECRET_MASK = "••••••••"


def _encrypt_secrets(data: dict) -> dict:
    """Return a copy of *data* with secret fields encrypted.

    Only string values are encrypted; non-strings (e.g. None, bool) are left
    as-is so existing schema validation keeps working.
    """
    out = dict(data)
    for key in SECRET_FIELDS:
        value = out.get(key)
        if isinstance(value, str) and value and not is_encrypted_field(value):
            out[key] = encrypt_field(value)
    return out


def _decrypt_secrets(data: dict) -> dict:
    """Return a copy of *data* with secret fields decrypted (for internal use).

    Handles both encrypted values (``enc:…``) and legacy plaintext transparently.
    """
    out = dict(data)
    for key in SECRET_FIELDS:
        value = out.get(key)
        if isinstance(value, str) and value:
            out[key] = decrypt_field(value)
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
    auth: AuthContext = Depends(get_auth),
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
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> SettingsUpdateResponse:
    result = await db.execute(select(UserSetting).where(UserSetting.user_id == auth.user_id))
    setting = result.scalar_one_or_none()

    # Encrypt secret fields in the incoming patch before persisting.
    encrypted_patch = _encrypt_secrets(body.settings)

    if setting:
        # Merge: incoming patch wins over stored values.
        # If the user sends the mask placeholder back (e.g. unchanged form field),
        # skip updating that key so the stored secret is preserved.
        current = dict(setting.settings)
        for k, v in encrypted_patch.items():
            if k in SECRET_FIELDS and v == _SECRET_MASK:
                # Client echoed the mask — do not overwrite the real stored value.
                continue
            current[k] = v
        setting.settings = current
    else:
        setting = UserSetting(user_id=auth.user_id, settings=encrypted_patch)
        db.add(setting)

    await db.commit()
    return SettingsUpdateResponse(status="updated")
