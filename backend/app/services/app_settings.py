"""Global-only typed application setting resolution and persistence."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.app_setting import AppSetting
from app.services.app_setting_registry import (
    AppSettingSpec,
    AppSettingValueError,
    canonical_app_setting_json,
    get_app_setting_spec,
    validate_app_setting_value,
)


class AppSettingUnavailable(RuntimeError):
    """A required registered setting is missing or malformed."""


async def resolve_app_setting[T](session: AsyncSession, spec: AppSettingSpec[T]) -> T:
    value = (
        await session.execute(select(AppSetting.value_json).where(AppSetting.key == spec.key))
    ).scalar_one_or_none()
    if value is None:
        raise AppSettingUnavailable(f"missing app setting: {spec.key}")
    try:
        return validate_app_setting_value(spec, value)
    except AppSettingValueError as error:
        raise AppSettingUnavailable(f"invalid app setting: {spec.key}") from error


async def stage_app_setting_upsert(
    session: AsyncSession,
    *,
    key: str,
    value: object,
) -> tuple[AppSetting, object | None, bool]:
    """Validate and stage one whole-value replacement without committing."""

    spec = get_app_setting_spec(key)
    canonical = canonical_app_setting_json(spec, value)
    setting = (
        await session.execute(select(AppSetting).where(AppSetting.key == key).with_for_update())
    ).scalar_one_or_none()
    created = setting is None
    previous: object | None = None
    if setting is None:
        setting = AppSetting(key=key, value_json=canonical)
        session.add(setting)
    else:
        previous = setting.value_json
        setting.value_json = canonical
    await session.flush()
    return setting, previous, created
