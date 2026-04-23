from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.models.user import UserSetting
from app.schemas.settings import SettingsResponse, SettingsUpdate, SettingsUpdateResponse

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("")
async def get_settings(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> SettingsResponse:
    result = await db.execute(select(UserSetting).where(UserSetting.user_id == auth.user_id))
    setting = result.scalar_one_or_none()

    data = setting.settings if setting else {}
    # Mask sensitive values
    safe = {**data}
    for key in ("mem0_api_key",):
        if key in safe and safe[key]:
            safe[key] = safe[key][:8] + "..."
    return SettingsResponse(safe)


@router.patch("")
async def update_settings(
    body: SettingsUpdate,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> SettingsUpdateResponse:
    result = await db.execute(select(UserSetting).where(UserSetting.user_id == auth.user_id))
    setting = result.scalar_one_or_none()

    if setting:
        merged = {**setting.settings, **body.settings}
        setting.settings = merged
    else:
        setting = UserSetting(user_id=auth.user_id, settings=body.settings)
        db.add(setting)

    await db.commit()
    return SettingsUpdateResponse(status="updated")
